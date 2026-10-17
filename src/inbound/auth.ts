/**
 * The authentication verdicts on an inbound message, read from its Authentication-Results headers
 * (RFC 8601) as the receiving MTA wrote them. Email Routing has already rejected mail failing the
 * sender's DMARC policy and mail failing both SPF and DKIM, so what reaches us is the rest.
 */
export type AuthVerdict =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "temperror"
  | "permerror"
  | "policy"
  | "unknown"

export interface DkimResult {
  readonly result: AuthVerdict
  /** `header.d` (or `header.i` without its local part): the signing domain. */
  readonly domain: string | null
  readonly selector: string | null
}

export interface AuthResults {
  /** Which header the verdicts came from, so a reader can tell a direct result from a forwarded one. */
  readonly source: "authentication-results" | "arc-authentication-results" | "received-spf" | "none"
  readonly authservId: string | null
  readonly spf: AuthVerdict | null
  /** `smtp.mailfrom`, the domain SPF was checked against. */
  readonly spfDomain: string | null
  readonly dkim: ReadonlyArray<DkimResult>
  readonly dmarc: AuthVerdict | null
  /** `header.from`, the domain DMARC was evaluated for. */
  readonly dmarcDomain: string | null
  readonly arc: AuthVerdict | null
}

const VERDICTS = new Set<string>([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
  "policy",
])
const verdict = (raw: string | undefined): AuthVerdict => {
  const v = (raw ?? "").toLowerCase()
  if (VERDICTS.has(v)) return v as AuthVerdict
  // Older MTAs write "hardfail" for SPF.
  if (v === "hardfail") return "fail"
  return "unknown"
}

/** Removes RFC 5322 comments, `(like this)`, which may nest and hold anything. */
const stripComments = (value: string) => {
  let out = ""
  let depth = 0
  let quoted = false
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === "\\" && i + 1 < value.length) {
      if (depth === 0) out += c + value[i + 1]
      i++
      continue
    }
    if (c === '"' && depth === 0) quoted = !quoted
    if (!quoted && c === "(") {
      depth++
      continue
    }
    if (!quoted && c === ")" && depth > 0) {
      depth--
      continue
    }
    if (depth === 0) out += c
  }
  return out
}

/** Splits on `;` outside quotes. */
const splitStatements = (value: string) => {
  const parts: Array<string> = []
  let current = ""
  let quoted = false
  for (const c of value) {
    if (c === '"') quoted = !quoted
    if (c === ";" && !quoted) {
      parts.push(current)
      current = ""
    } else current += c
  }
  parts.push(current)
  return parts.map((p) => p.trim()).filter(Boolean)
}

interface MethodResult {
  readonly method: string
  readonly result: AuthVerdict
  readonly props: ReadonlyMap<string, string>
}

const parseStatement = (statement: string): MethodResult | null => {
  const tokens = statement.match(/[^\s=]+=(?:"[^"]*"|[^\s]+)|[^\s]+/g) ?? []
  const head = tokens[0]
  if (!head?.includes("=")) return null
  const [method, result] = head.split("=", 2)
  if (!method) return null
  const props = new Map<string, string>()
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf("=")
    if (eq <= 0) continue
    props.set(token.slice(0, eq).toLowerCase(), token.slice(eq + 1).replace(/^"|"$/g, ""))
  }
  return { method: method.toLowerCase().replace(/\/.*$/, ""), result: verdict(result), props }
}

/** Parses one Authentication-Results (or ARC-Authentication-Results) header value. */
export const parseAuthenticationResults = (value: string) => {
  const statements = splitStatements(stripComments(value))
  let first = statements[0] ?? ""
  // ARC-Authentication-Results starts with the instance tag: "i=1; mx.example.com; spf=pass ..."
  let instance: number | null = null
  const arcInstance = /^i\s*=\s*(\d+)$/i.exec(first)
  if (arcInstance) {
    instance = Number(arcInstance[1])
    statements.shift()
    first = statements[0] ?? ""
  }
  // The authserv-id may be followed by a version number: "mx.example.com 1".
  const authservId = first.includes("=") ? null : (first.split(/\s+/)[0] ?? null)
  const results = statements
    .slice(authservId === null ? 0 : 1)
    .map(parseStatement)
    .filter((r): r is MethodResult => r !== null)
  return { instance, authservId, results }
}

const domainOf = (identity: string | undefined) => {
  if (!identity) return null
  const at = identity.lastIndexOf("@")
  return (at >= 0 ? identity.slice(at + 1) : identity).toLowerCase() || null
}

const fromParsed = (
  source: AuthResults["source"],
  parsed: ReturnType<typeof parseAuthenticationResults>,
): AuthResults => {
  const find = (method: string) => parsed.results.find((r) => r.method === method)
  // A receiver may report SPF twice, once per identity: Cloudflare writes the HELO check
  // (`spf=none smtp.helo=…`) before the MAIL FROM check (`spf=pass smtp.mailfrom=…`), measured on
  // a Gmail message 2026-10-17. MAIL FROM is the identity DMARC aligns on, so it wins.
  const spfs = parsed.results.filter((r) => r.method === "spf")
  const spf = spfs.find((r) => r.props.has("smtp.mailfrom")) ?? spfs[0]
  const dmarc = find("dmarc")
  const arc = find("arc")
  return {
    source,
    authservId: parsed.authservId,
    spf: spf?.result ?? null,
    spfDomain: domainOf(spf?.props.get("smtp.mailfrom") ?? spf?.props.get("smtp.helo")),
    dkim: parsed.results
      .filter((r) => r.method === "dkim")
      .map((r) => ({
        result: r.result,
        domain: domainOf(r.props.get("header.d") ?? r.props.get("header.i")),
        selector: r.props.get("header.s") ?? null,
      })),
    dmarc: dmarc?.result ?? null,
    dmarcDomain: domainOf(dmarc?.props.get("header.from")),
    arc: arc?.result ?? null,
  }
}

export const NO_AUTH_RESULTS: AuthResults = {
  source: "none",
  authservId: null,
  spf: null,
  spfDomain: null,
  dkim: [],
  dmarc: null,
  dmarcDomain: null,
  arc: null,
}

/**
 * Picks the verdicts the receiving MTA wrote. Headers are prepended in transit, so the first
 * Authentication-Results is the newest hop's: ours. Without one, the highest ARC instance carries the
 * last trusted hop's results, and a bare Received-SPF gives at least the SPF verdict.
 */
export const readAuthResults = (headers: ReadonlyArray<{ readonly key: string; readonly value: string }>) => {
  const ar = headers.find((h) => h.key === "authentication-results")
  if (ar) return fromParsed("authentication-results", parseAuthenticationResults(ar.value))
  const arcs = headers
    .filter((h) => h.key === "arc-authentication-results")
    .map((h) => parseAuthenticationResults(h.value))
    .sort((a, b) => (b.instance ?? 0) - (a.instance ?? 0))
  if (arcs[0]) return fromParsed("arc-authentication-results", arcs[0])
  const receivedSpf = headers.find((h) => h.key === "received-spf")
  if (receivedSpf) {
    const value = stripComments(receivedSpf.value).trim()
    const mailfrom = /envelope-from=("?)([^";\s]+)\1/i.exec(value)?.[2]
    return {
      ...NO_AUTH_RESULTS,
      source: "received-spf" as const,
      spf: verdict(value.split(/\s+/)[0]),
      spfDomain: domainOf(mailfrom),
    }
  }
  return NO_AUTH_RESULTS
}
