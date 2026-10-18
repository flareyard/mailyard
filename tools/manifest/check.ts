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

  // v1.2 settings: one name each, no clash with secrets, `when` pointing back at an enum or boolean.
  const settings = m.settings ?? []
  const settingNames = settings.map((x) => x.name)
  for (const name of new Set(settingNames.filter((s, i) => settingNames.indexOf(s) !== i))) {
    problems.push(`Setting ${name} is listed more than once.`)
  }
  for (const name of settingNames.filter((n) => secrets.includes(n))) {
    problems.push(`${name} is both a setting and a secret; a Worker binding can only be one.`)
  }
  settings.forEach((setting, index) => {
    if (
      setting.type === "integer" &&
      (setting.default < setting.min || setting.default > setting.max || setting.min > setting.max)
    ) {
      problems.push(
        `Setting ${setting.name}: default ${setting.default} isn't within ${setting.min}–${setting.max}.`,
      )
    }
    if (setting.type === "enum" && !setting.options.some((o) => o.value === setting.default)) {
      problems.push(`Setting ${setting.name}: default ${setting.default} isn't one of its options.`)
    }
    if (!setting.when) return
    const target = settings.slice(0, index).find((x) => x.name === setting.when?.setting)
    if (!target) {
      problems.push(
        `Setting ${setting.name}: when.setting ${setting.when.setting} must be a setting listed before it.`,
      )
    } else if (target.type !== "enum" && target.type !== "boolean") {
      problems.push(`Setting ${setting.name}: when.setting ${target.name} must be an enum or a boolean.`)
    } else if (target.type === "enum" && !target.options.some((o) => o.value === setting.when?.equals)) {
      problems.push(`Setting ${setting.name}: ${setting.when.equals} isn't an option of ${target.name}.`)
    } else if (
      target.type === "boolean" &&
      setting.when.equals !== "true" &&
      setting.when.equals !== "false"
    ) {
      problems.push(`Setting ${setting.name}: when.equals for a boolean is "true" or "false".`)
    }
  })

  // The status route is read with a value the platform generated, so it can hold it sealed.
  if (m.status) {
    const bearer = m.secrets.find((x) => x.name === m.status?.auth.bearer)
    if (!bearer) problems.push(`status.auth.bearer ${m.status.auth.bearer} isn't a declared secret.`)
    else if (!("generate" in bearer) || bearer.generate === "keypair-ed25519") {
      problems.push(
        `status.auth.bearer ${bearer.name} must be a generated random secret, so the platform holds its value.`,
      )
    }
  }

  // v1.3: each relayed route runs under a scope the app asks for; the names are bindings of their own.
  if (m.cloudflareApi) {
    const api = m.cloudflareApi
    const names = [api.url, api.token, ...(api.accountId ? [api.accountId] : [])]
    for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
      problems.push(`cloudflareApi names ${name} more than once.`)
    }
    for (const name of new Set(names)) {
      if (secrets.includes(name)) problems.push(`cloudflareApi's ${name} clashes with a secret of that name.`)
      if (settingNames.includes(name))
        problems.push(`cloudflareApi's ${name} clashes with a setting of that name.`)
    }
    const routes = api.routes.map((r) => `${r.method} ${r.path}`)
    for (const route of new Set(routes.filter((r, i) => routes.indexOf(r) !== i))) {
      problems.push(`cloudflareApi route ${route} is listed more than once.`)
    }
    for (const r of api.routes) {
      if (!all.includes(r.scope))
        problems.push(
          `cloudflareApi route ${r.method} ${r.path} needs ${r.scope}, which scopes.required or scopes.optional must list.`,
        )
    }
  }

  if (m.domain.suggest && !m.domain.supported)
    problems.push("domain.suggest is set but domain.supported is false.")
  return problems
}
