/**
 * The approval queue (design: agent-approvals, -empty, -loading, -error, -no-admin, agent-approval-reject;
 * HAL-3460, live): sends held from keys whose limits say `requireApproval`, with who asked, from, to, subject
 * and, for a held draft, its text. Approve sends it through the path it was held on; Reject takes a reason
 * the agent reads on its next call. Approving with edits isn't in the API (approve takes no body), so it's
 * offered as editing the draft in Mail, then approving.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { fmtInt } from "../../lib/format.ts"
import { BuiltPill, Empty, Time } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { isAdmin } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { SectionHead } from "./common.tsx"
import { MutationError } from "./KeySheets.tsx"
import { type Approval, agentsQuery, approvalsQuery, mcpKeysQuery } from "./queries.ts"
import "./integrations.css"

const route = getRouteApi("/_app/settings/integrations/approvals")

export type ApprovalStatus = "pending" | "approved" | "rejected" | "failed"
const STATUSES: { key: ApprovalStatus; label: string }[] = [
  { key: "pending", label: "Waiting" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "failed", label: "Failed" },
]

const WHO = "Owners and admins (or a key with the admin scope) decide held sends."

/** Names for the keys that asked: an agent's name when the key is an agent's, else the key's own name. */
function useAskers() {
  const agents = useQuery(agentsQuery)
  const keys = useQuery(mcpKeysQuery)
  const byKey = new Map<string, { name: string; agentId?: string }>()
  for (const k of keys.data?.keys ?? []) byKey.set(k.id, { name: k.name })
  for (const a of agents.data?.agents ?? []) if (a.key) byKey.set(a.key.id, { name: a.name, agentId: a.id })
  return byKey
}

