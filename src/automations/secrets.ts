import type { Graph, GraphNode, NodeType } from "./graph.ts"

/**
 * Config fields that carry a secret (HAL-3412). A webhook URL is often a capability URL (a Slack
 * incoming webhook, a Zapier hook): whoever holds it can post. Reading a graph needs only `read`, so
 * for callers without `admin` these come back redacted; only admins can change a graph, and they see
 * the real values. A new step type with a secret in its config lists the field here.
 */
export const SECRET_FIELDS: { readonly [T in NodeType]?: ReadonlyArray<string> } = {
  webhook: ["url"],
}

/** What a redacted URL ends with. A value ending in it is never a real one. */
export const REDACTED = "•••"

/** Keeps the scheme and host, so people can still tell which service it is: `https://hooks.slack.com/•••`. */
export const redactValue = (value: string) => {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}/${REDACTED}`
  } catch {
    return REDACTED
  }
}

export const isRedacted = (value: unknown) => typeof value === "string" && value.endsWith(REDACTED)

const configOf = (node: GraphNode) => node.config as Readonly<Record<string, unknown>>

/** The graph with every secret field redacted, and whether any was. */
export const redactGraph = (graph: Graph): { readonly graph: Graph; readonly redacted: boolean } => {
  let redacted = false
  const nodes = graph.nodes.map((node) => {
    const fields = SECRET_FIELDS[node.type]
    if (!fields) return node
    const config = { ...configOf(node) }
    for (const field of fields) {
      const value = config[field]
      if (typeof value === "string" && value.length > 0) {
        config[field] = redactValue(value)
        redacted = true
      }
    }
    return { ...node, config } as GraphNode
  })
  return { graph: { ...graph, nodes }, redacted }
}

/**
 * Puts the stored values back where a saved graph still holds a redacted one, matched by node id, so
 * a graph read with redactions saves without losing them. A redacted value on a node the stored graph
 * doesn't have (or has without that field) can't be restored: its field is returned, to refuse.
 */
export const restoreSecrets = (
  next: Graph,
  stored: Graph,
): { readonly graph: Graph; readonly unrestorable: ReadonlyArray<{ nodeId: string; field: string }> } => {
  const before = new Map(stored.nodes.map((n) => [n.id, n]))
  const unrestorable: Array<{ nodeId: string; field: string }> = []
  const nodes = next.nodes.map((node) => {
    const fields = SECRET_FIELDS[node.type]
    if (!fields) return node
    const config = { ...configOf(node) }
    let changed = false
    for (const field of fields) {
      if (!isRedacted(config[field])) continue
      const old = before.get(node.id)
      const value = old && old.type === node.type ? configOf(old)[field] : undefined
      if (typeof value === "string" && !isRedacted(value)) {
        config[field] = value
        changed = true
      } else unrestorable.push({ nodeId: node.id, field })
    }
    return changed ? ({ ...node, config } as GraphNode) : node
  })
  return { graph: { ...next, nodes }, unrestorable }
}
