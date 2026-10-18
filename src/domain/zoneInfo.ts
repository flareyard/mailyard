import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { CloudflareZones } from "../services/CloudflareZones.ts"
import { type RelayRefusal, withRelay } from "../services/cloudflareApi.ts"
import { Dns } from "../services/Dns.ts"
import { SENDING_SUBDOMAIN } from "./dnsChecks.ts"

/**
 * What a domain's zone says (HAL-3365), stored with each recheck so the domain screens read it without
 * calling out. `currentNameservers` comes from public DNS and needs no token; the rest needs
 * CLOUDFLARE_DNS_TOKEN and is null without it.
 */
export interface ZoneInfo {
  /** Cloudflare's zone status (`active`, `pending`, `moved`, …), or null when unknown. */
  readonly zoneStatus: string | null
  readonly zoneName: string | null
  /** The nameservers Cloudflare assigned the zone. */
  readonly nameservers: ReadonlyArray<string> | null
  /** What public DNS answers today; differs from `nameservers` while a move is pending. */
  readonly currentNameservers: ReadonlyArray<string>
  readonly registrar: string | null
  readonly dnssec: string | null
  /** Complaints Email Sending counted for this domain in the last 30 days. */
  readonly complaints30d: number | null
  /** The bounce (return-path) domain mail is sent with. */
  readonly returnPath: string | null
  readonly checkedAt: number
  /** Set when Flareyard's relay refused the zone lookup, which is why the zone fields are null (HAL-3558). */
  readonly relay?: RelayRefusal
}

const norm = (ns: string) => ns.replace(/\.$/, "").toLowerCase()

/** The nameservers public DNS gives for the domain or, failing that, its nearest parent. */
const publicNameservers = (name: string) =>
  Effect.gen(function* () {
    const dns = yield* Dns
    const labels = name.split(".")
    for (let i = 0; labels.length - i >= 2; i++) {
      const candidate = labels.slice(i).join(".")
      const result = yield* dns.resolve(candidate, "NS").pipe(Effect.option)
      const answers = Option.match(result, {
        onNone: () => [],
        onSome: (r) => r.answers.map((a) => norm(a.data)),
      })
      if (answers.length > 0) return { zoneName: candidate, nameservers: [...answers].sort() }
    }
    return { zoneName: null, nameservers: [] as Array<string> }
  })

export const readZoneInfo = Effect.fn("domains.zoneInfo")(function* (
  name: string,
  purposes: { readonly sending: boolean },
) {
  const zones = yield* CloudflareZones
  const current = yield* publicNameservers(name)
  const base = {
    zoneStatus: null,
    zoneName: current.zoneName,
    nameservers: null,
    currentNameservers: current.nameservers,
    registrar: null,
    dnssec: null,
    complaints30d: null,
    returnPath: purposes.sending ? `${SENDING_SUBDOMAIN}.${name}` : null,
    checkedAt: Date.now(),
  } satisfies ZoneInfo
  if (!zones.connected) return { info: base as ZoneInfo, zoneId: null as string | null }
  const found = yield* zones.findZone(name)
  const zone = found.value
  if (Option.isNone(zone))
    return { info: { ...base, ...withRelay(found.relay) } as ZoneInfo, zoneId: null as string | null }
  const z = zone.value
  const [dnssec, subdomain] = yield* Effect.all([zones.dnssec(z.id), zones.sendingSubdomain(z.id, name)], {
    concurrency: 2,
  })
  const complaints =
    purposes.sending && Option.isSome(subdomain)
      ? yield* zones.complaints(z.id, subdomain.value.id, 30)
      : Option.none<number>()
  return {
    zoneId: z.id as string | null,
    info: {
      ...base,
      zoneStatus: z.status,
      zoneName: z.name,
      nameservers: (z.name_servers ?? []).map(norm).sort(),
      registrar: z.original_registrar ?? null,
      dnssec: Option.getOrNull(dnssec),
      complaints30d: Option.getOrNull(complaints),
      returnPath: Option.isSome(subdomain)
        ? (subdomain.value.return_path_domain ?? base.returnPath)
        : base.returnPath,
    } as ZoneInfo,
  }
})
