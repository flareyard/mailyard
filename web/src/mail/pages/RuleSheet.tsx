/**
 * The rule editor sheet (rule-from-message.html): a new rule, a rule filled in from a message (the reader's
 * More menu), or an existing rule. Conditions and actions per the live schema; testing against the message
 * runs the saved rules with `POST …/rules/test` and adds this rule's effect, since it isn't saved yet.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton, RequestId } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { mailboxDetailQuery, mailKeys, messageQuery } from "../queries.ts"
import { toast } from "../toasts.tsx"
import type { FoldersBody } from "../types.ts"
import {
  FIELD_WORDS,
  OP_WORDS,
  type Outcome,
  prefillFromMessage,
  type RuleMessage,
  ruleMatches,
  ruleProblem,
  sendsWords,
  withDraftRule,
} from "./logic.ts"
import { LabelTag, pageKeys, SampleMarker, Sheet } from "./shared.tsx"
import type { Rule, RuleAction, RuleCondition, RuleCreate, RuleList, RuleTest } from "./types.ts"

type ActionType = RuleAction["type"]
const ACTION_WORDS: Record<ActionType, string> = {
  label: "Add label",
  archive: "Archive",
  trash: "Move to trash",
  spam: "Mark as spam",
  markRead: "Mark read",
  star: "Star",
  skipSpamCheck: "Skip the spam check",
  forward: "Forward to",
  autoReply: "Auto-reply",
  webhook: "Call a webhook",
  assign: "Assign to key",
}
const FIELDS = [
  "from",
  "to",
  "cc",
  "recipients",
  "subject",
  "listId",
  "tag",
  "body",
  "hasAttachment",
  "automated",
] as const
const OPS = ["contains", "notContains", "equals", "startsWith", "endsWith"] as const

const blankAction = (type: ActionType): RuleAction => {
  switch (type) {
    case "label":
      return { type, labelId: "" }
    case "forward":
      return { type, to: [] }
    case "autoReply":
      return { type, subject: "", body: "" }
    case "webhook":
      return { type, endpointId: "" }
    case "assign":
      return { type, assignee: "" }
    default:
      return { type }
  }
}

const blankCondition = (field: (typeof FIELDS)[number]): RuleCondition =>
  field === "hasAttachment" || field === "automated"
    ? { field, value: true }
    : { field, op: "contains", value: "" }

const blankRule = (): RuleCreate => ({
  name: "",
  enabled: true,
  match: "all",
  conditions: [blankCondition("from")],
  actions: [],
  stop: false,
})

export function RuleSheet({
  messageId,
  rule,
  onClose,
}: {
  messageId?: string
  rule?: Rule
  onClose: () => void
}) {
  const { mailboxId, local, labels, access } = useMail()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const message = useQuery({ ...messageQuery(mailboxId, messageId ?? ""), enabled: Boolean(messageId) })
  const detail = useQuery(mailboxDetailQuery(mailboxId))
  const rules = useQuery({
    queryKey: pageKeys.rules(mailboxId),
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/rules", { params: { path: { id: mailboxId } } }),
      ) as Promise<RuleList>,
  })
  const webhooks = useQuery({
    queryKey: ["webhooks"],
    queryFn: () => unwrap(api.GET("/v1/webhooks")),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const [draft, setDraft] = useState<RuleCreate | null>(
    rule
      ? {
          name: rule.name,
          enabled: rule.enabled,
          match: rule.match,
          conditions: rule.conditions,
          actions: rule.actions,
          stop: rule.stop,
        }
      : messageId
        ? null
        : blankRule(),
  )
  const [applyAfter, setApplyAfter] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState<{ index: number; name: string } | null>(null)

  const msg: RuleMessage | null = message.data
    ? {
        subject: message.data.subject,
        from: message.data.from,
        listId: message.data.listId,
        tag: message.data.tag,
        to: message.data.to,
        cc: message.data.cc,
        snippet: message.data.snippet,
        automated: message.data.automated,
        attachments: message.data.attachments,
        body: message.data.body,
      }
    : null
  // Fill in from the message once it loads.
  useEffect(() => {
    if (!draft && msg) setDraft(prefillFromMessage(msg))
  }, [draft, msg])

  const test = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/rules/test", {
          params: { path: { id: mailboxId } },
          body: { messageId: messageId ?? "" },
        }),
      ) as Promise<RuleTest>,
  })
  // Test once on open when there's a message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once per message
  useEffect(() => {
    if (messageId) test.mutate()
  }, [messageId])

  const save = useMutation({
    mutationFn: async (body: RuleCreate) =>
      rule
        ? ((await unwrap(
            api.PATCH("/v1/mailboxes/{id}/rules/{ruleId}", {
              params: { path: { id: mailboxId, ruleId: rule.id } },
              body,
            }),
          )) as Rule)
        : ((await unwrap(
            api.POST("/v1/mailboxes/{id}/rules", { params: { path: { id: mailboxId } }, body }),
          )) as Rule),
    onSuccess: (saved) => {
      qc.setQueryData<RuleList>(pageKeys.rules(mailboxId), (old) =>
        old
          ? { rules: rule ? old.rules.map((r) => (r.id === saved.id ? saved : r)) : [...old.rules, saved] }
          : old,
      )
      toast({
        title: rule ? `Saved “${saved.name}”` : `Created “${saved.name}”`,
        sub: "It runs on new mail as it arrives.",
      })
      onClose()
      if (applyAfter)
        navigate({
          to: "/mail/$mailboxId/rules",
          params: { mailboxId },
          search: { apply: saved.id } as never,
        })
    },
    onError: (e) =>
      setProblem(e instanceof ApiError ? e.message : "Mailyard couldn’t be reached. Nothing was saved."),
  })

  const createLabel = useMutation({
    mutationFn: (name: string) =>
      unwrap(api.POST("/v1/mailboxes/{id}/labels", { params: { path: { id: mailboxId } }, body: { name } })),
    onSuccess: (label, _name) => {
      qc.setQueryData<FoldersBody>(mailKeys.folders(mailboxId), (old) =>
        old ? { ...old, labels: [...old.labels, label as FoldersBody["labels"][number]] } : old,
      )
      if (newLabel) setAction(newLabel.index, { type: "label", labelId: (label as { id: string }).id })
      setNewLabel(null)
    },
    onError: (e) => setProblem(e instanceof ApiError ? e.message : "The label couldn’t be created."),
  })

  const keys = useMemo(() => {
    const d = detail.data
    const out: { id: string; name: string }[] = []
    for (const m of d?.members ?? []) if (!m.revoked) out.push({ id: m.apiKeyId, name: m.name })
    for (const p of d?.people ?? []) out.push({ id: p.memberId, name: p.name })
    return out
  }, [detail.data])
  const keyName = (id: string | null) => (id ? (keys.find((k) => k.id === id)?.name ?? id) : null)
  const labelById = new Map(labels.map((l) => [l.id, l]))

  if (messageId && message.isError)
    return (
      <Sheet title="New rule from this message" onClose={onClose}>
        <PanelError error={message.error} onRetry={() => message.refetch()} what="The message didn’t load" />
      </Sheet>
    )
  if (!draft)
    return (
      <Sheet title="New rule from this message" onClose={onClose}>
        <PanelSkeleton rows={5} />
      </Sheet>
    )

  const set = (patch: Partial<RuleCreate>) => setDraft({ ...draft, ...patch })
  const setCond = (i: number, c: RuleCondition) =>
    set({ conditions: draft.conditions.map((x, j) => (j === i ? c : x)) })
  function setAction(i: number, a: RuleAction) {
    setDraft((d) => (d ? { ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) } : d))
  }

  const existing = rules.data?.rules.length ?? 0
  const matches = msg ? ruleMatches(draft.match ?? "all", draft.conditions, msg) : false
  const serverOutcome = test.data?.outcome as Outcome | undefined
  const outcome = serverOutcome
    ? withDraftRule(
        { ...serverOutcome, matched: [...serverOutcome.matched] },
        {
          id: rule?.id ?? "draft",
          matches: rule ? false : matches,
          actions: draft.actions,
          stop: draft.stop ?? false,
        },
      )
    : null
  const ruleName = (id: string) =>
    id === "draft"
      ? draft.name || "This rule"
      : (test.data?.matched.find((m) => m.id === id)?.name ??
        rules.data?.rules.find((r) => r.id === id)?.name ??
        id)

  const submit = () => {
    setProblem(null)
    const body: RuleCreate = {
      ...draft,
      actions: draft.actions.map((a) =>
        a.type === "forward" ? { ...a, to: a.to.map((t) => t.trim()).filter(Boolean) } : a,
      ),
    }
    const p = ruleProblem(body)
    if (p) return setProblem(p)
    save.mutate(body)
  }

  const fromName = message.data?.from?.name || message.data?.from?.address
  const title = rule ? `Edit “${rule.name}”` : messageId ? "New rule from this message" : "New rule"
  const hint = rule
    ? `Changes apply to new mail in ${local} from the moment you save.`
    : messageId
      ? `Filled in from ${fromName ? `${fromName.split(" ")[0]}’s` : "this"} message. It runs on new mail in ${local}, after the ${existing} rule${existing === 1 ? "" : "s"} already there.`
      : `It runs on new mail in ${local}, after the ${existing} rule${existing === 1 ? "" : "s"} already there.`

  return (
    <Sheet
      title={title}
      hint={hint}
      onClose={onClose}
      endpoint="POST /v1/mailboxes/{id}/rules · POST …/rules/test"
      foot={
        <>
          <span style={{ marginRight: "auto" }}>
            <SampleMarker />
          </span>
          {messageId ? (
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => test.mutate()}
              disabled={test.isPending}
            >
              {test.data ? "Test again" : "Test"}
            </button>
          ) : null}
          <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="up">
            <button className="btn btn-primary" type="button" onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : rule ? "Save rule" : "Create rule"}
            </button>
          </Gated>
        </>
      }
    >
      <div className="field">
        <label className="label" htmlFor="rule-name">
          Name
        </label>
        <input
          id="rule-name"
          className="input"
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
        />
      </div>
      <div className="builder">
        <div className="builder-head">
          When
          <select
            className="select"
            aria-label="Match"
            value={draft.match ?? "all"}
            onChange={(e) => set({ match: e.target.value as "all" | "any" })}
          >
            <option value="all">all</option>
            <option value="any">any</option>
          </select>
          of these are true
        </div>
        {draft.conditions.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; order is their identity
          <div className="cond" key={i}>
            <select
              className="select"
              aria-label="Field"
              value={c.field}
              onChange={(e) => {
                const field = e.target.value as (typeof FIELDS)[number]
                const next = blankCondition(field)
                setCond(i, "op" in next && "op" in c ? { ...next, op: c.op, value: c.value } : next)
              }}
            >
              {FIELDS.map((f) => (
                <option key={f} value={f}>
                  {f === "hasAttachment"
                    ? "Has attachment"
                    : f === "automated"
                      ? "Automated"
                      : cap(FIELD_WORDS[f] ?? f)}
                </option>
              ))}
            </select>
            {"op" in c ? (
              <>
                <select
                  className="select"
                  aria-label="Operator"
                  value={c.op}
                  onChange={(e) => setCond(i, { ...c, op: e.target.value as (typeof OPS)[number] })}
                >
                  {OPS.map((o) => (
                    <option key={o} value={o}>
                      {OP_WORDS[o]}
                    </option>
                  ))}
                </select>
                <input
                  className={`input${c.field === "subject" || c.field === "body" ? "" : " mono"}`}
                  aria-label="Value"
                  value={c.value}
                  onChange={(e) => setCond(i, { ...c, value: e.target.value })}
                />
              </>
            ) : (
              <>
                <select
                  className="select"
                  aria-label="Is"
                  value={c.value ? "yes" : "no"}
                  onChange={(e) => setCond(i, { ...c, value: e.target.value === "yes" })}
                >
                  <option value="yes">is true</option>
                  <option value="no">is false</option>
                </select>
                <span />
              </>
            )}
            <button
              className="icon-btn"
              type="button"
              aria-label="Remove condition"
              title="Remove condition"
              onClick={() => set({ conditions: draft.conditions.filter((_, j) => j !== i) })}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          style={{ alignSelf: "flex-start" }}
          onClick={() => set({ conditions: [...draft.conditions, blankCondition("subject")] })}
        >
          <Icon name="plus" />
          Add condition
        </button>
      </div>
      <div className="builder">
        <div className="builder-head">Then</div>
        {draft.actions.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: actions have no id; order is their identity
          <div className="cond" key={i}>
            <select
              className="select"
              aria-label="Action"
              value={a.type}
              onChange={(e) => setAction(i, blankAction(e.target.value as ActionType))}
            >
              {(Object.keys(ACTION_WORDS) as ActionType[]).map((t) => (
                <option key={t} value={t}>
                  {ACTION_WORDS[t]}
                </option>
              ))}
            </select>
            <ActionDetail
              action={a}
              labels={labels}
              keys={keys}
              webhooks={
                (webhooks.data as { webhooks?: { id: string; url: string }[] } | undefined)?.webhooks ?? []
              }
              onChange={(next) => setAction(i, next)}
              onNewLabel={() => setNewLabel({ index: i, name: "" })}
            />
            <button
              className="icon-btn"
              type="button"
              aria-label="Remove action"
              title="Remove action"
              onClick={() => set({ actions: draft.actions.filter((_, j) => j !== i) })}
            >
              <Icon name="x" />
            </button>
          </div>
        ))}
        {newLabel ? (
          <form
            className="cluster"
            onSubmit={(e) => {
              e.preventDefault()
              if (newLabel.name.trim()) createLabel.mutate(newLabel.name.trim())
            }}
          >
            <input
              className="input"
              style={{ flex: "1 1 160px", width: "auto" }}
              aria-label="New label name"
              placeholder="New label name"
              value={newLabel.name}
              onChange={(e) => setNewLabel({ ...newLabel, name: e.target.value })}
            />
            <button className="btn btn-secondary btn-sm" type="submit" disabled={createLabel.isPending}>
              Create label
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setNewLabel(null)}>
              Cancel
            </button>
          </form>
        ) : null}
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          style={{ alignSelf: "flex-start" }}
          onClick={() =>
            set({ actions: [...draft.actions, blankAction(labels.length ? "label" : "archive")] })
          }
        >
          <Icon name="plus" />
          Add action
        </button>
        <SkillHint />
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.stop ?? false}
          onChange={(e) => set({ stop: e.target.checked })}
        />
        <span>Stop here: later rules don’t run on mail this one matches</span>
      </label>
      {!rule ? (
        <label className="check">
          <input type="checkbox" checked={applyAfter} onChange={(e) => setApplyAfter(e.target.checked)} />
          <span>
            After saving, apply it to mail already in the Inbox. Labels, folders, stars and assignments only:
            it never sends anything.
          </span>
        </label>
      ) : null}
      {problem ? (
        <p className="field-error" role="alert">
          <Icon name="warn" />
          {problem}
        </p>
      ) : null}
      {save.error instanceof ApiError && save.error.requestId ? (
        <RequestId id={save.error.requestId} />
      ) : null}
      {messageId ? (
        test.isError ? (
          <PanelError error={test.error} onRetry={() => test.mutate()} what="The test didn’t run" />
        ) : outcome && message.data ? (
          <section
            className={`callout ${outcome.draftRan || rule ? "callout-ok" : "callout-info"} test-result`}
            role="status"
            data-endpoint="POST /v1/mailboxes/{id}/rules/test {messageId} → outcome, filedWith (built)"
          >
            <div className="stack stack-8" style={{ flex: 1, minWidth: 0 }}>
              <b>
                {rule
                  ? `How the saved rules file “${message.data.subject}”.`
                  : matches
                    ? `Matches “${message.data.subject}” from ${fromName}.`
                    : `Doesn’t match “${message.data.subject}” yet: change a condition, or test anyway to see how the other rules file it.`}
              </b>
              <dl className="kv">
                <dt>Rules matched</dt>
                <dd>
                  {outcome.matched.length
                    ? outcome.matched.map((id, i) => (
                        <span key={id}>
                          {i ? " → " : ""}
                          <span className="ltag">{ruleName(id)}</span>
                        </span>
                      ))
                    : "None"}
                </dd>
                <dt>Files into</dt>
                <dd>
                  <span className="mono">{outcome.folder ?? test.data?.filedWith.folder ?? "inbox"}</span>{" "}
                  <span className="t-small muted">
                    ({outcome.folder ? "moved by a rule" : "no rule moves it"}
                    {test.data?.filedWith.spamScore !== null && test.data?.filedWith.spamScore !== undefined
                      ? `; spam score ${num(test.data.filedWith.spamScore)}`
                      : ""}
                    )
                  </span>
                </dd>
                <dt>Labels</dt>
                <dd>
                  {outcome.labelIds.length
                    ? outcome.labelIds.map((id) => {
                        const l = labelById.get(id)
                        return <LabelTag key={id} name={l?.name ?? id} color={l?.color} />
                      })
                    : "None"}
                </dd>
                <dt>Assigned to</dt>
                <dd>
                  {outcome.assignee ? (
                    <span className="ltag" title={outcome.assignee}>
                      {keyName(outcome.assignee)}
                    </span>
                  ) : (
                    "Nobody"
                  )}
                </dd>
                <dt>Stopped at</dt>
                <dd>{outcome.stoppedAt ? ruleName(outcome.stoppedAt) : "No rule stopped the run"}</dd>
                <dt>Sends anything?</dt>
                <dd>{sendsWords(outcome)}</dd>
              </dl>
            </div>
          </section>
        ) : test.isPending ? (
          <PanelSkeleton rows={3} />
        ) : null
      ) : null}
    </Sheet>
  )
}

const cap = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s)

function ActionDetail({
  action: a,
  labels,
  keys,
  webhooks,
  onChange,
  onNewLabel,
}: {
  action: RuleAction
  labels: { id: string; name: string }[]
  keys: { id: string; name: string }[]
  webhooks: { id: string; url: string }[]
  onChange: (a: RuleAction) => void
  onNewLabel: () => void
}) {
  switch (a.type) {
    case "label":
      return (
        <>
          <select
            className="select"
            aria-label="Label"
            value={a.labelId}
            onChange={(e) =>
              e.target.value === "__new" ? onNewLabel() : onChange({ ...a, labelId: e.target.value })
            }
          >
            <option value="">Choose a label</option>
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="__new">New label…</option>
          </select>
          <span />
        </>
      )
    case "forward":
      return (
        <input
          className="input mono"
          aria-label="Forward to"
          placeholder="name@example.com, another@example.com"
          style={{ gridColumn: "span 2" }}
          value={a.to.join(", ")}
          onChange={(e) => onChange({ ...a, to: e.target.value.split(/[,\s]+/) })}
        />
      )
    case "autoReply":
      return (
        <>
          <input
            className="input"
            aria-label="Auto-reply subject"
            placeholder="Subject"
            value={a.subject}
            onChange={(e) => onChange({ ...a, subject: e.target.value })}
          />
          <input
            className="input"
            aria-label="Auto-reply body"
            placeholder="What it says"
            value={a.body}
            onChange={(e) => onChange({ ...a, body: e.target.value })}
          />
        </>
      )
    case "webhook":
      return (
        <>
          <select
            className="select"
            aria-label="Webhook"
            value={a.endpointId}
            onChange={(e) => onChange({ ...a, endpointId: e.target.value })}
          >
            <option value="">Choose a webhook</option>
            {webhooks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.url}
              </option>
            ))}
            {a.endpointId && !webhooks.some((w) => w.id === a.endpointId) ? (
              <option value={a.endpointId}>{a.endpointId}</option>
            ) : null}
          </select>
          <span />
        </>
      )
    case "assign":
      return (
        <>
          <select
            className="select"
            aria-label="Assign to"
            value={a.assignee}
            onChange={(e) => onChange({ ...a, assignee: e.target.value })}
          >
            <option value="">Choose who</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name} · {k.id}
              </option>
            ))}
            {a.assignee && !keys.some((k) => k.id === a.assignee) ? (
              <option value={a.assignee}>{a.assignee}</option>
            ) : null}
          </select>
          <span className="t-small muted">A person or an API key with access to this mailbox</span>
        </>
      )
    default:
      return (
        <>
          <span />
          <span />
        </>
      )
  }
}

/** The repo skill marker (HANDOFF-mail §18): a file in the user's repo the web app never runs. */
export function SkillHint() {
  return (
    <div className="skill-hint" role="note" data-repo="skills/add-inbox-rule-action/SKILL.md">
      <div className="grow">
        <span>
          <b>Need an action that isn’t here?</b> Ask your coding agent: the{" "}
          <span className="mono">add-inbox-rule-action</span> skill adds one, for example “set priority”,
          “snooze” or “notify”.
        </span>
        <span className="t-small muted">
          The skill is in your repo, linked into <span className="mono">.claude/skills</span>, so Claude Code
          picks it up there. The change is proven by <span className="mono">bun run check</span> and shipped
          with the <span className="mono">deploy</span> skill; this page doesn’t run anything.
        </span>
      </div>
      <span className="pill pill-repo">
        In your repo
        <span className="sr-only">
          . A file in your own Mailyard repo, used by your coding agent; the web app doesn’t run it.
        </span>
      </span>
    </div>
  )
}