export function Approvals() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const status = search.status ?? "pending"
  const me = useMe().data
  const admin = isAdmin(me)
  const q = useQuery(approvalsQuery(status))
  const askers = useAskers()
  const keep = search.fx ? { fx: search.fx } : {}
  const rejecting = search.reject ? q.data?.approvals.find((a) => a.id === search.reject) : undefined
  const waiting = status === "pending" ? (q.data?.approvals.length ?? 0) : null

  return (
    <>
      <SectionHead
        title="Agents and integrations"
        sub="Agents with their own mailboxes, and the apps that work with this workspace."
      />
      <div className="spread" style={{ marginBottom: 12, flexWrap: "wrap", gap: 12 }}>
        <Link className="link-quiet t-small" to="/settings/integrations">
          Integrations
        </Link>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
        <div className="seg" role="group" aria-label="Which sends">
          {STATUSES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={status === s.key}
              onClick={() =>
                navigate({ search: { ...keep, ...(s.key === "pending" ? {} : { status: s.key }) } })
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {admin ? null : (
        <div className="callout callout-info" style={{ marginBottom: 12 }}>
          <Icon name="lock" />
          <span>
            <b>You can see the queue but not decide it.</b> {WHO}
          </span>
        </div>
      )}
      <Panel
        id="approvals"
        title="Approval queue"
        endpoint="GET /v1/approvals?status= · POST /v1/approvals/{id}/approve|reject (built, HAL-3460)"
        query={q}
        meta={
          <span className="cluster">
            {waiting !== null && q.isSuccess ? <span>{fmtInt(waiting)} waiting</span> : null}
            <BuiltPill issue="HAL-3460" />
          </span>
        }
        isEmpty={(d) => d.approvals.length === 0}
        empty={
          status === "pending" ? (
            <Empty icon="check-circle" title="Nothing waiting">
              Agents with ‘require approval’ on hold their sends here.
            </Empty>
          ) : (
            <Empty
              icon="history"
              title={`No ${STATUSES.find((s) => s.key === status)?.label.toLowerCase()} sends`}
            >
              Decided sends are kept here with who decided and why.
            </Empty>
          )
        }
      >
        {(d) => (
          <div className="stack stack-12">
            {d.approvals.map((a) => (
              <ApprovalCard
                key={a.id}
                a={a}
                asker={askers.get(a.keyId)}
                admin={admin}
                onReject={() =>
                  navigate({
                    search: { ...keep, ...(search.status ? { status: search.status } : {}), reject: a.id },
                  })
                }
              />
            ))}
          </div>
        )}
      </Panel>
      {rejecting ? (
        <RejectSheet
          a={rejecting}
          asker={askers.get(rejecting.keyId)?.name ?? rejecting.keyId}
          onClose={() =>
            navigate({
              search: { ...keep, ...(search.status ? { status: search.status } : {}) },
              replace: true,
            })
          }
        />
      ) : null}
    </>
  )
}

function ApprovalCard({
  a,
  asker,
  admin,
  onReject,
}: {
  a: Approval
  asker: { name: string; agentId?: string } | undefined
  admin: boolean
  onReject: () => void
}) {
  const qc = useQueryClient()
  const approve = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/approvals/{id}/approve", { params: { path: { id: a.id } }, body: {} })),
    onSuccess: async (r) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["approvals"] }),
        qc.invalidateQueries({ queryKey: ["agents"] }),
      ])
      toast({
        title: r.status === "failed" ? "Approved, but the send failed" : "Approved and sent",
        sub:
          r.kind === "draft"
            ? "The draft still waits the undo window before it goes."
            : `To ${a.recipients.join(", ")}`,
        tone: r.status === "failed" ? "bad" : "ok",
      })
    },
  })
  const name = asker?.name ?? a.keyId
  const pending = a.status === "pending"
  const tool = a.kind === "draft" ? "send_draft" : "send_email"
  return (
    <article className="approval">
      <header className="spread" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="agent-name">
          {asker?.agentId ? (
            <Link to="/settings/integrations/agents/$id" params={{ id: asker.agentId }}>
              <b>{name}</b>
            </Link>
          ) : (
            <b>{name}</b>
          )}{" "}
          {pending
            ? "wants to send"
            : a.status === "approved"
              ? "sent, with approval"
              : a.status === "rejected"
                ? "was refused"
                : "was approved, but failed"}
        </span>
        <span className="t-small muted">
          <Time value={a.createdAt} /> · <span className="mono">{tool}</span>
        </span>
      </header>
      <dl className="kv">
        <dt>From</dt>
        <dd>
          {a.from ? (
            <span className="mono">{a.from}</span>
          ) : (
            <span className="muted">The deploy’s default sender</span>
          )}
        </dd>
        <dt>To</dt>
        <dd>
          <span className="mono">{a.recipients.join(", ")}</span>
        </dd>
        <dt>Subject</dt>
        <dd>{a.subject || <span className="muted">(no subject)</span>}</dd>
        {!pending ? (
          <>
            <dt>Decided</dt>
            <dd>
              <Time value={a.decidedAt} /> {a.decidedBy ? <>by {a.decidedBy}</> : null}
            </dd>
            {a.reason ? (
              <>
                <dt>Reason</dt>
                <dd>{a.reason}</dd>
              </>
            ) : null}
          </>
        ) : null}
      </dl>
      {a.kind === "draft" && a.mailboxId && a.draftId ? (
        <DraftPreview mailboxId={a.mailboxId} draftId={a.draftId} />
      ) : (
        <p className="hint">
          A transactional send keeps no stored copy until it goes, so the subject and recipients are what it
          asked to send.
        </p>
      )}
      {approve.isError ? <MutationError error={approve.error} what="It wasn’t approved" /> : null}
      {pending ? (
        <div className="cluster">
          <Gated allowed={admin} reason="You can’t approve sends" who={WHO}>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              aria-disabled={approve.isPending}
              onClick={() => !approve.isPending && approve.mutate()}
              data-endpoint={`POST /v1/approvals/${a.id}/approve`}
            >
              <Icon name="check" />
              {approve.isPending ? "Approving…" : "Approve"}
            </button>
          </Gated>
          {a.kind === "draft" && a.mailboxId ? (
            <Link
              className="btn btn-secondary btn-sm"
              to="/mail/$mailboxId"
              params={{ mailboxId: a.mailboxId }}
            >
              <Icon name="pencil" />
              Edit in Mail
            </Link>
          ) : null}
          <Gated
            allowed={false}
            reason="Approving with edits isn’t in the API"
            who="Approve takes no changes. Edit the draft in Mail, then approve it here."
          >
            <button className="btn btn-secondary btn-sm" type="button">
              Edit and approve
            </button>
          </Gated>
          <Gated allowed={admin} reason="You can’t reject sends" who={WHO}>
            <button className="btn btn-danger-ghost btn-sm" type="button" onClick={onReject}>
              Reject
            </button>
          </Gated>
        </div>
      ) : (
        <span>
          <span
            className={`pill ${a.status === "approved" ? "pill-pass" : a.status === "rejected" ? "pill-neutral" : "pill-fail"}`}
          >
            <span className="dot" />
            {a.status === "approved" ? "Approved" : a.status === "rejected" ? "Rejected" : "Failed"}
          </span>
        </span>
      )}
    </article>
  )
}

