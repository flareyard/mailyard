/**
 * Settings → Danger zone (design: danger, danger-admin, danger-domain-off, danger-delete-mailbox(-aliases,
 * -export, -catch-all), danger-delete-workspace; HAL-3376, HAL-3448 live).
 *
 * - Turn off a domain's mail: `PATCH /v1/domains/{id} { receiving: false, sending: false }`, typed.
 * - Delete a mailbox: `DELETE /v1/mailboxes/{id}`, typed; each 409 (`alias-targets`, `no-recent-export`,
 *   `catch-all-keeps`) gets its own sheet saying what to do first. Nothing is deleted on a refusal.
 * - Delete the workspace: `DELETE /v1/workspace { confirm }` with its name typed, owner only. An export of
 *   everything starts at once, everything goes 7 days later unless restored (`POST /v1/workspace/restore`),
 *   and `GET /v1/workspace/deletion` says where it stands.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { useMe } from "../../auth/session.ts"
import { fmtInt } from "../../lib/format.ts"
import { setDeleting } from "../../ops/deletion.ts"
import { fmtBytes, utcFull } from "../../ops/format.ts"
import { BuiltPill, Time, TypedConfirm } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { isAdmin, isOwner } from "../../ops/roles.ts"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../../ui/Panel.tsx"
import { SectionHead } from "../integrations/common.tsx"
import { MutationError } from "../integrations/KeySheets.tsx"
import { domainsQuery, type Mailbox, mailboxesQuery } from "../integrations/queries.ts"
import { countdown, exporting, latestComplete, referrers } from "./logic.ts"
import "../integrations/integrations.css"

const route = getRouteApi("/_app/settings/danger")

export type DangerSheet = "domain" | "mailbox" | "workspace"

export const deletionQuery = {
  queryKey: ["workspace", "deletion"],
  queryFn: () => unwrap(api.GET("/v1/workspace/deletion")),
}

export function DangerPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const me = useMe().data
  const owner = isOwner(me)
  const admin = isAdmin(me)
  const deletion = useQuery({ ...deletionQuery, enabled: admin })
  const scheduled = deletion.data?.status === "scheduled" || deletion.data?.status === "deleting"
  const set = (sheet?: DangerSheet, mailbox?: string) =>
    navigate({
      search: (s) => ({
        ...(s.fx ? { fx: s.fx } : {}),
        ...(sheet ? { sheet } : {}),
        ...(mailbox ? { mailbox } : {}),
      }),
      replace: !sheet,
    })
  const wsName = me?.workspace.name ?? "this workspace"

  return (
    <>
      <SectionHead title="Danger zone" sub="Things that can’t be undone, or are hard to." />
      <DeletionStatus q={deletion} owner={owner} />
      <div className="danger">
        <div className="danger-row">
          <h3>Turn off a domain’s mail</h3>
          <p>Stops routing and sending for one domain. Records stay, so it can come back.</p>
          <button className="btn btn-danger-ghost" type="button" onClick={() => set("domain")}>
            Turn off mail…
          </button>
        </div>
        <div className="danger-row">
          <h3>Delete a mailbox</h3>
          <p>Deletes its mail from R2 after an export. Aliases that point at it stop working.</p>
          <button className="btn btn-danger-ghost" type="button" onClick={() => set("mailbox")}>
            Delete a mailbox…
          </button>
        </div>
        <div className="danger-row">
          <h3>
            Delete this workspace <BuiltPill issue="HAL-3448" />
          </h3>
          <p>
            Every mailbox, contact, campaign, template, key and setting, 7 days after you ask. Your Cloudflare
            zones and domains stay yours.
          </p>
          <Gated
            allowed={owner && !scheduled}
            reason={
              scheduled ? "The workspace is already being deleted" : "Only the owner can delete the workspace"
            }
            who={
              scheduled
                ? "Restore it above to call the deletion off."
                : "Admins can do everything else here. Before anyone owns the workspace, the admin key can."
            }
            side="right"
          >
            <button
              className={`btn ${owner && !scheduled ? "btn-danger" : "btn-secondary"}`}
              type="button"
              onClick={() => set("workspace")}
            >
              Delete workspace
            </button>
          </Gated>
        </div>
      </div>
      {search.sheet === "domain" ? <DomainOffSheet onClose={() => set()} /> : null}
      {search.sheet === "mailbox" ? (
        <MailboxSheet initial={search.mailbox} onPick={(id) => set("mailbox", id)} onClose={() => set()} />
      ) : null}
      {search.sheet === "workspace" && owner && !scheduled ? (
        <WorkspaceSheet name={wsName} onClose={() => set()} />
      ) : null}
    </>
  )
}

type DeletionQ = ReturnType<typeof useQuery<Awaited<ReturnType<typeof deletionQuery.queryFn>>>>

function DeletionStatus({ q, owner }: { q: DeletionQ; owner: boolean }) {
  const qc = useQueryClient()
  const restore = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/workspace/restore", { body: {} })),
    onSuccess: async () => {
      setDeleting(null)
      await qc.invalidateQueries({ queryKey: deletionQuery.queryKey })
      toast({ title: "The workspace is restored", sub: "Nothing will be deleted. Sending works again." })
    },
  })
  if (q.isPending || q.isError || !q.data || q.data.status === "none") return null
  const d = q.data
  if (d.status === "deleted")
    return (
      <section className="panel" data-endpoint="GET /v1/workspace/deletion" aria-labelledby="h-deleted">
        <header className="panel-head">
          <h2 className="panel-title" id="h-deleted">
            This workspace was deleted
          </h2>
        </header>
        <div className="panel-body">
          <div className="stack stack-12">
            <p>
              Deleted {d.deletion?.completedAt ? <Time value={d.deletion.completedAt} mode="full" /> : null}.
              The export taken when it was asked for is kept for the owner.
            </p>
            {d.files.length ? (
              <ul className="list">
                {d.files.map((f) => (
                  <li key={f.name} className="list-row">
                    <span className="grow mono">{f.name}</span>
                    <a className="btn btn-secondary btn-sm" href={f.url} download={f.name.split("/").pop()}>
                      <Icon name="download" />
                      Download
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Only the owner sees the download links. Each works for a day.</p>
            )}
          </div>
        </div>
      </section>
    )
  const at = d.deletion?.deletesAt
  return (
    <div
      className="callout callout-warn"
      role="status"
      data-endpoint="GET /v1/workspace/deletion · POST /v1/workspace/restore"
    >
      <Icon name="octagon" />
      <span className="stack stack-8" style={{ flex: 1, minWidth: 0 }}>
        <span>
          {d.status === "deleting" ? (
            <b>The workspace is being deleted now.</b>
          ) : (
            <>
              <b>This workspace will be deleted in {at ? countdown(at) : "7 days"}</b>
              {at ? <>, on {utcFull(at)}</> : null}.
            </>
          )}{" "}
          Sending is refused (<span className="mono">409 workspace-deleting</span>) and mail still arrives.
          {d.deletion?.requestedBy ? (
            <>
              {" "}
              Asked for by {d.deletion.requestedBy}
              {d.deletion.requestedAt ? (
                <>
                  {" "}
                  <Time value={d.deletion.requestedAt} />
                </>
              ) : null}
              .
            </>
          ) : null}
        </span>
        <span className="cluster">
          {d.status === "scheduled" ? (
            <Gated
              allowed={owner}
              reason="Only the owner can restore it"
              who="The owner, or the admin key before anyone owns it."
            >
              <button
                className="btn btn-primary btn-sm"
                type="button"
                aria-disabled={restore.isPending}
                onClick={() => !restore.isPending && restore.mutate()}
                data-endpoint="POST /v1/workspace/restore"
              >
                <Icon name="undo" />
                {restore.isPending ? "Restoring…" : "Restore the workspace"}
              </button>
            </Gated>
          ) : null}
          {d.deletion?.exportId ? (
            <Link
              className="btn btn-secondary btn-sm"
              to="/settings/data"
              search={{ export: d.deletion.exportId }}
            >
              <Icon name="download" />
              The export it took
            </Link>
          ) : null}
        </span>
        {restore.isError ? <MutationError error={restore.error} what="It wasn’t restored" /> : null}
      </span>
    </div>
  )
}

function DomainOffSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const q = useQuery(domainsQuery)
  const live = (q.data?.domains ?? []).filter((d) => d.receiving || d.sending)
  const [pick, setPick] = useState("")
  const domain = live.find((d) => d.id === pick) ?? live[0]
  const off = useMutation({
    mutationFn: (id: string) =>
      unwrap(
        api.PATCH("/v1/domains/{id}", {
          params: { path: { id } },
          body: { receiving: false, sending: false },
        }),
      ),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: ["domains"] })
      toast({ title: `Mail is off for ${d.name}`, sub: "Records stay; turn it back on from Domains." })
      onClose()
    },
  })
  return (
    <Sheet
      title={domain ? `Turn off mail for ${domain.name}?` : "Turn off a domain’s mail"}
      sub={
        !domain
          ? "Choose a domain."
          : domain.receiving && domain.sending
            ? "This turns off receiving and sending."
            : domain.receiving
              ? "Sending is already off; this turns off receiving."
              : "Routing is already off; this turns off sending."
      }
      onClose={onClose}
      odId="dom-off"
      endpoint={`PATCH /v1/domains/${domain?.id ?? "{id}"} { receiving: false, sending: false }`}
    >
      {q.isPending ? (
        <PanelSkeleton rows={2} />
      ) : q.isError ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="Domains didn’t load" />
      ) : !domain ? (
        <p className="muted">No domain has mail on, so there’s nothing to turn off.</p>
      ) : (
        <>
          {live.length > 1 ? (
            <div className="field">
              <label className="label" htmlFor="dom-pick">
                Domain
              </label>
              <select
                className="select"
                id="dom-pick"
                value={domain.id}
                onChange={(e) => setPick(e.target.value)}
              >
                {live.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <ul className="consequences">
            {domain.receiving ? (
              <li>
                <Icon name="x-circle" />
                <span>
                  Mail to its {fmtInt(domain.mailboxCount)}{" "}
                  {domain.mailboxCount === 1 ? "address" : "addresses"} stops arriving.
                </span>
              </li>
            ) : null}
            {domain.sending ? (
              <li>
                <Icon name="x-circle" />
                <span>Campaigns, automations and transactional sends from it fail until it’s back on.</span>
              </li>
            ) : null}
            <li className="ok">
              <Icon name="check-circle" />
              <span>Records stay in DNS; turning it back on is instant.</span>
            </li>
          </ul>
          <TypedConfirm key={domain.id} match={domain.name}>
            {(ok) => (
              <>
                {off.isError ? <MutationError error={off.error} what="Mail wasn’t turned off" /> : null}
                <div className="cluster" style={{ justifyContent: "flex-end" }}>
                  <button className="btn btn-secondary" type="button" onClick={onClose}>
                    Cancel
                  </button>
                  <button
                    className="btn btn-danger"
                    type="button"
                    aria-disabled={!ok || off.isPending}
                    onClick={() => ok && !off.isPending && off.mutate(domain.id)}
                  >
                    {off.isPending ? "Turning off…" : "Turn off mail"}
                  </button>
                </div>
              </>
            )}
          </TypedConfirm>
        </>
      )}
    </Sheet>
  )
}

type Refusal = {
  reason: "alias-targets" | "no-recent-export" | "catch-all-keeps"
  message: string
  aliasIds: string[]
}

function MailboxSheet({
  initial,
  onPick,
  onClose,
}: {
  initial: string | undefined
  onPick: (id: string) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const q = useQuery(mailboxesQuery)
  const all = q.data?.mailboxes ?? []
  const box = all.find((m) => m.id === initial) ?? all[0]
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const exports = useQuery({
    queryKey: ["mailboxes", box?.id, "exports"],
    queryFn: () => unwrap(api.GET("/v1/mailboxes/{id}/exports", { params: { path: { id: box?.id ?? "" } } })),
    enabled: Boolean(box?.holdsMail),
  })
  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/v1/mailboxes/{id}", { params: { path: { id } } })),
    onSuccess: async (m) => {
      await qc.invalidateQueries({ queryKey: ["mailboxes"] })
      toast({ title: `Deleted ${m.address}`, sub: "Its mail is gone from R2; the export you took keeps it." })
      onClose()
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) {
        const r = e.body.reason
        if (r === "alias-targets" || r === "no-recent-export" || r === "catch-all-keeps")
          setRefusal({
            reason: r,
            message: e.message,
            aliasIds: Array.isArray(e.body.aliasIds) ? (e.body.aliasIds as string[]) : [],
          })
      }
    },
  })
  const startExport = useMutation({
    mutationFn: (id: string) => unwrap(api.POST("/v1/mailboxes/{id}/exports", { params: { path: { id } } })),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["mailboxes", box?.id, "exports"] })
      toast({ title: "Exporting the mailbox", sub: "Delete it once the export holds all its mail." })
      setRefusal(null)
    },
  })

  if (refusal && box)
    return (
      <RefusalSheet
        box={box}
        all={all}
        refusal={refusal}
        onClose={onClose}
        onExport={() => startExport.mutate(box.id)}
        exporting={startExport}
      />
    )

  const refs = box ? referrers(all, box.id) : []
  const latest = latestComplete(exports.data?.exports ?? [])
  const busy = exporting(exports.data?.exports ?? [])
  return (
    <Sheet
      title={box ? `Delete ${box.address}?` : "Delete a mailbox"}
      sub={
        box?.holdsMail ? "Export first: deleting removes the mail for good." : "It holds no mail of its own."
      }
      wide
      onClose={onClose}
      odId="del-mbx"
      endpoint={`DELETE /v1/mailboxes/${box?.id ?? "{id}"}`}
    >
      {q.isPending ? (
        <PanelSkeleton rows={3} />
      ) : q.isError ? (
        <PanelError error={q.error} onRetry={() => q.refetch()} what="Mailboxes didn’t load" />
      ) : !box ? (
        <p className="muted">There are no mailboxes to delete.</p>
      ) : (
        <>
          <div className="field">
            <label className="label" htmlFor="mbx-pick">
              Mailbox
            </label>
            <select className="select" id="mbx-pick" value={box.id} onChange={(e) => onPick(e.target.value)}>
              {all.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.address} · {m.kind.replace("_", "-")}
                </option>
              ))}
            </select>
          </div>
          <ol className="checks">
            {box.holdsMail ? (
              <li className={`chk ${latest ? "is-pass" : busy ? "is-running" : "is-waiting"}`}>
                <span className="chk-n">{latest ? <Icon name="check" /> : "1"}</span>
                <span className="chk-title">Export the mail</span>
                {latest ? (
                  <span className="pill pill-pass">
                    <span className="dot" />
                    Exported
                  </span>
                ) : busy ? (
                  <span className="pill pill-neutral">
                    <span className="spinner" aria-hidden="true" />
                    Running
                  </span>
                ) : (
                  <span className="pill pill-warn">
                    <span className="dot" />
                    Not yet
                  </span>
                )}
                <div className="chk-body">
                  {exports.isPending ? (
                    <span className="muted">Checking its exports…</span>
                  ) : latest ? (
                    <span>
                      {latest.format === "both" ? "mbox and .eml zip" : latest.format},{" "}
                      {fmtBytes(latest.size)}, finished{" "}
                      <Time value={latest.completedAt ?? latest.createdAt} />, holding{" "}
                      {fmtInt(latest.messageCount)} messages. It only counts if it holds all the mail in the
                      mailbox now; the delete checks that.{" "}
                      {latest.downloads.mbox ? (
                        <a className="link" href={latest.downloads.mbox} download>
                          Download
                        </a>
                      ) : null}
                    </span>
                  ) : (
                    <span className="cluster">
                      <span>No complete export yet. The delete is refused until one holds all its mail.</span>
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        aria-disabled={startExport.isPending || busy}
                        onClick={() => !startExport.isPending && !busy && startExport.mutate(box.id)}
                      >
                        {startExport.isPending ? "Starting…" : "Export now"}
                      </button>
                    </span>
                  )}
                </div>
              </li>
            ) : null}
            <li className="chk">
              <span className="chk-n">{box.holdsMail ? "2" : "1"}</span>
              <span className="chk-title">Confirm</span>
              <span />
              <div className="chk-body">
                <span>
                  {refs.length ? (
                    <>
                      {refs.map((r, i) => (
                        <span key={r.id}>
                          {i ? ", " : ""}
                          <span className="mono">{r.address}</span>
                        </span>
                      ))}{" "}
                      still {refs.length === 1 ? "delivers" : "deliver"} here; the delete is refused until{" "}
                      {refs.length === 1 ? "it’s" : "they’re"} changed.{" "}
                    </>
                  ) : null}
                  Mail to <span className="mono">{box.address}</span> bounces after this.
                </span>
                <TypedConfirm key={box.id} match={box.address}>
                  {(ok) => (
                    <>
                      {remove.isError &&
                      !(remove.error instanceof ApiError && remove.error.status === 409) ? (
                        <MutationError error={remove.error} what="The mailbox wasn’t deleted" />
                      ) : null}
                      <div className="cluster" style={{ justifyContent: "flex-end" }}>
                        <button className="btn btn-secondary" type="button" onClick={onClose}>
                          Cancel
                        </button>
                        <button
                          className="btn btn-danger"
                          type="button"
                          aria-disabled={!ok || remove.isPending}
                          onClick={() => ok && !remove.isPending && remove.mutate(box.id)}
                        >
                          {remove.isPending ? "Deleting…" : "Delete mailbox"}
                        </button>
                      </div>
                    </>
                  )}
                </TypedConfirm>
              </div>
            </li>
          </ol>
        </>
      )}
    </Sheet>
  )
}

function RefusalSheet({
  box,
  all,
  refusal,
  onClose,
  onExport,
  exporting: exp,
}: {
  box: Mailbox
  all: readonly Mailbox[]
  refusal: Refusal
  onClose: () => void
  onExport: () => void
  exporting: { isPending: boolean; isError: boolean; error: unknown }
}) {
  const head = {
    title: `Can’t delete ${box.address} yet`,
    sub: `DELETE /v1/mailboxes/${box.id} → 409 ${refusal.reason}`,
    onClose,
    wide: true,
    odId: "del-mbx",
  }
  if (refusal.reason === "alias-targets") {
    const aliases = refusal.aliasIds.map(
      (id) => all.find((m) => m.id === id) ?? { id, address: id, kind: "alias", targetIds: [] },
    )
    return (
      <Sheet
        {...head}
        foot={
          <>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Close
            </button>
            <Link className="btn btn-primary" to="/settings/mailboxes">
              Open mailboxes
            </Link>
          </>
        }
      >
        <p>{refusal.message}</p>
        <ul className="list">
          {aliases.map((a) => (
            <li key={a.id} className="list-row">
              <span className="grow">
                <span className="row-title mono">{a.address}</span>
                <span className="row-sub">
                  {a.kind === "group" ? "Group" : "Alias"} · delivers to{" "}
                  {a.targetIds
                    .map((t) => all.find((m) => m.id === t)?.address.split("@")[0])
                    .filter(Boolean)
                    .map((x) => `${x}@`)
                    .join(" and ") || "it"}
                </span>
              </span>
              <Link className="btn btn-secondary btn-sm" to="/settings/mailboxes/$id" params={{ id: a.id }}>
                Change its targets
              </Link>
            </li>
          ))}
        </ul>
        <p className="hint">
          Repoint each alias or group somewhere else, or delete it, then delete this mailbox. Nothing was
          deleted.
        </p>
      </Sheet>
    )
  }
  if (refusal.reason === "no-recent-export")
    return (
      <Sheet
        {...head}
        foot={
          <>
            <button className="btn btn-secondary" type="button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={exp.isPending}
              onClick={() => !exp.isPending && onExport()}
              data-endpoint={`POST /v1/mailboxes/${box.id}/exports`}
            >
              {exp.isPending ? "Starting…" : "Export now"}
            </button>
          </>
        }
      >
        <p>{refusal.message}</p>
        <ul className="consequences">
          <li>
            <Icon name="x-circle" />
            <span>
              An export only counts if it holds <b>all the mail in the mailbox now</b>. One taken before newer
              mail arrived doesn’t.
            </span>
          </li>
          <li className="ok">
            <Icon name="check-circle" />
            <span>Export now, wait for it to finish, then delete. Nothing was deleted.</span>
          </li>
        </ul>
        {exp.isError ? <MutationError error={exp.error} what="The export didn’t start" /> : null}
      </Sheet>
    )
  return (
    <Sheet
      {...head}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <Link className="btn btn-primary" to="/settings/mailboxes">
            Change the catch-all
          </Link>
        </>
      }
    >
      <p>{refusal.message}</p>
      <dl className="kv">
        <dt>Mailbox</dt>
        <dd>
          <span className="mono">{box.address}</span>
        </dd>
        <dt>Catch-all</dt>
        <dd>Keeps unknown mail here</dd>
      </dl>
      <p className="hint">
        Set the domain’s catch-all to bounce, or point it at another mailbox, then delete this one. Nothing
        was deleted.
      </p>
    </Sheet>
  )
}

function WorkspaceSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const qc = useQueryClient()
  const boxes = useQuery(mailboxesQuery)
  const domains = useQuery(domainsQuery)
  const del = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/workspace", { body: { confirm: name } })),
    onSuccess: async (d) => {
      setDeleting(Number(d.deletesAt))
      await qc.invalidateQueries({ queryKey: deletionQuery.queryKey })
      toast(
        {
          title: `${name} will be deleted in 7 days`,
          sub: "An export of everything has started. Restore any time before then.",
        },
        8000,
      )
      onClose()
    },
  })
  const nBoxes = boxes.data?.mailboxes.filter((m) => m.holdsMail).length
  const nDomains = domains.data?.domains.length
  return (
    <Sheet
      title={`Delete the ${name} workspace?`}
      sub="Everything goes in 7 days, unless you restore it."
      onClose={onClose}
      odId="del-ws"
      endpoint="DELETE /v1/workspace { confirm } (built, HAL-3448)"
    >
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            {nBoxes !== undefined
              ? `${fmtInt(nBoxes)} ${nBoxes === 1 ? "mailbox" : "mailboxes"} and their mail`
              : "Every mailbox and its mail"}
            , every contact, campaign, automation, template, API key and webhook, 7 days from now.
          </span>
        </li>
        <li>
          <Icon name="x-circle" />
          <span>
            Sending stops at once: every send answers <span className="mono">409 workspace-deleting</span>.
            Mail still arrives until the end.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>An export of everything starts now, and its files outlive the deletion.</span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            {nDomains !== undefined
              ? `Your ${fmtInt(nDomains)} ${nDomains === 1 ? "domain" : "domains"}`
              : "Your domains"}
            , DNS records and Cloudflare account are untouched.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>Until then, Restore on this page calls it off.</span>
        </li>
      </ul>
      <TypedConfirm match={name}>
        {(ok) => (
          <>
            {del.isError ? (
              <MutationError error={del.error} what="The workspace wasn’t scheduled for deletion" />
            ) : null}
            <div className="cluster" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                type="button"
                aria-disabled={!ok || del.isPending}
                onClick={() => ok && !del.isPending && del.mutate()}
              >
                {del.isPending ? "Deleting…" : "Delete workspace"}
              </button>
            </div>
          </>
        )}
      </TypedConfirm>
    </Sheet>
  )
}
