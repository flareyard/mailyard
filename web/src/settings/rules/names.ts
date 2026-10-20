/** Names for the ids a rule holds (labels, webhooks, assignee keys), read from their own endpoints. */
import { useQuery } from "@tanstack/react-query"
import { labelsQuery, mailboxQuery, webhooksQuery } from "../queries.ts"

export type Names = {
  label: (id: string) => string
  webhook: (id: string) => string
  assignee: (id: string) => string
  labels: { id: string; name: string }[]
  webhooks: { id: string; name: string }[]
  assignees: { id: string; name: string }[]
}

export function useRuleNames(mailboxId: string): Names {
  const labels = useQuery({ ...labelsQuery(mailboxId), enabled: Boolean(mailboxId) })
  const hooks = useQuery(webhooksQuery)
  const box = useQuery({ ...mailboxQuery(mailboxId), enabled: Boolean(mailboxId) })
  const ls = (labels.data?.labels ?? []).map((l) => ({ id: l.id, name: l.name }))
  const ws = (hooks.data?.webhooks ?? []).map((w) => ({
    id: w.id,
    name: w.description || w.url.replace(/^https?:\/\//, ""),
  }))
  const as = (box.data?.members ?? [])
    .filter((m) => !m.revoked)
    .map((m) => ({ id: m.apiKeyId, name: m.name }))
  const find = (list: { id: string; name: string }[], id: string) => list.find((x) => x.id === id)?.name ?? id
  return {
    label: (id) => find(ls, id),
    webhook: (id) => find(ws, id),
    assignee: (id) => find(as, id),
    labels: ls,
    webhooks: ws,
    assignees: as,
  }
}
