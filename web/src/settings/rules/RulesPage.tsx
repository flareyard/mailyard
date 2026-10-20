/**
 * Settings → Rules (design: rules, rules-empty, rule-editor, rule-apply, -progress, -done; HANDOFF-ops §16).
 * Rules run top to bottom on each new message. Reorder by dragging the grip or Alt ↑/↓ on it, saved with
 * PUT …/rules/order; the switch turns a rule on or off. The mailbox, the open editor and the apply panel are
 * all in the URL.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { type DragEvent, type KeyboardEvent, useEffect, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtAgo, fmtInt, num } from "../../lib/format.ts"
import { BuiltPill, Empty } from "../../ops/kit.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { type Action, type Condition, move, moveTo } from "../logic.ts"
import { mailboxesQuery, type Rule, rulesQuery } from "../queries.ts"
import { SectionHead } from "../ui.tsx"
import { useRuleNames } from "./names.ts"
import { RuleApply } from "./RuleApply.tsx"
import { RuleEditor } from "./RuleEditor.tsx"
import { ActionTok, ConditionTok } from "./Tokens.tsx"

const route = getRouteApi("/_app/settings/rules")

export function RulesPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const boxes = useQuery(mailboxesQuery)
  const holders = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const fallback = holders.find((m) => m.address.startsWith("support@"))?.id ?? holders[0]?.id ?? ""
  const mailboxId = search.mailbox ?? fallback
  const box = holders.find((m) => m.id === mailboxId)
  const q = useQuery({ ...rulesQuery(mailboxId), enabled: Boolean(mailboxId) })
  const rules = q.data?.rules ?? []
  const editing = search.rule === "new" ? "new" : rules.find((r) => r.id === search.rule)
  const applying = rules.find((r) => r.id === search.apply)
  const go = (s: { rule?: string; apply?: string }) =>
    navigate({
      search: (p) => ({ ...(p.fx ? { fx: p.fx } : {}), ...(p.mailbox ? { mailbox: p.mailbox } : {}), ...s }),
    })
  const short = box ? `${box.address.split("@")[0]}@` : ""

  if (applying)
    return (
      <>
        <SectionHead
          title="Rules"
          sub="Ordered per mailbox. The first matching rule with Stop ends the run."
        />
        <RuleApply mailboxId={mailboxId} rule={applying as RuleT} onBack={() => go({ rule: applying.id })} />
      </>
    )

  const list = (
    <Panel
      id="rules"
      title={`Rules for ${short}`}
      endpoint={`GET /v1/mailboxes/${mailboxId}/rules · PUT …/rules/order · POST …/rules/{ruleId}/apply`}
      query={q}
      meta="Run top to bottom on each new message"
      isEmpty={(d) => d.rules.length === 0}
      empty={
        <Empty
          icon="filter"
          title="No rules yet"
          action={
            <button className="btn btn-secondary" type="button" onClick={() => go({ rule: "new" })}>
              <Icon name="plus" />
              Create a rule
            </button>
          }
        >
          Rules run on every new message in order: label, archive, forward, auto-reply or call a webhook when
          conditions match.
        </Empty>
      }
    >
      {(d) => (
        <RuleList
          mailboxId={mailboxId}
          rules={d.rules as RuleT[]}
          openId={typeof editing === "object" ? editing.id : null}
          onEdit={(id) => go({ rule: id })}
          onApply={(id) => go({ apply: id })}
        />
      )}
    </Panel>
  )

  return (
    <>
      <SectionHead
        title="Rules"
        sub="Ordered per mailbox. The first matching rule with Stop ends the run."
        actions={
          <>
            <label className="sr-only" htmlFor="rule-mbx">
              Mailbox
            </label>
            <select
              className="select"
              id="rule-mbx"
              style={{ width: "auto", maxWidth: "100%", height: 36 }}
              value={mailboxId}
              onChange={(e) =>
                navigate({ search: (p) => ({ ...(p.fx ? { fx: p.fx } : {}), mailbox: e.target.value }) })
              }
            >
              {holders.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.address}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => go({ rule: "new" })}
              disabled={!mailboxId}
              data-endpoint={`POST /v1/mailboxes/${mailboxId}/rules`}
            >
              <Icon name="plus" />
              New rule
            </button>
          </>
        }
      />
      {editing ? (
        <div className="split-even">
          <div className="stack">{list}</div>
          <div className="stack">
            <RuleEditor
              key={typeof editing === "object" ? editing.id : "new"}
              mailboxId={mailboxId}
              rule={editing === "new" ? null : (editing as RuleT)}
              onClose={() => go({})}
              onSaved={(id) => go({ rule: id })}
              onApply={(id) => go({ apply: id })}
            />
          </div>
        </div>
      ) : (
        list
      )}
      {!editing && q.isSuccess ? (
        <p className="t-small muted">
          <BuiltPill issue="HAL-3368" /> Matches and the last match update as mail arrives.
        </p>
      ) : null}
    </>
  )
}

/** The generated rule type with its unions narrowed to the shapes logic.ts works with. */
export type RuleT = Omit<Rule, "conditions" | "actions"> & { conditions: Condition[]; actions: Action[] }

