/**
 * Apply a rule to existing mail (design: rule-apply, -progress, -done; HANDOFF-ops §16). POST …/apply runs one
 * page (500 conversations) per call and answers `nextCursor` while there's more; Continue runs the next page.
 * It never sends: forwards, auto-replies and webhooks only run on new mail and come back as `skippedActions`.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fmtInt, num } from "../../lib/format.ts"
import { BuiltPill } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { NEW_MAIL_ONLY } from "../logic.ts"
import { ApiRefusal } from "../mailboxes/CreateMailbox.tsx"
import { rulesQuery } from "../queries.ts"
import { useRuleNames } from "./names.ts"
import type { RuleT } from "./RulesPage.tsx"
import { ActionTok } from "./Tokens.tsx"

type Folder = "inbox" | "archive" | "sent" | "trash" | "spam" | "snoozed"
const FOLDERS: [Folder, string][] = [
  ["inbox", "Inbox"],
  ["archive", "Archive"],
  ["sent", "Sent"],
  ["snoozed", "Snoozed"],
  ["spam", "Spam"],
  ["trash", "Trash"],
]
const PAGE = 500

type Totals = {
  examined: number
  matched: number
  changed: number
  skipped: string[]
  cursor: string | null
  pages: number
}

export function RuleApply({
  mailboxId,
  rule,
  onBack,
}: {
  mailboxId: string
  rule: RuleT
  onBack: () => void
}) {
  const qc = useQueryClient()
  const names = useRuleNames(mailboxId)
  const [folder, setFolder] = useState<Folder>("inbox")
  const [t, setT] = useState<Totals | null>(null)
  const run = useMutation({
    mutationFn: (cursor: string | null) =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/rules/{ruleId}/apply", {
          params: { path: { id: mailboxId, ruleId: rule.id } },
          body: { folder, limit: PAGE, ...(cursor ? { cursor } : {}) },
        }),
      ),
    onSuccess: (r) => {
      setT((p) => ({
        examined: (p?.examined ?? 0) + (num(r.examined) ?? 0),
        matched: (p?.matched ?? 0) + (num(r.matched) ?? 0),
        changed: (p?.changed ?? 0) + (num(r.changed) ?? 0),
        skipped: [...new Set([...(p?.skipped ?? []), ...r.skippedActions])],
        cursor: r.nextCursor,
        pages: (p?.pages ?? 0) + 1,
      }))
      if (!r.nextCursor) {
        qc.invalidateQueries({ queryKey: rulesQuery(mailboxId).queryKey })
        qc.invalidateQueries({ queryKey: ["mailboxes", mailboxId, "threads"] })
      }
    },
  })
  const applies = rule.actions.filter((a) => !NEW_MAIL_ONLY.has(a.type))
  const skips = rule.actions.filter((a) => NEW_MAIL_ONLY.has(a.type))
  const label = FOLDERS.find(([f]) => f === folder)?.[1] ?? "Inbox"
  const done = t !== null && t.cursor === null
  return (
    <section
      className="panel"
      data-endpoint={`POST /v1/mailboxes/${mailboxId}/rules/${rule.id}/apply`}
      data-od-id="panel-apply"
      aria-labelledby="h-apply"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-apply">
          Apply “{rule.name}” to existing mail
          <BuiltPill issue="HAL-3368" />
        </h2>
        <div className="cluster" />
      </header>
      <div className="panel-body">
        <div className="stack stack-16">
          <div className="callout callout-info">
            <Icon name="shield" />
            <span>
              <b>This never sends mail.</b> On existing mail it applies labels, moves, read, star and
              assignment. Forwards, auto-replies and webhooks only run on new mail, so they’re skipped here.
            </span>
          </div>
          {t === null ? (
            <>
              <div className="field">
                <label className="label" htmlFor="ap-folder">
                  Run it on
                </label>
                <select
                  className="select"
                  id="ap-folder"
                  value={folder}
                  onChange={(e) => setFolder(e.target.value as Folder)}
                >
                  {FOLDERS.map(([f, l]) => (
                    <option key={f} value={f}>
                      {l}
                    </option>
                  ))}
                </select>
                <span className="hint">
                  Leave it on Inbox, or pick another folder. Runs {fmtInt(PAGE)} conversations at a time.
                </span>
              </div>
              <dl className="kv">
                <dt>Rule</dt>
                <dd>{rule.name}</dd>
                <dt>Will apply</dt>
                <dd>
                  {applies.length ? (
                    applies.map((a) => <ActionTok key={JSON.stringify(a)} a={a} names={names} />)
                  ) : (
                    <span className="muted">Nothing: every action needs new mail</span>
                  )}
                </dd>
                {skips.length ? (
                  <>
                    <dt>Skipped</dt>
                    <dd>
                      {skips.map((a) => (
                        <ActionTok key={JSON.stringify(a)} a={a} names={names} />
                      ))}{" "}
                      <span className="muted t-small">new mail only</span>
                    </dd>
                  </>
                ) : null}
              </dl>
            </>
          ) : (
            <>
              <div
                className={`progress${done ? " is-done" : ""}`}
                role="progressbar"
                aria-label="Conversations examined"
                aria-valuemin={0}
                aria-valuenow={t.examined}
                aria-valuetext={
                  done ? `All ${fmtInt(t.examined)} examined` : `${fmtInt(t.examined)} examined, more to go`
                }
              >
                <span
                  style={{ width: done ? "100%" : `${Math.min(90, (t.pages / (t.pages + 1)) * 100)}%` }}
                />
              </div>
              <div className="big-figures">
                <div className="fig">
                  <span className="stat-label">Examined</span>
                  <span className="stat-value">{fmtInt(t.examined)}</span>
                </div>
                <div className="fig">
                  <span className="stat-label">Matched</span>
                  <span className="stat-value">{fmtInt(t.matched)}</span>
                </div>
                <div className="fig">
                  <span className="stat-label">Changed</span>
                  <span className="stat-value">{fmtInt(t.changed)}</span>
                </div>
              </div>
              <p className="hint">
                {t.skipped.length ? (
                  <>
                    Skipped on existing mail:{" "}
                    {t.skipped.map((s, i) => (
                      <span key={s}>
                        {i ? ", " : ""}
                        <span className="mono">{s}</span>
                      </span>
                    ))}
                    .{" "}
                  </>
                ) : null}
                Nothing was sent.
              </p>
              {done ? (
                <div className="callout callout-ok" role="status">
                  <Icon name="check-circle" />
                  <span>
                    <b>Done.</b> {fmtInt(t.changed)} conversation{t.changed === 1 ? "" : "s"} changed in{" "}
                    {label}
                    {t.matched > t.changed
                      ? `; ${fmtInt(t.matched - t.changed)} already matched what the rule does`
                      : ""}
                    .
                  </span>
                </div>
              ) : (
                <div className="cluster">
                  <span className="t-small muted">
                    More to go: the next page starts at <span className="mono">nextCursor</span>.
                  </span>
                  <button
                    className="btn btn-primary btn-sm"
                    type="button"
                    disabled={run.isPending}
                    onClick={() => run.mutate(t.cursor)}
                  >
                    {run.isPending ? "Running…" : "Continue"}
                  </button>
                </div>
              )}
            </>
          )}
          {run.isError ? <ApiRefusal error={run.error} /> : null}
          <div className="cluster">
            {t === null ? (
              <button
                className="btn btn-primary"
                type="button"
                disabled={run.isPending}
                onClick={() => run.mutate(null)}
                data-endpoint={`POST /v1/mailboxes/${mailboxId}/rules/${rule.id}/apply { folder: ${folder}, limit: ${PAGE} }`}
              >
                <Icon name="history" />
                {run.isPending ? "Applying…" : `Apply to ${label}`}
              </button>
            ) : null}
            <button className="btn btn-ghost" type="button" onClick={onBack}>
              {done ? "Back to the rule" : "Cancel"}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
