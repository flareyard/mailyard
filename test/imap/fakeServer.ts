import type { Transport } from "../../src/imap/client.ts"

/**
 * A scripted IMAP server: enough of RFC 3501 to exercise the client and the import, with folders of
 * raw messages. It answers commands as a real server would, including literals and the `+` continuation.
 */
export interface FakeFolder {
  readonly name: string
  readonly flags?: ReadonlyArray<string>
  readonly uidValidity?: number
  readonly messages: ReadonlyArray<{
    readonly uid: number
    readonly raw: string
    readonly flags?: ReadonlyArray<string>
    readonly date?: string
  }>
}

export interface FakeOptions {
  readonly username: string
  readonly password: string
  readonly folders: ReadonlyArray<FakeFolder>
  /** Break the connection after this many FETCH commands, to test checkpoints. */
  readonly dropAfterFetches?: number
  /** UIDs whose FETCH comes back without a body (a broken message on the server), to test retries. */
  readonly noBody?: ReadonlyArray<number>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export const fakeImap = (options: FakeOptions) => {
  const log: Array<string> = []
  let fetches = 0
  const transport = (): Transport => {
    const out: Array<Uint8Array> = [enc.encode("* OK [CAPABILITY IMAP4rev1 LITERAL+] Fake ready\r\n")]
    let waiting: ((chunk: Uint8Array | null) => void) | null = null
    let closed = false
    let input = ""
    let pendingLiteral: { readonly tag: string; readonly before: string; readonly size: number } | null = null
    let selected: FakeFolder | null = null
    let authed = false
    const push = (s: string | Uint8Array) => {
      const chunk = typeof s === "string" ? enc.encode(s) : s
      if (waiting) {
        const w = waiting
        waiting = null
        w(chunk)
      } else out.push(chunk)
    }
    const quoteOrLiteral = (s: string) =>
      /^[\x20-\x7e]*$/.test(s) && !s.includes('"') ? `"${s}"` : `{${enc.encode(s).length}}\r\n${s}`
    const args = (rest: string): Array<string> => {
      const found: Array<string> = []
      const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g
      for (const m of rest.matchAll(re))
        found.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : (m[2] ?? ""))
      return found
    }
    const handle = (line: string) => {
      const space = line.indexOf(" ")
      const tag = line.slice(0, space)
      const rest = line.slice(space + 1)
      const upper = rest.toUpperCase()
      log.push(rest.replace(/^LOGIN .*/i, "LOGIN ***"))
      if (upper.startsWith("LOGIN")) {
        const [, user, pass] = args(rest)
        if (user === options.username && pass === options.password) {
          authed = true
          push(`${tag} OK LOGIN completed\r\n`)
        } else push(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`)
        return
      }
      if (upper.startsWith("LOGOUT")) {
        push("* BYE Logging out\r\n")
        push(`${tag} OK LOGOUT completed\r\n`)
        return
      }
      if (!authed) {
        push(`${tag} NO Not authenticated\r\n`)
        return
      }
      if (upper.startsWith("LIST")) {
        for (const f of options.folders)
          push(`* LIST (${(f.flags ?? []).join(" ")}) "/" ${quoteOrLiteral(f.name)}\r\n`)
        push(`${tag} OK LIST completed\r\n`)
        return
      }
      if (upper.startsWith("EXAMINE") || upper.startsWith("SELECT")) {
        const [, name] = args(rest)
        selected = options.folders.find((f) => f.name === name) ?? null
        if (!selected) {
          push(`${tag} NO No such folder\r\n`)
          return
        }
        const uidNext = Math.max(0, ...selected.messages.map((m) => m.uid)) + 1
        push(`* ${selected.messages.length} EXISTS\r\n* 0 RECENT\r\n`)
        push(
          `* OK [UIDVALIDITY ${selected.uidValidity ?? 1}] UIDs valid\r\n* OK [UIDNEXT ${uidNext}] Predicted next UID\r\n`,
        )
        push(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`)
        return
      }
      if (upper.startsWith("UID SEARCH")) {
        const from = Number(/UID (\d+):\*/i.exec(rest)?.[1] ?? "1")
        const uids = (selected?.messages ?? []).map((m) => m.uid).filter((u) => u >= from)
        push(`* SEARCH${uids.map((u) => ` ${u}`).join("")}\r\n${tag} OK SEARCH completed\r\n`)
        return
      }
      if (upper.startsWith("UID FETCH")) {
        fetches++
        if (options.dropAfterFetches !== undefined && fetches > options.dropAfterFetches) {
          closed = true
          if (waiting) {
            const w = waiting
            waiting = null
            w(null)
          }
          return
        }
        const set = args(rest)[2]
        const wanted = new Set<number>()
        for (const part of (set ?? "").split(",")) {
          const [a, b] = part.split(":").map(Number)
          if (a === undefined) continue
          for (let u = a; u <= (b ?? a); u++) wanted.add(u)
        }
        const withBody = upper.includes("BODY.PEEK[]")
        ;(selected?.messages ?? []).forEach((m, i) => {
          if (!wanted.has(m.uid)) return
          const bytes = enc.encode(m.raw)
          const flags = `FLAGS (${(m.flags ?? []).join(" ")})`
          if (withBody && options.noBody?.includes(m.uid)) {
            push(`* ${i + 1} FETCH (UID ${m.uid} ${flags} RFC822.SIZE ${bytes.length})\r\n`)
          } else if (withBody) {
            push(
              `* ${i + 1} FETCH (UID ${m.uid} ${flags} INTERNALDATE "${m.date ?? "17-Oct-2026 09:00:00 +0000"}" RFC822.SIZE ${bytes.length} BODY[] {${bytes.length}}\r\n`,
            )
            push(bytes)
            push(")\r\n")
          } else push(`* ${i + 1} FETCH (UID ${m.uid} ${flags} RFC822.SIZE ${bytes.length})\r\n`)
        })
        push(`${tag} OK FETCH completed\r\n`)
        return
      }
      push(`${tag} BAD Unknown command\r\n`)
    }
    return {
      write: async (bytes) => {
        if (closed) throw new Error("closed")
        input += dec.decode(bytes)
        for (;;) {
          if (pendingLiteral) {
            if (enc.encode(input).length < pendingLiteral.size) return
            const literal = input.slice(0, pendingLiteral.size)
            input = input.slice(pendingLiteral.size)
            const before = `${pendingLiteral.before}"${literal.replace(/(["\\])/g, "\\$1")}"`
            pendingLiteral = null
            const nl = input.indexOf("\r\n")
            if (nl < 0) {
              input = before + input
              continue
            }
            handle(before + input.slice(0, nl))
            input = input.slice(nl + 2)
            continue
          }
          const nl = input.indexOf("\r\n")
          if (nl < 0) return
          const line = input.slice(0, nl)
          input = input.slice(nl + 2)
          const literal = /^(.*)\{(\d+)\}$/.exec(line)
          if (literal) {
            pendingLiteral = {
              tag: line.split(" ")[0] ?? "",
              before: literal[1] ?? "",
              size: Number(literal[2]),
            }
            push("+ Ready for literal\r\n")
            continue
          }
          handle(line)
        }
      },
      read: () =>
        new Promise<Uint8Array | null>((resolve) => {
          const next = out.shift()
          if (next) return resolve(next)
          if (closed) return resolve(null)
          waiting = resolve
        }),
      close: async () => {
        closed = true
      },
    }
  }
  return { transport, log }
}