export function RuleList({
  mailboxId,
  rules,
  openId,
  onEdit,
  onApply,
}: {
  mailboxId: string
  rules: RuleT[]
  openId: string | null
  onEdit: (id: string) => void
  onApply: (id: string) => void
}) {
  const qc = useQueryClient()
  const names = useRuleNames(mailboxId)
  const [order, setOrder] = useState(rules)
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [announce, setAnnounce] = useState("")
  useEffect(() => setOrder(rules), [rules])

  const saveOrder = useMutation({
    mutationFn: (ids: string[]) =>
      unwrap(
        api.PUT("/v1/mailboxes/{id}/rules/order", {
          params: { path: { id: mailboxId } },
          body: { ruleIds: ids },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey }),
    onError: (e) => {
      setOrder(rules)
      toast({ title: "Order not saved", sub: e instanceof Error ? e.message : undefined, tone: "bad" })
    },
  })
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      unwrap(
        api.PATCH("/v1/mailboxes/{id}/rules/{ruleId}", {
          params: { path: { id: mailboxId, ruleId: id } },
          body: { enabled },
        }),
      ),
    onMutate: ({ id, enabled }) => setOrder((o) => o.map((r) => (r.id === id ? { ...r, enabled } : r))),
    onSuccess: (_, v) => {
      qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey })
      toast({ title: v.enabled ? "Rule on" : "Rule off" })
    },
    onError: (e) => {
      setOrder(rules)
      toast({ title: "Not changed", sub: e instanceof Error ? e.message : undefined, tone: "bad" })
    },
  })

  const commit = (next: RuleT[], moved: RuleT) => {
    setOrder(next)
    const pos = next.findIndex((r) => r.id === moved.id) + 1
    setAnnounce(`${moved.name} moved to position ${pos} of ${next.length}.`)
    saveOrder.mutate(next.map((r) => r.id))
  }
  const onGripKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
    e.preventDefault()
    const next = move(order, i, e.key === "ArrowUp" ? -1 : 1)
    const r = order[i]
    if (!r || next[i]?.id === r.id) return
    commit(next, r)
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-grip="${r.id}"]`)?.focus())
  }
  const onDrop = (i: number) => (e: DragEvent) => {
    e.preventDefault()
    if (drag === null || drag === i) return
    const r = order[drag]
    if (r) commit(moveTo(order, drag, i), r)
    setDrag(null)
    setOver(null)
  }

  return (
    <>
      <ol className="rules" data-od-id="rule-list">
        {order.map((r, i) => (
          <li
            key={r.id}
            className={`rule${r.enabled ? "" : " is-off"}${openId === r.id ? " is-open" : ""}${drag === i ? " st-rule-drag" : ""}${over === i && drag !== i ? " st-rule-over" : ""}`}
            data-od-id={`rule-${r.id}`}
            onDragOver={(e) => {
              if (drag === null) return
              e.preventDefault()
              setOver(i)
            }}
            onDrop={onDrop(i)}
          >
            <button
              className="grip"
              type="button"
              draggable
              data-grip={r.id}
              aria-label={`Move ${r.name}; use Alt and the arrow keys`}
              data-tip="Drag, or Alt ↑ ↓"
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              onKeyDown={onGripKey(i)}
              onDragStart={(e) => {
                setDrag(i)
                e.dataTransfer.effectAllowed = "move"
                e.dataTransfer.setData("text/plain", r.id)
              }}
              onDragEnd={() => {
                setDrag(null)
                setOver(null)
              }}
            >
              <Icon name="grip" />
            </button>
            <span className="rule-pos">{i + 1}</span>
            <div className="rule-main">
              <span className="rule-name">
                {r.name}
                {r.enabled ? null : (
                  <>
                    {" "}
                    <span className="pill pill-neutral">Off</span>
                  </>
                )}
              </span>
              <div className="rule-line">
                <span>When</span>
                {r.conditions.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id and keep their order
                  <span key={j} style={{ display: "contents" }}>
                    {j ? <span className="t-small">{r.match === "any" ? "or" : "and"}</span> : null}
                    <ConditionTok c={c} />
                  </span>
                ))}
              </div>
              <div className="rule-line">
                <span>Then</span>
                {r.actions.map((a, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: actions have no id and keep their order
                  <ActionTok key={j} a={a} names={names} />
                ))}
                {r.stop ? (
                  <span className="stop-note">
                    <Icon name="octagon" />
                    Stops here
                  </span>
                ) : null}
              </div>
            </div>
            <div className="rule-stats">
              <label className="switch">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  aria-label={`${r.name} on`}
                  onChange={(e) => toggle.mutate({ id: r.id, enabled: e.target.checked })}
                />
              </label>
              <span>
                <b>{fmtInt(r.matchCount)}</b> match{num(r.matchCount) === 1 ? "" : "es"}
              </span>
              <span>
                {r.lastMatchedAt
                  ? `last ${fmtAgo(r.lastMatchedAt as number).replace(/^in /, "")}`
                  : "never matched"}
              </span>
              <span className="cluster cluster-4">
                <button className="btn btn-ghost btn-sm" type="button" onClick={() => onApply(r.id)}>
                  Apply to existing
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  type="button"
                  onClick={() => onEdit(r.id)}
                  aria-label={`Edit ${r.name}`}
                >
                  Edit
                </button>
              </span>
            </div>
          </li>
        ))}
      </ol>
      <span className="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </>
  )
}
