/**
 * Settings → Members and roles (design: members, members-admin, members-invite; HAL-3361, live). People and
 * their roles, pending invites (draft, sent, expired) with send, resend and withdraw, the role matrix, and
 * transfer of ownership (owner only). Invites are made as a draft first: the sheet shows the email before it goes.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi } from "@tanstack/react-router"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated, roleRefusal, whoCan } from "../../auth/NoPermission.tsx"
import { meQuery, type Role, useMe } from "../../auth/session.ts"
import { ROLE_LABEL, ROLE_SUMMARY } from "../../first-run/roles.ts"
import { BuiltPill, Time, TypedConfirm } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { isAdmin, isOwner } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { inviteStatus, shortAddresses } from "../logic.ts"
import { ApiRefusal } from "../mailboxes/CreateMailbox.tsx"
import { type Invite, type Member, membersQuery } from "../queries.ts"
import { Initials, SectionHead } from "../ui.tsx"
import { InviteSheet } from "./InviteSheet.tsx"

const route = getRouteApi("/_app/settings/members")
const ASSIGNABLE: Exclude<Role, "owner">[] = ["admin", "sender", "agent", "viewer"]

export function MembersPage() {
  const { invite } = route.useSearch()
  const navigate = route.useNavigate()
  const me = useMe()
  const q = useQuery(membersQuery)
  const admin = isAdmin(me.data)
  const owner = isOwner(me.data)
  const setInvite = (open: boolean) =>
    navigate({
      search: ({ invite: _i, ...rest }) => (open ? { ...rest, invite: 1 as const } : rest),
      replace: true,
    })
  const myRole = me.data?.role ?? null
  return (
    <>
      <SectionHead
        title="Members and roles"
        sub="People in this workspace, and what each can do."
        actions={
          <Gated allowed={admin} reason="You can’t invite people" who="Owners and admins can invite.">
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => setInvite(true)}
              data-endpoint="POST /v1/invites → draft · POST /v1/invites/{id}/send"
            >
              <Icon name="user-plus" />
              Invite
            </button>
          </Gated>
        }
      />
      <Panel
        id="members"
        title="Members"
        endpoint="GET /v1/members · PATCH /v1/members/{id} · DELETE /v1/members/{id} · POST /v1/workspace/transfer (built, HAL-3361)"
        query={q}
        meta={
          <>
            {q.data ? `${q.data.members.length} ${q.data.members.length === 1 ? "person" : "people"}` : null}{" "}
            <BuiltPill issue="HAL-3361" />
          </>
        }
      >
        {(d) => (
          <MembersTable members={d.members} meId={me.data?.user?.id ?? null} admin={admin} owner={owner} />
        )}
      </Panel>
      <div className="split-2">
        <div className="stack">
          <InvitesPanel invites={q.data?.invites ?? []} loading={q.isPending} admin={admin} />
        </div>
        <div className="stack">
          <section
            className="panel"
            data-endpoint="static: the role matrix (HAL-3361)"
            data-od-id="panel-roles"
            aria-labelledby="h-roles"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-roles">
                What each role can do
              </h2>
              <div className="cluster" />
            </header>
            <div className="panel-body">
              <table className="roles-table">
                <tbody>
                  {(Object.keys(ROLE_SUMMARY) as Role[]).map((r) => (
                    <tr key={r} className={r === myRole ? "is-mine" : ""}>
                      <td>{ROLE_LABEL[r]}</td>
                      <td>{ROLE_SUMMARY[r].table}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
      {invite ? <InviteSheet onClose={() => setInvite(false)} /> : null}
    </>
  )
}

function MembersTable({
  members,
  meId,
  admin,
  owner,
}: {
  members: Member[]
  meId: string | null
  admin: boolean
  owner: boolean
}) {
  const qc = useQueryClient()
  const [removing, setRemoving] = useState<Member | null>(null)
  const [transferring, setTransferring] = useState<Member | null>(null)
  const role = useMutation({
    mutationFn: ({ m, role }: { m: Member; role: Exclude<Role, "owner"> }) =>
      unwrap(api.PATCH("/v1/members/{id}", { params: { path: { id: m.id } }, body: { role } })),
    onMutate: ({ m, role: r }) => {
      const prev = qc.getQueryData(membersQuery.queryKey)
      qc.setQueryData(membersQuery.queryKey, (d) =>
        d ? { ...d, members: d.members.map((x) => (x.id === m.id ? { ...x, role: r } : x)) } : d,
      )
      return { prev }
    },
    onSuccess: (_, v) =>
      toast({
        title: `${v.m.name} is now ${ROLE_LABEL[v.role].toLowerCase() === "admin" ? "an admin" : `a ${ROLE_LABEL[v.role].toLowerCase()}`}`,
      }),
    onError: (e, v, ctx) => {
      if (ctx?.prev) qc.setQueryData(membersQuery.queryKey, ctx.prev)
      const byRole = roleRefusal(e)
      toast({
        title: `${v.m.name}’s role didn’t change`,
        sub: byRole
          ? whoCan(byRole.allowedRoles, "change roles")
          : e instanceof Error
            ? e.message
            : undefined,
        tone: "bad",
      })
    },
    onSettled: () => qc.invalidateQueries({ queryKey: membersQuery.queryKey }),
  })
  return (
    <>
      <table className="rtable">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>Mailboxes they read</th>
            <th>Last active</th>
            <th>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isOwnerRow = m.role === "owner"
            const you = m.id === meId
            return (
              <tr key={m.id}>
                <td className="is-head">
                  <span className="person">
                    <Initials name={m.name} />
                    <span className="p-meta">
                      <span className="p-name">
                        {m.name}
                        {you ? " · you" : ""}
                      </span>
                      <span className="p-mail">{m.email}</span>
                    </span>
                  </span>
                </td>
                <td data-label="Role">
                  {isOwnerRow ? (
                    <span className="role-pill is-owner">Owner</span>
                  ) : (
                    <Gated allowed={admin} reason="You can’t change roles" who="Owners and admins can.">
                      <select
                        className="select"
                        style={{ height: 36, width: "auto" }}
                        aria-label={`Role for ${m.name}`}
                        value={m.role}
                        onChange={(e) => role.mutate({ m, role: e.target.value as Exclude<Role, "owner"> })}
                        data-endpoint={`PATCH /v1/members/${m.id} { role }`}
                      >
                        {ASSIGNABLE.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </Gated>
                  )}
                </td>
                <td data-label="Mailboxes">
                  <span className="mono t-small">{shortAddresses(m.mailboxes.map((b) => b.address))}</span>
                </td>
                <td data-label="Last active">
                  {m.lastActiveAt ? (
                    <Time value={m.lastActiveAt as number} />
                  ) : (
                    <span className="muted">Not yet</span>
                  )}
                </td>
                <td className="actions">
                  {isOwnerRow ? (
                    <Gated
                      allowed={false}
                      reason="The owner can’t be removed"
                      who="Transfer ownership first. Only the owner can do that."
                      side="right"
                    >
                      <button className="btn btn-ghost btn-sm" type="button">
                        <Icon name="lock" />
                        Remove
                      </button>
                    </Gated>
                  ) : (
                    <>
                      <Gated
                        allowed={owner}
                        reason="Only the owner can hand over ownership"
                        who="The owner can make another member the owner."
                        side="right"
                      >
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => setTransferring(m)}
                          data-endpoint="POST /v1/workspace/transfer { memberId }"
                        >
                          Make owner
                        </button>
                      </Gated>
                      <Gated
                        allowed={admin}
                        reason="You can’t remove people"
                        who="Owners and admins can."
                        side="right"
                      >
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          onClick={() => setRemoving(m)}
                          aria-label={`Remove ${m.name}`}
                          data-endpoint={`DELETE /v1/members/${m.id}`}
                        >
                          Remove
                        </button>
                      </Gated>
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {removing ? <RemoveSheet m={removing} onClose={() => setRemoving(null)} /> : null}
      {transferring ? <TransferSheet m={transferring} onClose={() => setTransferring(null)} /> : null}
    </>
  )
}

function RemoveSheet({ m, onClose }: { m: Member; onClose: () => void }) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/members/{id}", { params: { path: { id: m.id } } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersQuery.queryKey })
      qc.invalidateQueries({ queryKey: ["mailboxes"] })
      toast({ title: `Removed ${m.name}`, sub: "Their sessions ended and their mailbox access is gone" })
      onClose()
    },
  })
  return (
    <Sheet
      title={`Remove ${m.name}?`}
      sub={m.email}
      onClose={onClose}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose} data-autofocus="">
            Cancel
          </button>
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => del.mutate()}
            disabled={del.isPending}
          >
            {del.isPending ? "Removing…" : "Remove from Coursified"}
          </button>
        </>
      }
    >
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            Their sessions end and they lose access to{" "}
            {m.mailboxes.length ? shortAddresses(m.mailboxes.map((b) => b.address)) : "the workspace"}.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            Mail they sent, drafts they saved and the audit log stay. You can invite them again later.
          </span>
        </li>
      </ul>
      {del.isError ? <ApiRefusal error={del.error} /> : null}
    </Sheet>
  )
}

function TransferSheet({ m, onClose }: { m: Member; onClose: () => void }) {
  const qc = useQueryClient()
  const go = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/workspace/transfer", { body: { memberId: m.id } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: membersQuery.queryKey })
      qc.invalidateQueries({ queryKey: meQuery.queryKey })
      toast({ title: `${m.name} is now the owner`, sub: "You’re an admin" })
      onClose()
    },
  })
  return (
    <Sheet title={`Make ${m.name} the owner?`} sub="POST /v1/workspace/transfer" onClose={onClose}>
      <ul className="consequences">
        <li>
          <Icon name="refresh" />
          <span>
            {m.name} becomes the owner: the only one who can delete the workspace or hand ownership on. You
            become an admin.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>Nothing else changes: mailboxes, keys and settings stay as they are.</span>
        </li>
      </ul>
      <TypedConfirm
        match={m.email}
        label={
          <>
            Type <code>{m.email}</code> to confirm
          </>
        }
      >
        {(ok) => (
          <div className="cluster" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              type="button"
              aria-disabled={!ok || go.isPending ? true : undefined}
              onClick={() => ok && !go.isPending && go.mutate()}
            >
              {go.isPending ? "Transferring…" : "Transfer ownership"}
            </button>
          </div>
        )}
      </TypedConfirm>
      {go.isError ? <ApiRefusal error={go.error} /> : null}
    </Sheet>
  )
}

function InvitesPanel({ invites, loading, admin }: { invites: Invite[]; loading: boolean; admin: boolean }) {
  const qc = useQueryClient()
  const open = invites.filter((i) => i.status === "draft" || i.status === "sent" || i.status === "expired")
  const act = useMutation({
    mutationFn: ({ i, kind }: { i: Invite; kind: "send" | "resend" | "revoke" }) =>
      kind === "revoke"
        ? unwrap(api.DELETE("/v1/invites/{id}", { params: { path: { id: i.id } } }))
        : kind === "send"
          ? unwrap(api.POST("/v1/invites/{id}/send", { params: { path: { id: i.id } }, body: null }))
          : unwrap(api.POST("/v1/invites/{id}/resend", { params: { path: { id: i.id } }, body: null })),
    onSuccess: (_, { i, kind }) => {
      qc.invalidateQueries({ queryKey: membersQuery.queryKey })
      toast({
        title: kind === "revoke" ? `Withdrew the invite to ${i.email}` : `Sent the invite to ${i.email}`,
        sub: kind === "revoke" ? "Its link no longer works" : "The link works for 7 days",
      })
    },
    onError: (e, { i }) =>
      toast({
        title: `Nothing changed for ${i.email}`,
        sub: e instanceof Error ? e.message : undefined,
        tone: "bad",
      }),
  })
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/members → invites · POST /v1/invites/{id}/send|resend · DELETE /v1/invites/{id} (built, HAL-3361)"
      data-od-id="panel-invites"
      aria-labelledby="h-invites"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-invites">
          Pending invites
        </h2>
        <div className="cluster">
          {open.length ? <span className="panel-meta">{open.length}</span> : null}
        </div>
      </header>
      <div className="panel-body">
        {loading ? (
          <span className="sk sk-text" style={{ width: "70%" }} />
        ) : !open.length ? (
          <p className="muted t-small">
            No invites waiting. Invite someone and their invite shows here until they accept it.
          </p>
        ) : (
          <table className="rtable">
            <thead>
              <tr>
                <th>Invited</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {open.map((i) => {
                const st = inviteStatus(i)
                const busy = act.isPending && act.variables?.i.id === i.id
                const sendKind = i.status === "draft" ? "send" : "resend"
                return (
                  <tr key={i.id}>
                    <td className="is-head">
                      <div className="cell-main">
                        <span className="mono" style={{ color: "var(--my-fg)" }}>
                          {i.email}
                        </span>
                        <span className="cell-sub">
                          {ROLE_LABEL[i.role]} · by {i.invitedBy ?? "someone"} ·{" "}
                          <Time value={i.createdAt as number} />
                        </span>
                      </div>
                    </td>
                    <td className="actions nowrap">
                      <Gated allowed={admin} reason="You can’t send invites" who="Owners and admins can.">
                        <button
                          className="btn btn-ghost btn-sm"
                          type="button"
                          disabled={busy}
                          onClick={() => act.mutate({ i, kind: sendKind })}
                          data-endpoint={`POST /v1/invites/${i.id}/${sendKind}`}
                        >
                          <Icon name="send" />
                          {i.status === "draft" ? "Send" : st.label === "Expired" ? "Send again" : "Resend"}
                        </button>
                      </Gated>
                      <Gated allowed={admin} reason="You can’t withdraw invites" who="Owners and admins can.">
                        <button
                          className="btn btn-danger-ghost btn-sm"
                          type="button"
                          disabled={busy}
                          onClick={() => act.mutate({ i, kind: "revoke" })}
                          aria-label={`Withdraw the invite to ${i.email}`}
                          data-endpoint={`DELETE /v1/invites/${i.id}`}
                        >
                          Revoke
                        </button>
                      </Gated>
                    </td>
                    <td className="is-aside">
                      <span className={`pill pill-${st.tone}`}>
                        <span className="dot" />
                        {st.label}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
