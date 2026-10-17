import type { Manifest } from "./Manifest.ts"
import { isKnownScope, MEASURED_AT } from "./scopes.ts"

/** Rules that span fields, which a per-field schema can't express. Each returns a readable problem. */
export const crossFieldProblems = (m: Manifest): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const all = [...m.scopes.required, ...m.scopes.optional].map((s) => s.scope)
  const duplicates = all.filter((s, i) => all.indexOf(s) !== i)
  for (const scope of new Set(duplicates)) problems.push(`Scope ${scope} is listed more than once.`)

  // A scope Cloudflare doesn't offer can't be granted, so the app could never be deployed through OAuth.
  for (const scope of new Set(all)) {
    if (!isKnownScope(scope))
      problems.push(
        `Scope ${scope} isn't a Cloudflare OAuth scope (measured list, ${MEASURED_AT}: docs/spikes/oauth-scopes.md).`,
      )
  }

  const secrets = m.secrets.map((s) => s.name)
  for (const name of new Set(secrets.filter((s, i) => secrets.indexOf(s) !== i))) {
    problems.push(`Secret ${name} is listed more than once.`)
  }

  // Mailyard's proposed v1.2 settings (see Manifest.ts).
  const settings = m.settings ?? []
  const names = settings.map((s) => s.name)
  for (const name of new Set(names.filter((s, i) => names.indexOf(s) !== i))) {
    problems.push(`Setting ${name} is listed more than once.`)
  }
  for (const s of settings) {
    if (s.when && !names.includes(s.when.setting))
      problems.push(`Setting ${s.name} depends on ${s.when.setting}, which isn't a setting.`)
    if (s.type === "integer" && (s.default < s.min || s.default > s.max || s.min > s.max))
      problems.push(`Setting ${s.name}: default ${s.default} isn't within ${s.min}–${s.max}.`)
    if (s.type === "enum" && !s.options.some((o) => o.value === s.default))
      problems.push(`Setting ${s.name}: default ${s.default} isn't one of its options.`)
  }
  if (m.status && !secrets.includes(m.status.auth.bearer))
    problems.push(`status.auth.bearer names ${m.status.auth.bearer}, which isn't a secret.`)

  if (m.domain.suggest && !m.domain.supported)
    problems.push("domain.suggest is set but domain.supported is false.")
  return problems
}
