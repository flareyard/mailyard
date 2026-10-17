/**
 * Answers DNS-over-HTTPS queries to cloudflare-dns.com from a table, so tests exercise the real DoH
 * client (src/services/Dns.ts) without the network. Keys are `"<TYPE> <name>"`.
 */
const TYPES: Record<string, number> = { MX: 15, TXT: 16, CNAME: 5 }
const table = new Map<string, ReadonlyArray<string>>()
let installed = false

export const setDns = (records: Readonly<Record<string, ReadonlyArray<string>>>) => {
  for (const [key, value] of Object.entries(records)) table.set(key.toLowerCase(), value)
}

export const installDohFixture = () => {
  if (installed) return
  installed = true
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname !== "cloudflare-dns.com") return realFetch(input, init)
    const name = (url.searchParams.get("name") ?? "").toLowerCase()
    const type = url.searchParams.get("type") ?? ""
    const data = table.get(`${type} ${name}`.toLowerCase())
    return Response.json({
      Status: data ? 0 : 3,
      Answer: (data ?? []).map((d) => ({
        name: `${name}.`,
        type: TYPES[type],
        TTL: 300,
        data: type === "TXT" ? `"${d}"` : d,
      })),
    })
  }) as typeof fetch
}

/** A domain whose DNS is fully set up for receiving and sending through Cloudflare. */
export const goodDomain = (name: string) => ({
  [`MX ${name}`]: [
    "74 route1.mx.cloudflare.net.",
    "3 route2.mx.cloudflare.net.",
    "51 route3.mx.cloudflare.net.",
  ],
  [`TXT ${name}`]: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
  [`TXT cf2024-1._domainkey.${name}`]: ["v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBg"],
  [`TXT _dmarc.${name}`]: ["v=DMARC1; p=quarantine"],
  [`MX cf-bounce.${name}`]: [
    "10 route1.mx.cloudflare.net.",
    "20 route2.mx.cloudflare.net.",
    "30 route3.mx.cloudflare.net.",
  ],
  [`TXT cf-bounce.${name}`]: ["v=spf1 include:_spf.mx.cloudflare.net ~all"],
  [`TXT cf-bounce._domainkey.${name}`]: ["v=DKIM1; h=sha256; k=rsa; p=MIIBIjANBg"],
})
