import type { Manifest } from "./Manifest.ts"

/** Rules that span fields, which a per-field schema can't express. Each returns a readable problem. */
export const crossFieldProblems = (m: Manifest): ReadonlyArray<string> => {
  const problems: Array<string> = []
  const all = [...m.scopes.required, ...m.scopes.optional].map((s) => s.scope)
  const duplicates = all.filter((s, i) => all.indexOf(s) !== i)
  for (const scope of new Set(duplicates)) problems.push(`Scope ${scope} is listed more than once.`)

  const secrets = m.secrets.map((s) => s.name)
  for (const name of new Set(secrets.filter((s, i) => secrets.indexOf(s) !== i))) {
    problems.push(`Secret ${name} is listed more than once.`)
  }

  if (m.domain.suggest && !m.domain.supported)
    problems.push("domain.suggest is set but domain.supported is false.")
  return problems
}
