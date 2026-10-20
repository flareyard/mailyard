/**
 * Apply a rule to existing mail (rule-apply.html): `POST …/rules/{ruleId}/apply { folder, cursor, limit }`,
 * one folder a page at a time, following `nextCursor`. It never sends: forwards, auto-replies and webhooks
 * are skipped and named.
 */
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt } from "../../lib/format.ts"
import { PanelError } from "../../ui/Panel.tsx"
import { useMail } from "../context.tsx"
import { FOLDER_TITLE } from "../logic.ts"
import { SampleMarker, Sheet } from "./shared.tsx"
import type { ApplyFolder, Rule, RuleApply } from "./types.ts"

const LIMIT = 500
const FOLDERS: ApplyFolder[] = ["inbox", "archive", "sent", "snoozed", "spam", "trash"]

type Run = {
  pages: number
  examined: number
  matched: number
  changed: number
  skipped: Set<string>
  nextCursor: string | null
}

export function ApplySheet({ rule, onClose }: { rule: Rule; onClose: () => void }) {
  const { mailboxId, access } = useMail()
  const [folder, setFolder] = useState<ApplyFolder>("inbox")
  const [run, setRun] = useState<Run | null>(null)
  const apply = useMutation({
    mutationFn: (cursor: string | null) =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/rules/{ruleId}/apply", {
          params: { path: { id: mailboxId, ruleId: rule.id } },
          body: { folder, limit: LIMIT, ...(cursor ? { cursor } : {}) },
        }),
      ) as Promise<RuleApply>,
    onSuccess: (r) =>
      setRun((prev) => ({
        pages: (prev?.pages ?? 0) + 1,
        examined: (prev?.examined ?? 0) + Number(r.examined),
        matched: (prev?.matched ?? 0) + Number(r.matched),
        changed: (prev?.changed ?? 0) + Number(r.changed),
        skipped: new Set([...(prev?.skipped ?? []), ...r.skippedActions]),
        nextCursor: r.nextCursor,
      })),
  })
  const sending = rule.actions.filter(
    (a) => a.type === "forward" || a.type === "autoReply" || a.type === "webhook",
  )
  const where = FOLDER_TITLE[folder]
  const done = run && !run.nextCursor
  const unchanged = run ? run.matched - run.changed : 0
  return (
    <Sheet
      title={`Apply “${rule.name}” to existing mail`}
      hint="Rules normally run only on new mail. This runs one over mail you already have, a page at a time."
      onClose={onClose}
      endpoint="POST /v1/mailboxes/{id}/rules/{ruleId}/apply (built)"
      foot={
        <>
          <span style={{ marginRight: "auto" }}>
            <SampleMarker />
          </span>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            {run ? (done ? "Done" : "Stop here") : "Cancel"}
          </button>
          {!done ? (
            <Gated allowed={access.manage} reason={access.manageReason} who={access.manageWho} side="up">
              <button
                className="btn btn-primary"
                type="button"
                disabled={apply.isPending}
                onClick={() => apply.mutate(run?.nextCursor ?? null)}
              >
                {apply.isPending
                  ? "Running…"
                  : run
                    ? `Continue with the next ${LIMIT}`
                    : `Run on the first ${LIMIT}`}
              </button>
            </Gated>
          ) : null}
        </>
      }
    >
      <div className="callout callout-info">
        <span>
          <b>It never sends mail.</b> Labels, folders, stars, read state and assignments change. Forwards,
          auto-replies and webhooks are skipped on existing mail, and the result lists which ones.
        </span>
      </div>
      <div className="field">
        <label className="label" htmlFor="apply-scope">
          Which folder
        </label>
        <select
          className="select"
          id="apply-scope"
          value={folder}
          disabled={Boolean(run)}
          onChange={(e) => setFolder(e.target.value as ApplyFolder)}
        >
          {FOLDERS.map((f) => (
            <option key={f} value={f}>
              {FOLDER_TITLE[f]}
            </option>
          ))}
        </select>
        <span className="hint">One folder per run. Spam and Trash are there if you need them.</span>
      </div>
      {apply.isError ? (
        <PanelError
          error={apply.error}
          onRetry={() => apply.mutate(run?.nextCursor ?? null)}
          what="This page didn’t run"
        />
      ) : null}
      {run ? (
        <div className="stack stack-12" role="status" aria-live="polite">
          <div className="spread">
            <b className="t-label">
              {done ? `All of ${where} done` : `First ${fmtInt(run.pages * LIMIT)} done`}
            </b>
            {run.nextCursor ? (
              <span className="t-small muted mono">nextCursor: {run.nextCursor.slice(0, 8)}…</span>
            ) : null}
          </div>
          <div className="imp-head">
            <div className="stat">
              <span className="stat-label">Examined</span>
              <span className="stat-value num">{fmtInt(run.examined)}</span>
              <span className="stat-delta">messages so far</span>
            </div>
            <div className="stat">
              <span className="stat-label">Matched</span>
              <span className="stat-value num">{fmtInt(run.matched)}</span>
              <span className="stat-delta">met the conditions</span>
            </div>
            <div className="stat">
              <span className="stat-label">Changed</span>
              <span className="stat-value num">{fmtInt(run.changed)}</span>
              <span className="stat-delta">
                {unchanged > 0 ? `${fmtInt(unchanged)} already matched it` : "every match changed"}
              </span>
            </div>
          </div>
          <p className="hint">
            {run.skipped.size ? (
              <>
                Skipped on existing mail:{" "}
                {[...run.skipped].map((s) => (
                  <span key={s} className="ltag" style={{ marginRight: 4 }}>
                    {s}
                  </span>
                ))}
                (nothing is sent for these {fmtInt(run.changed)}).{" "}
              </>
            ) : null}
            {run.nextCursor
              ? `More mail is left in ${where}: continue to run the next ${LIMIT}.`
              : `Nothing more in ${where}.`}
          </p>
        </div>
      ) : sending.length ? (
        <p className="hint">
          This rule also{" "}
          {sending
            .map((a) =>
              a.type === "autoReply" ? "auto-replies" : a.type === "forward" ? "forwards" : "calls a webhook",
            )
            .join(", ")}
          ; those are skipped here.
        </p>
      ) : null}
    </Sheet>
  )
}