function DraftPreview({ mailboxId, draftId }: { mailboxId: string; draftId: string }) {
  const q = useQuery({
    queryKey: ["mailboxes", mailboxId, "drafts", draftId],
    queryFn: () =>
      unwrap(
        api.GET("/v1/mailboxes/{id}/drafts/{draftId}", { params: { path: { id: mailboxId, draftId } } }),
      ),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  })
  if (q.isPending) return <span className="sk sk-text" style={{ width: "80%" }} aria-hidden="true" />
  if (q.isError)
    return (
      <p className="hint">
        {q.error instanceof ApiError && q.error.status === 404
          ? "The draft is gone: it was sent, cancelled or deleted."
          : "The draft’s text didn’t load."}
      </p>
    )
  const text = q.data.bodyText.trim()
  return (
    <blockquote className="approval-preview">
      {text ? (
        text.length > 600 ? (
          `${text.slice(0, 600)}…`
        ) : (
          text
        )
      ) : (
        <span className="muted">(empty draft)</span>
      )}
    </blockquote>
  )
}

function RejectSheet({ a, asker, onClose }: { a: Approval; asker: string; onClose: () => void }) {
  const qc = useQueryClient()
  const [reason, setReason] = useState("")
  const reject = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/approvals/{id}/reject", {
          params: { path: { id: a.id } },
          body: reason.trim() ? { reason: reason.trim() } : {},
        }),
      ),
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["approvals"] }),
        qc.invalidateQueries({ queryKey: ["agents"] }),
      ])
      toast({ title: "Rejected", sub: `${asker} sees the refusal on its next call.` })
      onClose()
    },
  })
  return (
    <Sheet
      title="Reject this send?"
      sub={`${asker} → ${a.recipients.join(", ")}`}
      onClose={onClose}
      odId="approval-reject"
      endpoint={`POST /v1/approvals/${a.id}/reject { reason }`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            type="button"
            aria-disabled={reject.isPending || reason.length > 500}
            onClick={() => !reject.isPending && reason.length <= 500 && reject.mutate()}
          >
            {reject.isPending ? "Rejecting…" : "Reject send"}
          </button>
        </>
      }
    >
      <p>
        {a.kind === "draft" ? "The draft stays in its mailbox, unsent." : "Nothing is sent."} {asker} sees the
        refusal and your reason on its next call.
      </p>
      <div className={`field${reason.length > 500 ? " is-invalid" : ""}`}>
        <label className="label" htmlFor="rej-why">
          Reason <span className="opt">· the agent sees this</span>
        </label>
        <textarea
          className="textarea"
          id="rej-why"
          rows={3}
          value={reason}
          data-autofocus=""
          maxLength={600}
          onChange={(e) => setReason(e.target.value)}
          aria-describedby="rej-why-hint"
        />
        <span className={reason.length > 500 ? "field-error" : "hint"} id="rej-why-hint">
          {reason.length > 500
            ? `${reason.length - 500} characters over the 500 limit.`
            : "Optional, up to 500 characters."}
        </span>
      </div>
      {reject.isError ? <MutationError error={reject.error} what="It wasn’t rejected" /> : null}
    </Sheet>
  )
}
