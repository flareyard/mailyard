/**
 * Invite someone (design: members-invite.html; HAL-3361). Step 1 collects email, role, the shared mailboxes
 * with their access and an optional note, and POST /v1/invites makes a draft. Step 2 shows that draft email
 * exactly as it will arrive (rendered in a sandboxed frame) and sends it with POST /v1/invites/{id}/send.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { ROLE_LABEL, ROLE_SUMMARY } from "../../first-run/roles.ts"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { ACCESS_LABEL, looksLikeEmail } from "../logic.ts"
import { ApiRefusal } from "../mailboxes/CreateMailbox.tsx"
import { mailboxesQuery, membersQuery } from "../queries.ts"

type InviteRole = "admin" | "sender" | "agent" | "viewer"
type Access = "owner" | "member" | "viewer"
const ROLES: InviteRole[] = ["admin", "sender", "agent", "viewer"]

type Created = Awaited<ReturnType<typeof createDraft>>
const createDraft = (b: {
  email: string
  role: InviteRole
  mailboxes: { mailboxId: string; access: Access }[]
  message: string
}) =>
  unwrap(
    api.POST("/v1/invites", {
      body: {
        email: b.email.trim(),
        role: b.role,
        mailboxes: b.mailboxes,
        ...(b.message.trim() ? { message: b.message.trim() } : {}),
      },
    }),
  )

export function InviteSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const boxes = useQuery(mailboxesQuery)
  const holders = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<InviteRole>("sender")
  const [access, setAccess] = useState<Record<string, Access | "">>({})
  const [message, setMessage] = useState("")
  const [emailError, setEmailError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Created | null>(null)
  const chosen = Object.entries(access).filter(([, a]) => a) as [string, Access][]

  const make = useMutation({
    mutationFn: () =>
      createDraft({
        email,
        role,
        mailboxes: chosen.map(([mailboxId, a]) => ({ mailboxId, access: a })),
        message,
      }),
    onSuccess: (d) => {
      setDraft(d)
      qc.invalidateQueries({ queryKey: membersQuery.queryKey })
    },
  })
  const send = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST("/v1/invites/{id}/send", { params: { path: { id } }, body: null })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersQuery.queryKey })
      toast({ title: `Invite sent to ${draft?.invite.email}`, sub: "The link works for 7 days" })
      onClose()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!looksLikeEmail(email)) {
      setEmailError("Enter the email address they’ll sign in with.")
      return
    }
    setEmailError(null)
    make.mutate()
  }

  if (draft)
    return (
      <Sheet
        title="Check the invite, then send it"
        sub="Saved as a draft. Nothing has been sent yet."
        wide
        onClose={onClose}
        odId="invite-preview-sheet"
        foot={
          <>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                toast({
                  title: `Invite to ${draft.invite.email} kept as a draft`,
                  sub: "Send it from Pending invites",
                })
                onClose()
              }}
            >
              Keep as draft
            </button>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => send.mutate(draft.invite.id)}
              disabled={send.isPending}
              data-autofocus=""
              data-endpoint={`POST /v1/invites/${draft.invite.id}/send`}
            >
              <Icon name="send" />
              {send.isPending ? "Sending…" : "Send invite"}
            </button>
          </>
        }
      >
        <dl className="kv">
          <dt>From</dt>
          <dd>
            <span className="mono">{draft.draft.from ?? "The workspace’s system sender"}</span>
          </dd>
          <dt>To</dt>
          <dd>
            <span className="mono">{draft.draft.to}</span>
          </dd>
          <dt>Subject</dt>
          <dd>{draft.draft.subject}</dd>
          <dt>Role</dt>
          <dd>{ROLE_LABEL[draft.invite.role]}</dd>
        </dl>
        <iframe className="st-preview-html" title="The invite email" sandbox="" srcDoc={draft.draft.html} />
        {send.isError ? <ApiRefusal error={send.error} /> : null}
      </Sheet>
    )

  return (
    <Sheet
      title="Invite someone"
      sub="They get an email with a link that works for 7 days."
      wide
      onClose={onClose}
      odId="invite-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="submit"
            form="invite-form"
            disabled={make.isPending}
            data-endpoint="POST /v1/invites { email, role, mailboxes, message }"
          >
            <Icon name="arrow-right" />
            {make.isPending ? "Preparing…" : "Preview the invite"}
          </button>
        </>
      }
    >
      <form id="invite-form" className="stack stack-16" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor="inv-email">
            Email
          </label>
          <input
            className="input mono"
            id="inv-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            data-autofocus=""
            aria-invalid={emailError ? true : undefined}
            aria-describedby={emailError ? "inv-email-err" : undefined}
          />
          {emailError ? (
            <span className="field-error" id="inv-email-err">
              <Icon name="x-circle" />
              {emailError}
            </span>
          ) : null}
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Role
          </legend>
          <div className="pick-grid">
            {ROLES.map((r) => (
              <label key={r} className={`pick${role === r ? " is-on" : ""}`}>
                <input
                  type="radio"
                  name="role"
                  checked={role === r}
                  onChange={() => setRole(r)}
                  style={{ width: 16, height: 16 }}
                />
                <span className="p-name">{ROLE_LABEL[r]}</span>
                <span className="p-sub">{ROLE_SUMMARY[r].can[0]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Mailboxes they can open
          </legend>
          {holders.length ? (
            holders.map((h) => (
              <div key={h.id} className="spread" style={{ gap: 8 }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(access[h.id])}
                    onChange={(e) => setAccess({ ...access, [h.id]: e.target.checked ? "member" : "" })}
                  />
                  <span className="mono">{h.address}</span>
                </label>
                {access[h.id] ? (
                  <select
                    className="select"
                    style={{ height: 32, width: "auto", maxWidth: "100%" }}
                    aria-label={`Access to ${h.address}`}
                    value={access[h.id] || "member"}
                    onChange={(e) => setAccess({ ...access, [h.id]: e.target.value as Access })}
                  >
                    {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => (
                      <option key={a} value={a}>
                        {ACCESS_LABEL[a]}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            ))
          ) : (
            <span className="hint">No mailboxes yet.</span>
          )}
          {role === "admin" ? (
            <span className="hint">
              Admins open every mailbox; these only set what shows in their sidebar.
            </span>
          ) : null}
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="inv-msg">
            A note <span className="opt">· optional, shown in the email</span>
          </label>
          <textarea
            className="textarea"
            id="inv-msg"
            rows={2}
            maxLength={500}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
        </div>
        {make.isError ? <ApiRefusal error={make.error} /> : null}
      </form>
    </Sheet>
  )
}
