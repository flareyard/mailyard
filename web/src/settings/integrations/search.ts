/**
 * The URL state of Settings → Integrations: which sheet is open, so every step is a link (and every designed
 * state is reachable in fixture mode, with the Settings layout's `?fx=`).
 */

export type IntegrationsSearch = {
  sheet?: "agent-new" | "connect"
  rotate?: string
  revoke?: string
}

const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length < 80 ? v : undefined)

export function validateIntegrations(s: Record<string, unknown>): IntegrationsSearch {
  const rotate = str(s.rotate)
  const revoke = str(s.revoke)
  return {
    ...(s.sheet === "agent-new" || s.sheet === "connect" ? { sheet: s.sheet } : {}),
    ...(rotate ? { rotate } : {}),
    ...(revoke ? { revoke } : {}),
  }
}
