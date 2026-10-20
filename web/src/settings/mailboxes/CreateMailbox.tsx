/**
 * New mailbox (design: mailbox-create, -conflict, -conflict-drop, -created, -created-catch-all,
 * -created-replaced, -created-zone-token; HAL-3378). POST /v1/mailboxes; a 409 `routing-rule-exists` shows
 * Cloudflare's rule and offers to repoint it (`replaceRoutingRule: true`); the 200 says what `routing` found.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type FormEvent, useEffect, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { Sheet } from "../../ops/Overlay.tsx"
import { Icon } from "../../ui/icons.tsx"
import { RequestId } from "../../ui/Panel.tsx"
import { KIND_LABEL, type MailboxKind, mailboxAddress } from "../logic.ts"
import { domainsQuery, type MailboxSummary, mailboxesQuery } from "../queries.ts"

type Created = Awaited<ReturnType<typeof create>>
type Conflict = { message: string; destination: string | null; action: string | null; ruleId: string | null }
type Draft = { local: string; domain: string; kind: MailboxKind; displayName: string; targets: string[] }

const KINDS: MailboxKind[] = ["user", "shared", "group", "alias", "catch_all"]
const create = (d: Draft, replace: boolean) =>
  unwrap(
    api.POST("/v1/mailboxes", {
      body: {
        address: mailboxAddress(d.local, d.domain, d.kind),
        kind: d.kind,
        ...(d.displayName.trim() ? { displayName: d.displayName.trim() } : {}),
        ...(d.kind === "group" || d.kind === "alias" || d.kind === "catch_all" ? { targets: d.targets } : {}),
        ...(replace ? { replaceRoutingRule: true } : {}),
      },
    }),
  )

export function conflictOf(e: unknown): Conflict | null {
  if (!(e instanceof ApiError) || e.status !== 409 || e.body.reason !== "routing-rule-exists") return null
  const s = (k: string) => (typeof e.body[k] === "string" ? (e.body[k] as string) : null)
  return {
    message: e.message,
    destination: s("ruleDestination"),
    action: s("ruleAction"),
    ruleId: s("ruleId"),
  }
}

export function CreateMailbox({
  onClose,
  initialKind = "shared",
  autoSubmit = false,
}: {
  onClose: () => void
  initialKind?: MailboxKind
  /** Fixture mode: submit the sample draft at once, so a designed result is reachable by URL. */
  autoSubmit?: boolean
}) {
  const qc = useQueryClient()
  const domains = useQuery(domainsQuery)
  const boxes = useQuery(mailboxesQuery)
  const receiving = (domains.data?.domains ?? []).filter((d) => d.receiving)
  const domainNames = (receiving.length ? receiving : (domains.data?.domains ?? [])).map((d) => d.name)
  const [draft, setDraft] = useState<Draft>(() => ({
    local: autoSubmit ? "admissions" : "",
    domain: "",
    kind: initialKind,
    displayName: autoSubmit ? "Coursified admissions" : "",
    targets: [],
  }))
  const domain = draft.domain || domainNames[0] || ""
  const d = { ...draft, domain }
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [created, setCreated] = useState<{ box: Created; replacedFrom: string | null } | null>(null)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const holders = (boxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const needsTargets = d.kind === "group" || d.kind === "alias" || d.kind === "catch_all"

  const m = useMutation({
    mutationFn: ({ replace }: { replace: boolean }) => create(d, replace),
    onSuccess: (box, { replace }) => {
      setCreated({ box, replacedFrom: replace ? (conflict?.destination ?? null) : null })
      setConflict(null)
      qc.invalidateQueries({ queryKey: mailboxesQuery.queryKey })
      qc.invalidateQueries({ queryKey: ["identities"] })
    },
    onError: (e) => {
      const c = conflictOf(e)
      if (c) setConflict(c)
    },
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    if (d.kind !== "catch_all" && !/^[a-z0-9._+-]+$/i.test(d.local.trim())) {
      setFieldError("Use letters, numbers, dots, dashes, plus or underscores before the @.")
      return
    }
    if (!domain) {
      setFieldError("Add a domain first, in Domains.")
      return
    }
    if (needsTargets && !d.targets.length) {
      setFieldError(`A ${KIND_LABEL[d.kind].toLowerCase()} needs at least one mailbox to deliver to.`)
      return
    }
    setFieldError(null)
    m.mutate({ replace: false })
  }

  const fired = useRef(false)
  useEffect(() => {
    if (!autoSubmit || fired.current || !domain) return
    fired.current = true
    m.mutate({ replace: false })
  }, [autoSubmit, domain, m])

  if (created) return <CreatedSheet box={created.box} replacedFrom={created.replacedFrom} onClose={onClose} />
  if (conflict)
    return (
      <ConflictSheet
        address={mailboxAddress(d.local, d.domain, d.kind)}
        conflict={conflict}
        busy={m.isPending}
        error={m.isError && !conflictOf(m.error) ? m.error : null}
        onCancel={onClose}
        onReplace={() => m.mutate({ replace: true })}
      />
    )

  const other = m.isError && !conflictOf(m.error) ? (m.error as unknown) : null
  return (
    <Sheet
      title="New mailbox"
      sub="POST /v1/mailboxes"
      wide
      onClose={onClose}
      odId="mailbox-create-sheet"
      endpoint="POST /v1/mailboxes"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="mb-create" disabled={m.isPending}>
            <Icon name="plus" />
            {m.isPending ? "Creating…" : "Create mailbox"}
          </button>
        </>
      }
    >
      <form id="mb-create" className="stack stack-16" onSubmit={submit} noValidate>
        <div className="field">
          <label className="label" htmlFor="mb-local">
            Address
          </label>
          <div className="input-group">
            <input
              className="input mono"
              id="mb-local"
              value={d.kind === "catch_all" ? "*" : d.local}
              disabled={d.kind === "catch_all"}
              onChange={(e) => setDraft({ ...draft, local: e.target.value })}
              autoComplete="off"
              data-autofocus=""
              aria-invalid={fieldError ? true : undefined}
              aria-describedby={fieldError ? "mb-err" : undefined}
            />
            <span className="addon">@</span>
            <select
              className="select"
              aria-label="Domain"
              style={{ width: "auto", minWidth: 0 }}
              value={domain}
              onChange={(e) => setDraft({ ...draft, domain: e.target.value })}
            >
              {domainNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          {fieldError ? (
            <span className="field-error" id="mb-err">
              <Icon name="x-circle" />
              {fieldError}
            </span>
          ) : null}
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Kind
          </legend>
          {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
          <div className="seg st-seg-wrap" role="group" aria-label="Mailbox kind">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={d.kind === k}
                onClick={() => setDraft({ ...draft, kind: k })}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </fieldset>
        {needsTargets ? (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 6 }}>
              Delivers to
            </legend>
            {holders.map((h) => (
              <label key={h.id} className="check">
                <input
                  type="checkbox"
                  checked={d.targets.includes(h.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      targets: e.target.checked
                        ? [...draft.targets, h.id]
                        : draft.targets.filter((t) => t !== h.id),
                    })
                  }
                />
                <span className="mono">{h.address}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="field">
          <label className="label" htmlFor="mb-name">
            Display name <span className="opt">· optional</span>
          </label>
          <input
            className="input"
            id="mb-name"
            value={d.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
          />
        </div>
        <p className="hint">
          Mailyard looks for an Email Routing rule that already handles this address only when a zone token is
          connected. Without one, the mailbox is created and Mailyard says it couldn’t check.
        </p>
        {other ? <ApiRefusal error={other} /> : null}
      </form>
    </Sheet>
  )
}

export function ApiRefusal({ error }: { error: unknown }) {
  const e = error instanceof ApiError ? error : null
  return (
    <div className="callout callout-error" role="alert">
      <Icon name="x-circle" />
      <span>
        <b>{e ? `Not saved (${e.status}).` : "Mailyard couldn’t be reached."}</b>{" "}
        {e?.message ?? "Check your connection and try again."}{" "}
        {e?.requestId ? <RequestId id={e.requestId} /> : null}
      </span>
    </div>
  )
}

function ConflictSheet({
  address,
  conflict,
  busy,
  error,
  onCancel,
  onReplace,
}: {
  address: string
  conflict: Conflict
  busy: boolean
  error: unknown
  onCancel: () => void
  onReplace: () => void
}) {
  const action = conflict.action ?? "forward"
  const dropped = action === "drop"
  return (
    <Sheet
      title="This address is already routed"
      sub="POST /v1/mailboxes → 409 routing-rule-exists"
      wide
      onClose={onCancel}
      odId="mailbox-conflict-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={onReplace}
            disabled={busy}
            data-autofocus=""
          >
            <Icon name="refresh" />
            {busy ? "Repointing…" : "Point it at Mailyard instead"}
          </button>
        </>
      }
    >
      <p>{conflict.message}</p>
      <dl className="kv" data-od-id="routing-rule">
        <dt>Address</dt>
        <dd>
          <span className="mono">{address}</span>
        </dd>
        <dt>Cloudflare’s rule</dt>
        <dd>
          {action.charAt(0).toUpperCase() + action.slice(1)} <span className="tag">{action}</span>
        </dd>
        <dt>Sends it to</dt>
        <dd>
          {dropped ? (
            <span className="muted">Nowhere: the mail is dropped</span>
          ) : (
            <span className="mono">{conflict.destination ?? "—"}</span>
          )}
        </dd>
        {conflict.ruleId ? (
          <>
            <dt>Rule</dt>
            <dd>
              <span className="mono">{conflict.ruleId.slice(0, 12)}…</span> in Email Routing
            </dd>
          </>
        ) : null}
      </dl>
      <ul className="consequences">
        <li>
          <Icon name="refresh" />
          <span>
            <b>Point it at Mailyard instead</b> changes that rule, so new mail to{" "}
            <span className="mono">{address}</span> lands here
            {dropped || !conflict.destination ? "." : ` and stops reaching ${conflict.destination}.`}
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>Nothing is created until you choose. Cancel leaves Cloudflare’s rule as it is.</span>
        </li>
      </ul>
      <p className="hint">Repointing needs the zone token with Email Routing Rules: Edit.</p>
      {error ? <ApiRefusal error={error} /> : null}
    </Sheet>
  )
}

function CreatedSheet({
  box,
  replacedFrom,
  onClose,
}: {
  box: Created
  replacedFrom: string | null
  onClose: () => void
}) {
  const catchAll = box.kind === "catch_all"
  return (
    <Sheet
      title="Mailbox created"
      sub="POST /v1/mailboxes → 200"
      wide
      onClose={onClose}
      odId="mailbox-created-sheet"
      foot={
        <>
          <Link
            className="btn btn-secondary"
            to="/settings/mailboxes/$id"
            params={{ id: box.id }}
            onClick={onClose}
          >
            Open its settings
          </Link>
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            <Icon name="check" />
            Done
          </button>
        </>
      }
    >
      <RoutingNote routing={box.routing} catchAll={catchAll} replacedFrom={replacedFrom} />
      <dl className="kv">
        <dt>Address</dt>
        <dd>
          <span className="mono">{box.address}</span>
        </dd>
        <dt>Kind</dt>
        <dd>{KIND_LABEL[box.kind]}</dd>
        <dt>Routing</dt>
        <dd>
          <span className="tag">{box.routing}</span>
        </dd>
      </dl>
      <p className="hint">Next: add members, set a signature, or send it a test from another address.</p>
    </Sheet>
  )
}

/** What `routing` means (ops_settings.routing_note): only `clear` is green; `unchecked` is the production default. */
export function RoutingNote({
  routing,
  catchAll,
  replacedFrom,
}: {
  routing: "clear" | "replaced" | "unchecked"
  catchAll: boolean
  replacedFrom: string | null
}) {
  if (routing === "clear")
    return (
      <div className="callout callout-ok" role="status" data-od-id="routing-clear">
        <Icon name="check-circle" />
        <span>
          <b>Routing is clear.</b> No other Email Routing rule handles this address.
        </span>
      </div>
    )
  if (routing === "replaced")
    return (
      <div className="callout callout-info" role="status" data-od-id="routing-replaced">
        <Icon name="refresh" />
        <span>
          <b>Cloudflare’s rule now points here.</b>{" "}
          {replacedFrom && replacedFrom !== "drop" ? (
            <>
              It used to forward to <span className="mono">{replacedFrom}</span>; new mail to this address
              comes to Mailyard instead.
            </>
          ) : (
            "New mail to this address comes to Mailyard instead."
          )}
        </span>
      </div>
    )
  return (
    <div className="callout callout-warn" role="status" data-od-id="routing-unchecked">
      <Icon name="warn" />
      <span>
        <b>
          {catchAll
            ? "Couldn’t check Cloudflare’s routing."
            : "Couldn’t check Cloudflare’s routing (no zone token)."}
        </b>{" "}
        {catchAll
          ? "Mailyard never checks routing for a catch-all."
          : "There’s no zone token (CLOUDFLARE_DNS_TOKEN), so Mailyard couldn’t see whether an Email Routing rule already sends this address elsewhere."}{" "}
        If one does, its mail won’t reach this mailbox: check Email Routing → Routing rules in Cloudflare, or
        send it a test. <span className="tag">Owner step</span>
      </span>
    </div>
  )
}

export type { MailboxSummary }
export const fixtureAutoSubmit = (fx: string | undefined) =>
  fixturesEnabled() && Boolean(fx && /^(conflict|created)/.test(fx))
