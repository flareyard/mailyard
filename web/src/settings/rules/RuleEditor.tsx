/**
 * The rule editor (design: rule-editor.html; HANDOFF-ops §16, §21): name, any/all conditions, actions, Stop,
 * a test against a real message (POST …/rules/test, which runs the saved rules and shows the typed `outcome`
 * and `filedWith`), save, apply to existing mail and delete.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtAgo, num } from "../../lib/format.ts"
import { BuiltPill } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import {
  ACTION_LABEL,
  type Action,
  blankAction,
  blankCondition,
  type Condition,
  FIELD_LABEL,
  OP_LABEL,
  type Op,
  refieldCondition,
  retypeAction,
  ruleProblem,
} from "../logic.ts"
import { ApiRefusal } from "../mailboxes/CreateMailbox.tsx"
import { rulesQuery, threadsQuery } from "../queries.ts"
import { type Names, useRuleNames } from "./names.ts"
import type { RuleT } from "./RulesPage.tsx"

const FIELDS = Object.keys(FIELD_LABEL) as Condition["field"][]
const OPS = Object.keys(OP_LABEL) as Op[]
const ACTIONS = Object.keys(ACTION_LABEL) as Action["type"][]
const TWO_COL = { gridTemplateColumns: "minmax(0,1fr) minmax(0,1.4fr) 36px" }

type Draft = { name: string; match: "all" | "any"; conditions: Condition[]; actions: Action[]; stop: boolean }

export function RuleEditor({
  mailboxId,
  rule,
  onClose,
  onSaved,
  onApply,
}: {
  mailboxId: string
  rule: RuleT | null
  onClose: () => void
  onSaved: (id: string) => void
  onApply: (id: string) => void
}) {
  const qc = useQueryClient()
  const names = useRuleNames(mailboxId)
  const [d, setD] = useState<Draft>(() =>
    rule
      ? {
          name: rule.name,
          match: rule.match,
          conditions: rule.conditions,
          actions: rule.actions,
          stop: rule.stop,
        }
      : { name: "", match: "all", conditions: [blankCondition()], actions: [blankAction()], stop: false },
  )
  const [problem, setProblem] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const defaults = {
    labelId: names.labels[0]?.id ?? "",
    endpointId: names.webhooks[0]?.id ?? "",
    assignee: names.assignees[0]?.id ?? "",
  }

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: d.name.trim(),
        match: d.match,
        conditions: d.conditions,
        actions: d.actions,
        stop: d.stop,
      }
      return rule
        ? unwrap(
            api.PATCH("/v1/mailboxes/{id}/rules/{ruleId}", {
              params: { path: { id: mailboxId, ruleId: rule.id } },
              body,
            }),
          )
        : unwrap(api.POST("/v1/mailboxes/{id}/rules", { params: { path: { id: mailboxId } }, body }))
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey })
      toast({
        title: rule ? `Saved “${d.name.trim()}”` : `Created “${d.name.trim()}”`,
        sub: "It runs on new mail from now on.",
      })
      if (r && typeof r === "object" && "id" in r) onSaved(String(r.id))
    },
  })
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/v1/mailboxes/{id}/rules/{ruleId}", {
          params: { path: { id: mailboxId, ruleId: rule?.id ?? "" } },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey })
      toast({ title: `Deleted “${rule?.name}”` })
      onClose()
    },
  })

  const submit = () => {
    const p = ruleProblem(d)
    setProblem(p)
    if (!p) save.mutate()
  }
  const setCond = (i: number, c: Condition) =>
    setD({ ...d, conditions: d.conditions.map((x, j) => (j === i ? c : x)) })
  const setAct = (i: number, a: Action) => setD({ ...d, actions: d.actions.map((x, j) => (j === i ? a : x)) })

  return (
    <section
      className="panel"
      data-endpoint={
        rule
          ? `PATCH /v1/mailboxes/${mailboxId}/rules/${rule.id} · POST /v1/mailboxes/${mailboxId}/rules/test`
          : `POST /v1/mailboxes/${mailboxId}/rules`
      }
      data-od-id="panel-editor"
      aria-labelledby="h-editor"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-editor">
          {rule ? `Edit “${rule.name}”` : "New rule"}
          <BuiltPill issue="HAL-3368" />
        </h2>
        <div className="cluster" />
      </header>
      <div className="panel-body">
        <div className="stack stack-16">
          <div className="field">
            <label className="label" htmlFor="rule-name">
              Name
            </label>
            <input
              className="input"
              id="rule-name"
              value={d.name}
              onChange={(e) => setD({ ...d, name: e.target.value })}
              autoComplete="off"
            />
          </div>
          <fieldset className="builder" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 6 }}>
              When
            </legend>
            {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
            <div className="seg" role="group" aria-label="Match" style={{ alignSelf: "flex-start" }}>
              <button
                type="button"
                aria-pressed={d.match === "any"}
                onClick={() => setD({ ...d, match: "any" })}
              >
                Any condition
              </button>
              <button
                type="button"
                aria-pressed={d.match === "all"}
                onClick={() => setD({ ...d, match: "all" })}
              >
                All conditions
              </button>
            </div>
            {d.conditions.map((c, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
              <div key={i} className="builder-row">
                <select
                  className="select"
                  aria-label="Field"
                  value={c.field}
                  onChange={(e) => setCond(i, refieldCondition(c, e.target.value as Condition["field"]))}
                >
                  {FIELDS.map((f) => (
                    <option key={f} value={f}>
                      {FIELD_LABEL[f]}
                    </option>
                  ))}
                </select>
                {"op" in c ? (
                  <>
                    <select
                      className="select"
                      aria-label="Operator"
                      value={c.op}
                      onChange={(e) => setCond(i, { ...c, op: e.target.value as Op })}
                    >
                      {OPS.map((o) => (
                        <option key={o} value={o}>
                          {OP_LABEL[o]}
                        </option>
                      ))}
                    </select>
                    <input
                      className="input mono"
                      aria-label="Value"
                      value={c.value}
                      onChange={(e) => setCond(i, { ...c, value: e.target.value })}
                    />
                  </>
                ) : (
                  <select
                    className="select"
                    aria-label="Value"
                    style={{ gridColumn: "span 2" }}
                    value={c.value ? "yes" : "no"}
                    onChange={(e) => setCond(i, { ...c, value: e.target.value === "yes" })}
                  >
                    <option value="yes">yes</option>
                    <option value="no">no</option>
                  </select>
                )}
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="Remove condition"
                  onClick={() => setD({ ...d, conditions: d.conditions.filter((_, j) => j !== i) })}
                >
                  <Icon name="x" />
                </button>
              </div>
            ))}
            <div>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setD({ ...d, conditions: [...d.conditions, blankCondition()] })}
              >
                <Icon name="plus" />
                Add condition
              </button>
            </div>
          </fieldset>
          <fieldset className="builder" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 6 }}>
              Then
            </legend>
            {d.actions.map((a, i) => (
              <ActionRow
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is the identity
                key={i}
                a={a}
                names={names}
                onChange={(x) => setAct(i, x)}
                onRetype={(type) => setAct(i, retypeAction(a, type, defaults))}
                onRemove={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })}
              />
            ))}
            {d.actions.some((a) => a.type === "assign") ? (
              <p className="hint" style={{ marginTop: -4 }}>
                Assignees are the mailbox’s member keys: the rule assigns by API key id.
              </p>
            ) : null}
            <div>
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => setD({ ...d, actions: [...d.actions, blankAction()] })}
              >
                <Icon name="plus" />
                Add action
              </button>
            </div>
            <p className="skill-hint" data-od-id="skill-hint-rule">
              <Icon name="transactional" />
              <span>
                Need an action that isn’t in the list, like setting a priority or snoozing? Ask your coding
                agent: the <code className="mono">add-inbox-rule-action</code> skill adds one.{" "}
                <span className="sh-where">In your repo, not this app.</span>
              </span>
            </p>
          </fieldset>
          <label className="check">
            <input
              type="checkbox"
              checked={d.stop}
              onChange={(e) => setD({ ...d, stop: e.target.checked })}
            />
            <span>Stop here: don’t run the rules below when this one matches</span>
          </label>
          {rule ? <RuleTest mailboxId={mailboxId} names={names} /> : null}
          {problem ? (
            <div className="callout callout-error" role="alert">
              <Icon name="x-circle" />
              <span>{problem}</span>
            </div>
          ) : null}
          {save.isError ? <ApiRefusal error={save.error} /> : null}
          <div className="cluster">
            <button
              className="btn btn-primary"
              type="button"
              onClick={submit}
              disabled={save.isPending}
              data-endpoint={
                rule
                  ? `PATCH /v1/mailboxes/${mailboxId}/rules/${rule.id}`
                  : `POST /v1/mailboxes/${mailboxId}/rules`
              }
            >
              {save.isPending ? "Saving…" : rule ? "Save rule" : "Create rule"}
            </button>
            {rule ? (
              <button className="btn btn-secondary" type="button" onClick={() => onApply(rule.id)}>
                <Icon name="history" />
                Apply to existing mail
              </button>
            ) : null}
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
            <span className="grow" />
            {rule ? (
              <button
                className="btn btn-danger-ghost btn-sm"
                type="button"
                onClick={() => setConfirmDelete(true)}
                data-endpoint={`DELETE /v1/mailboxes/${mailboxId}/rules/${rule.id}`}
              >
                <Icon name="trash" />
                Delete rule
              </button>
            ) : null}
          </div>
        </div>
      </div>
      {confirmDelete && rule ? (
        <Sheet
          title={`Delete “${rule.name}”?`}
          sub="New mail stops running through it. Mail it already changed stays as it is."
          onClose={() => setConfirmDelete(false)}
          foot={
            <>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setConfirmDelete(false)}
                data-autofocus=""
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                <Icon name="trash" />
                {remove.isPending ? "Deleting…" : "Delete rule"}
              </button>
            </>
          }
        >
          <p>
            It has matched <b>{num(rule.matchCount) ?? 0}</b> message{num(rule.matchCount) === 1 ? "" : "s"}.
            To keep it but stop it running, turn it off instead.
          </p>
          {remove.isError ? <ApiRefusal error={remove.error} /> : null}
        </Sheet>
      ) : null}
    </section>
  )
}

function ActionRow({
  a,
  names,
  onChange,
  onRetype,
  onRemove,
}: {
  a: Action
  names: Names
  onChange: (a: Action) => void
  onRetype: (t: Action["type"]) => void
  onRemove: () => void
}) {
  const second = (() => {
    switch (a.type) {
      case "label":
        return (
          <select
            className="select"
            aria-label="Label"
            value={a.labelId}
            onChange={(e) => onChange({ ...a, labelId: e.target.value })}
          >
            {!names.labels.length ? <option value="">No labels in this mailbox</option> : null}
            {a.labelId && !names.labels.some((l) => l.id === a.labelId) ? (
              <option value={a.labelId}>{a.labelId}</option>
            ) : null}
            {names.labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )
      case "forward":
        return (
          <input
            className="input mono"
            aria-label="Forward to"
            value={a.to.join(", ")}
            placeholder="name@example.com"
            onChange={(e) => onChange({ ...a, to: e.target.value.split(/[\s,]+/).filter(Boolean) })}
          />
        )
      case "webhook":
        return (
          <select
            className="select"
            aria-label="Webhook"
            value={a.endpointId}
            onChange={(e) => onChange({ ...a, endpointId: e.target.value })}
          >
            {!names.webhooks.length ? <option value="">No webhooks yet</option> : null}
            {a.endpointId && !names.webhooks.some((w) => w.id === a.endpointId) ? (
              <option value={a.endpointId}>{a.endpointId}</option>
            ) : null}
            {names.webhooks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )
      case "assign":
        return (
          <select
            className="select"
            aria-label="Assignee"
            value={a.assignee}
            onChange={(e) => onChange({ ...a, assignee: e.target.value })}
          >
            {!names.assignees.length ? <option value="">No member keys on this mailbox</option> : null}
            {a.assignee && !names.assignees.some((m) => m.id === a.assignee) ? (
              <option value={a.assignee}>{a.assignee} · not a member key here</option>
            ) : null}
            {names.assignees.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.id}
              </option>
            ))}
          </select>
        )
      case "autoReply":
        return (
          <input
            className="input"
            aria-label="Auto-reply subject"
            value={a.subject}
            placeholder="Subject"
            onChange={(e) => onChange({ ...a, subject: e.target.value })}
          />
        )
      default:
        return (
          <span className="muted t-small" style={{ alignSelf: "center" }}>
            No setting
          </span>
        )
    }
  })()
  return (
    <>
      <div className="builder-row" style={TWO_COL}>
        <select
          className="select"
          aria-label="Action"
          value={a.type}
          onChange={(e) => onRetype(e.target.value as Action["type"])}
        >
          {ACTIONS.map((t) => (
            <option key={t} value={t}>
              {ACTION_LABEL[t]}
            </option>
          ))}
        </select>
        {second}
        <button className="icon-btn" type="button" aria-label="Remove action" onClick={onRemove}>
          <Icon name="x" />
        </button>
      </div>
      {a.type === "autoReply" ? (
        <textarea
          className="textarea"
          rows={3}
          aria-label="Auto-reply message"
          value={a.body}
          placeholder="Message"
          onChange={(e) => onChange({ ...a, body: e.target.value })}
        />
      ) : null}
    </>
  )
}

function RuleTest({ mailboxId, names }: { mailboxId: string; names: Names }) {
  const threads = useQuery(threadsQuery(mailboxId))
  const list = threads.data?.threads ?? []
  const [messageId, setMessageId] = useState("")
  const chosen = messageId || list[0]?.latestMessageId || ""
  const t = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/rules/test", {
          params: { path: { id: mailboxId } },
          body: { messageId: chosen },
        }),
      ),
  })
  const r = t.data
  const stopped = r?.outcome.stoppedAt
  return (
    <div className="test-out" data-endpoint={`POST /v1/mailboxes/${mailboxId}/rules/test`}>
      <div className="spread">
        <span className="label">Test against a real message</span>
        <span className="cluster">
          <select
            className="select"
            style={{ maxWidth: "100%", height: 32 }}
            aria-label="Message to test"
            value={chosen}
            onChange={(e) => setMessageId(e.target.value)}
            disabled={!list.length}
          >
            {!list.length ? (
              <option value="">
                {threads.isPending ? "Loading messages…" : "No messages in this mailbox"}
              </option>
            ) : null}
            {list.map((th) => (
              <option key={th.id} value={th.latestMessageId}>
                “{th.subject}” · {th.participants[0]?.address ?? ""} · {fmtAgo(th.lastAt as number)}
              </option>
            ))}
          </select>
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            disabled={!chosen || t.isPending}
            onClick={() => t.mutate()}
          >
            <Icon name="zap" />
            {t.isPending ? "Testing…" : "Test"}
          </button>
        </span>
      </div>
      <span className="hint">
        Runs the saved rules on that message without changing it. Save first to test your edits.
      </span>
      {t.isError ? <ApiRefusal error={t.error} /> : null}
      {r ? (
        <>
          {r.matched.length ? (
            <div className="callout callout-ok" style={{ padding: "8px 10px" }}>
              <Icon name="check-circle" />
              <span>
                <b>Matches {r.matched.map((m) => `“${m.name}”`).join(", ")}</b>
                {stopped ? (
                  <>
                    {" "}
                    and stops there (<span className="mono">stoppedAt: {stopped}</span>).
                  </>
                ) : (
                  "."
                )}
              </span>
            </div>
          ) : (
            <div className="callout callout-info" style={{ padding: "8px 10px" }}>
              <Icon name="info" />
              <span>
                <b>No rule matches this message.</b>
              </span>
            </div>
          )}
          <dl className="kv">
            {r.outcome.labelIds.length ? (
              <>
                <dt>Labels</dt>
                <dd>{r.outcome.labelIds.map(names.label).join(", ")}</dd>
              </>
            ) : null}
            {r.outcome.forwards.length ? (
              <>
                <dt>Forwards to</dt>
                <dd>
                  <span className="mono">{r.outcome.forwards.flatMap((f) => f.to).join(", ")}</span>{" "}
                  <span className="muted t-small">(on new mail only)</span>
                </dd>
              </>
            ) : null}
            {r.outcome.autoReplies.length ? (
              <>
                <dt>Auto-replies</dt>
                <dd>{r.outcome.autoReplies.map((a) => `“${a.subject}”`).join(", ")}</dd>
              </>
            ) : null}
            {r.outcome.webhooks.length ? (
              <>
                <dt>Webhooks</dt>
                <dd>{r.outcome.webhooks.map((w) => names.webhook(w.endpointId)).join(", ")}</dd>
              </>
            ) : null}
            {r.outcome.assignee ? (
              <>
                <dt>Assigned to</dt>
                <dd>
                  {names.assignee(r.outcome.assignee)}{" "}
                  <span className="mono muted">{r.outcome.assignee}</span>
                </dd>
              </>
            ) : null}
            {[
              r.outcome.markRead && "Mark read",
              r.outcome.star && "Star",
              r.outcome.skipSpamCheck && "Skip the spam check",
            ].some(Boolean) ? (
              <>
                <dt>Also</dt>
                <dd>
                  {[
                    r.outcome.markRead && "Mark read",
                    r.outcome.star && "Star",
                    r.outcome.skipSpamCheck && "Skip the spam check",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                </dd>
              </>
            ) : null}
            <dt>Filed in</dt>
            <dd>
              {r.filedWith.folder.charAt(0).toUpperCase() + r.filedWith.folder.slice(1)}
              {r.filedWith.spamScore !== null ? ` · spam score ${num(r.filedWith.spamScore)}` : ""}
              {r.filedWith.spamReasons.length
                ? ` (${r.filedWith.spamReasons.map((x) => x.rule).join(", ")})`
                : ""}
            </dd>
          </dl>
        </>
      ) : null}
    </div>
  )
}
