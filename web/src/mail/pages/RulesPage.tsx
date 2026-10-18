/**
 * `/mail/$mailboxId/rules` (rules.html, rules-empty.html): the mailbox's rules in the order they run, with
 * on/off, reorder (drag, or Alt ↑ ↓ on the grip), match counts, Apply to existing mail, edit and delete; then
 * the allow and block lists. GET/PATCH/DELETE …/rules, PUT …/rules/order.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, useNavigate, useSearch } from "@tanstack/react-router"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { mailboxDetailQuery } from "../queries.ts"
import { toast } from "../toasts.tsx"
import { ApplySheet } from "./ApplySheet.tsx"
import { actionPart, conditionWords, matchWords, moveItem } from "./logic.ts"
import { RuleSheet, SkillHint } from "./RuleSheet.tsx"
import { SendersPanel } from "./SendersPanel.tsx"
import { LabelTag, MailPage, pageKeys } from "./shared.tsx"
import type { Rule, RuleList } from "./types.ts"

export function RulesPage() {
  const { mailboxId, local, access } = useMail()
  const search = useSearch({ from: "/_app/mail/$mailboxId/rules" })
  const navigate = useNavigate({ from: "/mail/$mailboxId/rules" })
  const qc = useQueryClient()
  const key = pageKeys.rules(mailboxId)
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/rules", { params: { path: { id: mailboxId } } }),
      ) as Promise<RuleList>,
  })
  const [editing, setEditing] = useState<Rule | null>(null)
  const setSearch = (patch: Record<string, unknown>) =>
    navigate({
      search: (p: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...p, ...patch }
        for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
        return next as never
      },
      replace: true,
    })

  const reorder = useMutation({
    mutationFn: (ruleIds: string[]) =>
      unwrap(
        api.PUT("/v1/mailboxes/{id}/rules/order", { params: { path: { id: mailboxId } }, body: { ruleIds } }),
      ) as Promise<RuleList>,
    onMutate: (ids) => {
      const before = qc.getQueryData<RuleList>(key)
      if (before)
        qc.setQueryData<RuleList>(key, {
          rules: ids.map((id, i) => ({ ...(before.rules.find((r) => r.id === id) as Rule), position: i })),
        })
      return { before }
    },
    onSuccess: (r) => qc.setQueryData(key, r),
    onError: (e, _ids, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before)
      toast({
        title: "The new order wasn’t saved",
        sub: e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.",
        tone: "error",
      })
    },
  })
  const patch = useMutation({
    mutationFn: ({ rule, enabled }: { rule: Rule; enabled: boolean }) =>
      unwrap(
        api.PATCH("/v1/mailboxes/{id}/rules/{ruleId}", {
          params: { path: { id: mailboxId, ruleId: rule.id } },
          body: { enabled },
        }),
      ) as Promise<Rule>,
    onMutate: ({ rule, enabled }) => {
      qc.setQueryData<RuleList>(key, (old) =>
        old ? { rules: old.rules.map((r) => (r.id === rule.id ? { ...r, enabled } : r)) } : old,
      )
    },
    onSuccess: (saved) =>
      qc.setQueryData<RuleList>(key, (old) =>
        old ? { rules: old.rules.map((r) => (r.id === saved.id ? saved : r)) } : old,
      ),
    onError: (e, { rule }) => {
      qc.setQueryData<RuleList>(key, (old) =>
        old ? { rules: old.rules.map((r) => (r.id === rule.id ? rule : r)) } : old,
      )
      toast({
        title: `“${rule.name}” didn’t change`,
        sub: e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.",
        tone: "error",
      })
    },
  })
  const remove = useMutation({
    mutationFn: (rule: Rule) =>
      unwrap(
        api.DELETE("/v1/mailboxes/{id}/rules/{ruleId}", {
          params: { path: { id: mailboxId, ruleId: rule.id } },
        }),
      ),
    onSuccess: (_r, rule) => {
      qc.setQueryData<RuleList>(key, (old) =>
        old ? { rules: old.rules.filter((r) => r.id !== rule.id) } : old,
      )
      toast({ title: `Deleted “${rule.name}”` })
    },
    onError: (e, rule) =>
      toast({
        title: `“${rule.name}” wasn’t deleted`,
        sub: e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.",
        tone: "error",
      }),
  })

  const rules = [...(q.data?.rules ?? [])].sort((a, b) => Number(a.position) - Number(b.position))
  const move = (from: number, to: number) => {
    if (!access.manage) return
    const next = moveItem(rules, from, to)
    if (next.map((r) => r.id).join() !== rules.map((r) => r.id).join()) reorder.mutate(next.map((r) => r.id))
  }
  const applying = search.apply ? rules.find((r) => r.id === search.apply) : undefined

  const newRule = (
    <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="right">
      <button className="btn btn-secondary btn-sm" type="button" onClick={() => setSearch({ new: 1 })}>
        New rule
      </button>
    </Gated>
  )

  return (
    <MailPage
      label="Rules and senders"
      crumb={<span>Rules and senders</span>}
      title="Rules and senders"
      sub={
        rules.length || q.isPending
          ? `What happens to mail as it arrives in ${local}, in order. Rules run before the spam check; senders decide who skips it or goes straight to Spam.`
          : `What happens to mail as it arrives in ${local}, in order.`
      }
    >
      {q.isError ? (
        <section className="panel">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="The rules didn’t load" />
          </div>
        </section>
      ) : q.isPending ? (
        <section className="panel" aria-busy="true">
          <header className="panel-head">
            <h2 className="panel-title">Rules, run in order</h2>
          </header>
          <ul className="list" style={{ padding: "4px 0 0" }}>
            {[0, 1, 2].map((i) => (
              <li key={i} className="rule" aria-hidden="true">
                <span />
                <span className="r-name">
                  <span className="sk sk-text" style={{ width: 180 }} />
                </span>
                <span className="r-when">
                  <span className="sk sk-text" style={{ width: "70%" }} />
                </span>
                <span className="r-then">
                  <span className="sk sk-text" style={{ width: "40%" }} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : rules.length === 0 ? (
        <section className="panel" data-endpoint="GET /v1/mailboxes/{id}/rules">
          <div className="empty">
            <span className="empty-icon">
              <Icon name="filter" />
            </span>
            <h3>No rules in {local} yet</h3>
            <p>Rules label, file, forward or answer mail as it arrives, in the order you set.</p>
            <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho}>
              <button className="btn btn-primary" type="button" onClick={() => setSearch({ new: 1 })}>
                Create a rule
              </button>
            </Gated>
          </div>
        </section>
      ) : (
        <section
          className="panel"
          data-endpoint="GET /v1/mailboxes/{id}/rules · PUT …/rules/order · PATCH …/rules/{ruleId}"
        >
          <header className="panel-head">
            <h2 className="panel-title">Rules, run in order</h2>
            <span className="cluster cluster-4">
              <span className="panel-meta">Counted as mail arrives</span>
              {newRule}
            </span>
          </header>
          <RuleRows
            rules={rules}
            onMove={move}
            onToggle={(rule, enabled) => patch.mutate({ rule, enabled })}
            onApply={(rule) => setSearch({ apply: rule.id })}
            onEdit={setEditing}
            onDelete={(rule) => remove.mutate(rule)}
          />
          <footer className="panel-foot">
            <span>
              A rule marked “stops here” ends the run for that message. New kinds of action come from the{" "}
              <span className="mono">add-inbox-rule-action</span> skill in your repo.
            </span>
          </footer>
        </section>
      )}
      {rules.length ? <SkillHint /> : null}
      <SendersPanel list={search.list ?? "allow"} onList={(l) => setSearch({ list: l })} />
      {applying ? <ApplySheet rule={applying} onClose={() => setSearch({ apply: undefined })} /> : null}
      {search.new === 1 ? <RuleSheet onClose={() => setSearch({ new: undefined })} /> : null}
      {editing ? <RuleSheet rule={editing} onClose={() => setEditing(null)} /> : null}
    </MailPage>
  )
}

export function RuleRows({
  rules,
  onMove,
  onToggle,
  onApply,
  onEdit,
  onDelete,
}: {
  rules: Rule[]
  onMove: (from: number, to: number) => void
  onToggle: (rule: Rule, enabled: boolean) => void
  onApply: (rule: Rule) => void
  onEdit: (rule: Rule) => void
  onDelete: (rule: Rule) => void
}) {
  const { mailboxId, labelById, access } = useMail()
  const detail = useQuery(mailboxDetailQuery(mailboxId))
  const [drag, setDrag] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const grips = useRef(new Map<string, HTMLButtonElement>())
  const [focusAfter, setFocusAfter] = useState<string | null>(null)
  useEffect(() => {
    if (focusAfter) {
      grips.current.get(focusAfter)?.focus()
      setFocusAfter(null)
    }
  }, [focusAfter])
  const keyName = (id: string) =>
    detail.data?.members?.find((m) => m.apiKeyId === id)?.name ??
    detail.data?.people?.find((p) => p.memberId === id)?.name ??
    id
  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>, i: number, id: string) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
    e.preventDefault()
    const to = e.key === "ArrowUp" ? i - 1 : i + 1
    if (to < 0 || to >= rules.length) return
    onMove(i, to)
    setFocusAfter(id)
  }
  return (
    <ul className="list" style={{ padding: "4px 0 0" }}>
      {rules.map((r, i) => {
        const m = matchWords(r.matchCount, r.lastMatchedAt)
        return (
          <li
            key={r.id}
            className={`rule${r.enabled ? "" : " is-off"}${drag === i ? " is-dragging" : ""}${over === i && drag !== null && drag !== i ? " is-drop-target" : ""}`}
            onDragOver={(e) => {
              if (drag === null) return
              e.preventDefault()
              setOver(i)
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (drag !== null) onMove(drag, i)
              setDrag(null)
              setOver(null)
            }}
          >
            <span className="stack stack-4" style={{ alignItems: "center" }}>
              <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho}>
                <button
                  ref={(el) => {
                    if (el) grips.current.set(r.id, el)
                    else grips.current.delete(r.id)
                  }}
                  className="grip"
                  type="button"
                  draggable={access.manage}
                  aria-label={`Reorder ${r.name}, position ${i + 1} of ${rules.length}`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  title="Drag, or Alt ↑ ↓"
                  onDragStart={(e) => {
                    setDrag(i)
                    e.dataTransfer.effectAllowed = "move"
                    e.dataTransfer.setData("text/plain", r.id)
                  }}
                  onDragEnd={() => {
                    setDrag(null)
                    setOver(null)
                  }}
                  onKeyDown={(e) => onGripKey(e, i, r.id)}
                >
                  <Icon name="grip" />
                </button>
              </Gated>
              <span className="r-pos">{i + 1}</span>
            </span>
            <span className="r-name">
              {r.name}
              {r.stop ? (
                <span className="pill pill-neutral" style={{ height: 20 }}>
                  Stops here
                </span>
              ) : null}
              {!r.enabled ? (
                <span className="pill" style={{ height: 20 }}>
                  Off
                </span>
              ) : null}
            </span>
            <span className="r-side">
              <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="right">
                <label className="switch" title={r.enabled ? "On" : "Off"}>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    aria-label={`Rule ${r.name} is ${r.enabled ? "on" : "off"}`}
                    onChange={(e) => onToggle(r, e.target.checked)}
                  />
                </label>
              </Gated>
              <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="right">
                <button className="btn btn-ghost btn-sm hide-phone" type="button" onClick={() => onApply(r)}>
                  Apply to existing mail
                </button>
              </Gated>
              <button
                className="icon-btn"
                type="button"
                aria-label={`More for ${r.name}`}
                title={`More for ${r.name}`}
                aria-haspopup="menu"
                aria-expanded={menu === r.id}
                onClick={() => setMenu(menu === r.id ? null : r.id)}
              >
                <Icon name="more" />
              </button>
              {menu === r.id ? (
                <RuleMenu
                  rule={r}
                  index={i}
                  count={rules.length}
                  canManage={access.manage}
                  onClose={() => setMenu(null)}
                  onMove={(to) => onMove(i, to)}
                  onApply={() => onApply(r)}
                  onEdit={() => onEdit(r)}
                  onDelete={() => onDelete(r)}
                />
              ) : null}
            </span>
            <span className="r-when">
              <span className="k">When</span>{" "}
              {r.conditions.map((c, j) => {
                const w = conditionWords(c)
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id
                  <span key={j}>
                    {j ? <b> {r.match === "all" ? "and" : "or"} </b> : null}
                    <span className="k">{w.k}</span>
                    {w.v !== undefined ? (
                      <>
                        {" "}
                        <span className="mono">{w.v}</span>
                      </>
                    ) : null}
                  </span>
                )
              })}
            </span>
            <span className="r-then">
              <span className="k">Then</span>{" "}
              {r.actions.map((a, j) => (
                <span key={JSON.stringify(a)}>
                  {j ? ", " : ""}
                  <ActionView part={actionPart(a)} labelById={labelById} keyName={keyName} />
                </span>
              ))}
            </span>
            <span className="r-meta">
              <span>{m.count}</span>
              <span>{m.last}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function RuleMenu({
  rule,
  index,
  count,
  canManage,
  onClose,
  onMove,
  onApply,
  onEdit,
  onDelete,
}: {
  rule: Rule
  index: number
  count: number
  canManage: boolean
  onClose: () => void
  onMove: (to: number) => void
  onApply: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus()
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose()
    const onEsc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && onClose()
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onEsc)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onEsc)
    }
  }, [onClose])
  const item = (label: string, fn: () => void, opts: { disabled?: boolean; danger?: boolean } = {}) => (
    <button
      className={`menu-item${opts.danger ? " danger" : ""}`}
      type="button"
      role="menuitem"
      aria-disabled={opts.disabled || !canManage ? "true" : undefined}
      onClick={() => {
        if (opts.disabled || !canManage) return
        fn()
      }}
    >
      <span className="grow">{label}</span>
    </button>
  )
  return (
    <div ref={ref} className="menu rule-menu" role="menu" aria-label={`Actions for ${rule.name}`}>
      {item("Edit", () => {
        onClose()
        onEdit()
      })}
      {item("Apply to existing mail", () => {
        onClose()
        onApply()
      })}
      {item("Move up", () => onMove(index - 1), { disabled: index === 0 })}
      {item("Move down", () => onMove(index + 1), { disabled: index === count - 1 })}
      <div className="menu-sep" />
      {confirm
        ? item(
            `Delete “${rule.name}” for good`,
            () => {
              onClose()
              onDelete()
            },
            { danger: true },
          )
        : item("Delete", () => setConfirm(true), { danger: true })}
      {!canManage ? <div className="menu-note">Owners and admins can change rules.</div> : null}
      <div className="menu-sep" />
      <Link className="menu-item" role="menuitem" to="/settings">
        <span className="grow">Open the full editor in Settings</span>
      </Link>
    </div>
  )
}

function ActionView({
  part: p,
  labelById,
  keyName,
}: {
  part: ReturnType<typeof actionPart>
  labelById: ReadonlyMap<string, { name: string; color: string | null }>
  keyName: (id: string) => string
}) {
  if (p.kind === "label") {
    const l = labelById.get(p.labelId)
    return <LabelTag name={l?.name ?? p.labelId} color={l?.color} />
  }
  if (p.kind === "assign")
    return (
      <>
        <span className="k">assign to key</span>{" "}
        <span className="ltag" title={p.keyId}>
          <Icon name="key" />
          {keyName(p.keyId)}
        </span>
      </>
    )
  if (p.kind === "kv")
    return (
      <>
        <span className="k">{p.k}</span> <span className="mono">{p.v}</span>
      </>
    )
  return <>{p.text}</>
}
