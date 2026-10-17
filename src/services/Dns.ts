import { Context, Effect, Layer, Schema } from "effect"

export type RecordType = "MX" | "TXT" | "CNAME"

const TYPE_CODES: Record<RecordType, number> = { MX: 15, TXT: 16, CNAME: 5 }

export interface DnsAnswer {
  readonly name: string
  readonly type: RecordType
  /** MX: "10 route1.mx.cloudflare.net." · TXT: the strings joined, quotes removed · CNAME: the target. */
  readonly data: string
}

export interface DnsResult {
  /** DNS RCODE: 0 NOERROR, 3 NXDOMAIN. */
  readonly status: number
  readonly answers: ReadonlyArray<DnsAnswer>
}

export class DnsError extends Schema.TaggedError<DnsError>()("DnsError", {
  name: Schema.String,
  type: Schema.String,
  message: Schema.String,
}) {}

/** RFC 8484 JSON answers carry TXT data as one or more quoted strings; join them back into one. */
export const unquoteTxt = (data: string) => {
  const parts = data.match(/"((?:[^"\\]|\\.)*)"/g)
  if (!parts) return data
  return parts.map((p) => p.slice(1, -1).replace(/\\(.)/g, "$1")).join("")
}

const DohResponse = Schema.Struct({
  Status: Schema.Number,
  Answer: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, type: Schema.Number, data: Schema.String })),
  ),
})

/**
 * DNS lookups for the record checks. DNS-over-HTTPS on Cloudflare (Workers can't speak UDP 53), a fixed
 * table in tests. The checker only reads, so a key-free public resolver is enough.
 */
export class Dns extends Context.Service<
  Dns,
  { resolve(name: string, type: RecordType): Effect.Effect<DnsResult, DnsError> }
>()("mailyard/Dns") {
  static readonly layerDoh = (endpoint = "https://cloudflare-dns.com/dns-query") =>
    Layer.succeed(
      Dns,
      Dns.of({
        resolve: (name, type) =>
          Effect.gen(function* () {
            const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`
            const body = yield* Effect.tryPromise({
              try: async () => {
                const response = await fetch(url, {
                  headers: { accept: "application/dns-json" },
                  signal: AbortSignal.timeout(5_000),
                })
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return (await response.json()) as unknown
              },
              catch: (cause) =>
                new DnsError({ name, type, message: cause instanceof Error ? cause.message : String(cause) }),
            })
            const decoded = yield* Schema.decodeUnknownEffect(DohResponse)(body).pipe(
              Effect.mapError(() => new DnsError({ name, type, message: "Unexpected DoH response" })),
            )
            const code = TYPE_CODES[type]
            return {
              status: decoded.Status,
              answers: (decoded.Answer ?? [])
                .filter((a) => a.type === code)
                .map((a) => ({
                  name: a.name.replace(/\.$/, "").toLowerCase(),
                  type,
                  data: type === "TXT" ? unquoteTxt(a.data) : a.data,
                })),
            }
          }),
      }),
    )

  /** Answers from a table keyed `"<TYPE> <name>"`; anything missing is NXDOMAIN. */
  static readonly layerFixture = (records: Readonly<Record<string, ReadonlyArray<string>>>) =>
    Layer.succeed(
      Dns,
      Dns.of({
        resolve: (name, type) =>
          Effect.sync(() => {
            const data = records[`${type} ${name.toLowerCase()}`]
            return data
              ? { status: 0, answers: data.map((d) => ({ name: name.toLowerCase(), type, data: d })) }
              : { status: 3, answers: [] }
          }),
      }),
    )
}
