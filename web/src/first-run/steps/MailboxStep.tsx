/**
 * Step 3, create your first mailbox (design: first-run/mailbox-{empty,progress,pass,clear,replaced,fail,
 * conflict-drop,conflict-worker}.html, GAPS 4.3). `POST /v1/mailboxes` checks Cloudflare Email Routing for a
 * rule already on the address: a conflict is `409 reason: "routing-rule-exists"`, and pointing the rule at
 * Mailyard re-sends the same body with `replaceRoutingRule: true`. The create answers `routing: clear |
 * replaced | unchecked`; unchecked (no zone token, production today) is an amber note, never a green check.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { type Routing, validateLocalPart } from "../logic.ts"
import type { Mailbox, MailboxSummary } from "../queries.ts"
import { nextAfter, SETUP_WHO, useMark, useSetup } from "../setup.tsx"
import { ApiErrorCallout, describe, FieldError, Kv, KvTable, StepPanel } from "../ui.tsx"

const ENDPOINT = "POST /v1/mailboxes (built, HAL-3378) · PUT /v1/mailboxes/{id}/members"
const LEDE =
  "A mailbox holds mail sent to one address. Most people start with hello@: it’s the address customers guess first."

type Conflict = {
  ruleAction: "forward" | "drop" | "worker" | string
  ruleDestination: string | null
  ruleId: string | null
  message: string
}
type Body = {
  address: string
  kind: "shared" | "user"
  displayName: string | null
  signature: { text: string; html: null } | null
}

const KIND_LABEL: Record<string, string> = {
  shared: "Shared",
  user: "Personal",
  group: "Group",
  alias: "Alias",
  catch_all: "Catch-all",
}

export function MailboxStep() {
  const s = useSetup()
  const [created, setCreated] = useState<{ mailbox: Mailbox; replacedFrom: string | null } | null>(null)
  const domain = s.domain
  if (!domain)
    return (
      <StepPanel
        id="mailbox"
        n={3}
        title="Create your first mailbox"
        lede={LEDE}
        endpoint={ENDPOINT}
        actions={
          <button className="btn btn-primary" type="button" onClick={() => s.goTo("domain")}>
            <Icon name="arrow-right" />
            First, add a domain
          </button>
        }
      >
        <div className="callout callout-info">
          <Icon name="info" />
          <span>A mailbox lives on a domain. Add one in step 1.</span>
        </div>
      </StepPanel>
    )
  const existing = s.mailbox
  if (created || existing) {
    const routing: Routing | undefined = created
      ? created.mailbox.routing
      : s.memory.mailboxRouting?.mailboxId === existing?.id
        ? s.memory.mailboxRouting?.routing
        : undefined
    return (
      <StepPanel
        id="mailbox"
        n={3}
        title="Create your first mailbox"
        lede={LEDE}
        endpoint={ENDPOINT}
        actions={
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => s.goTo(nextAfter(s.steps, "mailbox"))}
          >
            <Icon name="arrow-right" />
            Next: send a test
          </button>
        }
      >
        <Created
          mailbox={created?.mailbox ?? (existing as MailboxSummary)}
          routing={routing}
          replacedFrom={created?.replacedFrom ?? null}
        />
      </StepPanel>
    )
  }
  return (
    <CreateForm
      domainName={domain.name}
      receiving={domain.receiving}
      onCreated={(mailbox, replacedFrom) => setCreated({ mailbox, replacedFrom })}
    />
  )
}

function CreateForm({
  domainName,
  receiving,
  onCreated,
}: {
  domainName: string
  receiving: boolean
  onCreated: (m: Mailbox, replacedFrom: string | null) => void
}) {
  const s = useSetup()
  const qc = useQueryClient()
  const workspace = s.me?.workspace.name ?? ""
  const addrRef = useRef<HTMLInputElement>(null)
  const [local, setLocal] = useState("hello")
  const [displayName, setDisplayName] = useState(workspace)
  const [kind, setKind] = useState<"shared" | "user">("shared")
  const [signature, setSignature] = useState(workspace ? `The ${workspace} team` : "")
  const [addrError, setAddrError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<(Conflict & { body: Body }) | null>(null)
  const [repointError, setRepointError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: (v: { body: Body; replace: boolean }) =>
      unwrap(
        api.POST("/v1/mailboxes", { body: v.replace ? { ...v.body, replaceRoutingRule: true } : v.body }),
      ),
    onSuccess: (mailbox, v) => {
      if (!mailbox || !("routing" in mailbox)) return
      qc.invalidateQueries({ queryKey: ["mailboxes"], exact: true })
      qc.invalidateQueries({ queryKey: ["domains"] })
      s.remember((m) => ({
        ...m,
        started: true,
        mailboxRouting: { mailboxId: mailbox.id, routing: mailbox.routing },
      }))
      onCreated(mailbox, v.replace ? (conflict?.ruleDestination ?? null) : null)
      setConflict(null)
    },
    onError: (e, v) => {
      if (!(e instanceof ApiError)) return
      if (e.status === 409 && e.body.reason === "routing-rule-exists") {
        setConflict({
          ruleAction: String(e.body.ruleAction ?? "forward"),
          ruleDestination: typeof e.body.ruleDestination === "string" ? e.body.ruleDestination : null,
          ruleId: typeof e.body.ruleId === "string" ? e.body.ruleId : null,
          message: e.message,
          body: v.body,
        })
        return
      }
      if (e.status === 400 && e.body.field === "replaceRoutingRule") {
        setRepointError(e.message)
        return
      }
      if (e.status === 400 || e.status === 409) {
        setAddrError(e.message)
        addrRef.current?.focus()
      }
    },
  })

  useMark("mailbox", "running", create.isPending)
  useMark("mailbox", "fail", Boolean(conflict) && !create.isPending)
  const address = `${local.trim()}@${domainName}`
  const busy = create.isPending

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const err = validateLocalPart(local)
    setAddrError(err)
    if (err) return addrRef.current?.focus()
    setRepointError(null)
    create.mutate({
      body: {
        address,
        kind,
        displayName: displayName.trim() || null,
        signature: signature.trim() ? { text: signature.trim(), html: null } : null,
      },
      replace: false,
    })
  }

  if (conflict) {
    const c = conflict
    const lp = c.body.address.split("@")[0]
    const where =
      c.ruleAction === "drop"
        ? "Mail to it is thrown away and never reaches Mailyard."
        : c.ruleAction === "worker"
          ? `Mail to it goes to the Worker ${c.ruleDestination ?? ""}, not Mailyard.`
          : `Mail to it goes to ${c.ruleDestination ?? "another address"} and never reaches Mailyard.`
    return (
      <StepPanel
        id="mailbox"
        n={3}
        title="Create your first mailbox"
        lede={LEDE}
        endpoint={`${ENDPOINT} · 409 reason routing-rule-exists → retry replaceRoutingRule:true`}
        actions={
          <>
            <Gated allowed={s.canSetUp} reason="You can’t change routing" who={SETUP_WHO}>
              <button
                className={`btn btn-primary${busy ? " is-loading" : ""}`}
                type="button"
                onClick={() => {
                  setRepointError(null)
                  create.mutate({ body: c.body, replace: true })
                }}
                disabled={busy}
                {...(repointError ? { "aria-describedby": "repoint-err" } : {})}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {busy ? "Pointing it at Mailyard…" : "Point it at Mailyard instead"}
              </button>
            </Gated>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setConflict(null)
                setRepointError(null)
                requestAnimationFrame(() => addrRef.current?.select())
              }}
            >
              Use another address
            </button>
          </>
        }
      >
        <div className="callout callout-warn" role="alert">
          <Icon name="warn" />
          <span>
            <b>Cloudflare already routes {c.body.address} somewhere else.</b> {where} Point the rule at
            Mailyard to create the mailbox, or pick another address.
          </span>
        </div>
        <div className="stack stack-8" data-od-id="routing-conflict">
          <h3 className="t-h4">The rule in Cloudflare Email Routing now</h3>
          <KvTable>
            <Kv label="Address">
              <span className="mono">{c.body.address}</span>
            </Kv>
            <Kv label="Action">
              {c.ruleAction === "drop"
                ? "Drop"
                : c.ruleAction === "worker"
                  ? "Send to a Worker"
                  : c.ruleAction === "forward"
                    ? "Forward"
                    : c.ruleAction}{" "}
              <span className="mono muted">{c.ruleAction}</span>
            </Kv>
            <Kv label="Destination">
              {c.ruleAction === "drop" ? (
                <span className="muted">Nowhere: the mail is dropped</span>
              ) : (
                <span className="mono">{c.ruleDestination ?? "—"}</span>
              )}
            </Kv>
            {c.ruleId ? (
              <Kv label="Rule">
                <span className="mono" style={{ overflowWrap: "anywhere" }}>
                  {c.ruleId}
                </span>
              </Kv>
            ) : null}
            <Kv label="After you replace it">
              {c.ruleAction === "forward"
                ? `The same rule sends ${lp}@ to Mailyard. You stop getting a copy at ${c.ruleDestination ?? "the old address"}; add forwarding to the mailbox later if you still want one.`
                : `The same rule sends ${lp}@ to Mailyard. Nothing else on ${domainName} changes.`}
            </Kv>
          </KvTable>
        </div>
        {repointError ? <FieldError id="repoint-err">{repointError}</FieldError> : null}
        {create.isError &&
        !(
          create.error instanceof ApiError &&
          (create.error.status === 409 || create.error.status === 400)
        ) ? (
          <ApiErrorCallout error={create.error} what="The mailbox wasn’t created." />
        ) : null}
      </StepPanel>
    )
  }

  return (
    <StepPanel id="mailbox" n={3} title="Create your first mailbox" lede={LEDE} endpoint={ENDPOINT}>
      <form className="step-form" onSubmit={submit} noValidate>
        {!receiving ? (
          <div className="callout callout-warn">
            <Icon name="warn" />
            <span>
              Receiving is off for {domainName}, so mail to this address won’t arrive until it’s on.{" "}
              <button className="link" type="button" onClick={() => s.goTo("enable")}>
                Turn on mail
              </button>
            </span>
          </div>
        ) : null}
        <div className="field">
          <label className="label" htmlFor="mb-addr">
            Address
          </label>
          <div className={`input-group${addrError ? " is-error" : ""}`}>
            <input
              ref={addrRef}
              className="input mono"
              id="mb-addr"
              value={local}
              onChange={(e) => {
                setLocal(e.target.value)
                setAddrError(null)
              }}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              {...describe(addrError, "mb-err", "mb-hint")}
            />
            <span className="addon">@{domainName}</span>
          </div>
          {addrError ? <FieldError id="mb-err">{addrError}</FieldError> : null}
          <p className="hint" id="mb-hint">
            Suggested. You can add aliases like info@ to it later.
          </p>
        </div>
        <div className="field">
          <label className="label" htmlFor="mb-name">
            Display name
          </label>
          <input
            className="input"
            id="mb-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={busy}
            aria-describedby="mb-name-hint"
          />
          <p className="hint" id="mb-name-hint">
            Shown as the sender name when you write from this address.
          </p>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Who can read it
          </legend>
          <label className="check">
            <input type="radio" name="kind" checked={kind === "shared"} onChange={() => setKind("shared")} />
            <span>
              <b>Shared</b>
              <span className="hint" style={{ display: "block" }}>
                A team inbox. Members you add can read, assign and reply.
              </span>
            </span>
          </label>
          <label className="check" style={{ marginTop: 8 }}>
            <input type="radio" name="kind" checked={kind === "user"} onChange={() => setKind("user")} />
            <span>
              <b>Personal</b>
              <span className="hint" style={{ display: "block" }}>
                Only you.
              </span>
            </span>
          </label>
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="mb-sig">
            Signature <span className="opt">· optional</span>
          </label>
          <textarea
            className="textarea"
            id="mb-sig"
            rows={3}
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            disabled={busy}
          />
        </div>
        <p className="hint">
          Mailyard checks Cloudflare Email Routing for a rule already on this address before it creates the
          mailbox. That check needs a zone token.
        </p>
        {create.isError &&
        !(
          create.error instanceof ApiError &&
          (create.error.status === 409 || create.error.status === 400)
        ) ? (
          <ApiErrorCallout error={create.error} what="The mailbox wasn’t created." />
        ) : null}
        <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
          <Gated allowed={s.canSetUp} reason="You can’t create mailboxes" who={SETUP_WHO}>
            <button className={`btn btn-primary${busy ? " is-loading" : ""}`} type="submit" disabled={busy}>
              {busy ? <span className="spinner" aria-hidden="true" /> : null}
              {busy ? `Creating ${address}…` : `Create ${address}`}
            </button>
          </Gated>
        </div>
      </form>
    </StepPanel>
  )
}

function Created({
  mailbox,
  routing,
  replacedFrom,
}: {
  mailbox: Mailbox | MailboxSummary
  routing: Routing | undefined
  replacedFrom: string | null
}) {
  const lp = mailbox.address.split("@")[0]
  return (
    <>
      {routing === "clear" || routing === "replaced" ? (
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>
            <b>{mailbox.address} is ready.</b> Mail sent to it lands in Mail → {lp}@ from now on.
          </span>
        </div>
      ) : (
        <p className="t-body">
          <b>{mailbox.address} is created.</b> Mail that reaches Mailyard for it lands in Mail → {lp}@.
        </p>
      )}
      {routing === "clear" ? (
        <div className="callout callout-ok" data-od-id="routing-result">
          <Icon name="check-circle" />
          <span>
            <b>Cloudflare routes {lp}@ to Mailyard.</b> No other Email Routing rule was on the address.
          </span>
        </div>
      ) : routing === "replaced" ? (
        <div className="callout callout-ok" data-od-id="routing-result">
          <Icon name="check-circle" />
          <span>
            <b>Routing rule replaced.</b>{" "}
            {replacedFrom ? (
              <>
                The Cloudflare rule that forwarded {lp}@ to <span className="mono">{replacedFrom}</span> now
                sends it to Mailyard.
              </>
            ) : (
              `The Cloudflare rule on ${lp}@ now sends it to Mailyard.`
            )}
          </span>
        </div>
      ) : routing === "unchecked" ? (
        <div className="callout callout-warn" data-od-id="routing-result">
          <Icon name="info" />
          <span>
            <b>Couldn’t check Cloudflare’s routing (no zone token).</b> If an Email Routing rule already
            forwards or drops {lp}@, its mail won’t reach this mailbox. Look in Cloudflare → Email → Routing
            rules, or give Mailyard access to the zone and it checks for you. Catch-all mailboxes are never
            checked: no single rule covers them.
          </span>
        </div>
      ) : null}
      <KvTable>
        <Kv label="Address">
          <span className="mono">{mailbox.address}</span>
        </Kv>
        <Kv label="Kind">{KIND_LABEL[mailbox.kind] ?? mailbox.kind}</Kv>
        <Kv label="Display name">{mailbox.displayName ?? <span className="muted">None</span>}</Kv>
        <Kv label="Cloudflare routing">
          {routing === "clear" ? (
            <>
              Checked: routed to Mailyard <span className="mono muted">clear</span>
            </>
          ) : routing === "replaced" ? (
            <>
              Rule replaced: routed to Mailyard <span className="mono muted">replaced</span>
            </>
          ) : routing === "unchecked" ? (
            <>
              Not checked (no zone token) <span className="mono muted">unchecked</span>
            </>
          ) : (
            <span className="muted">
              Checked when the mailbox was created; this browser didn’t see the result.
            </span>
          )}
        </Kv>
        <Kv label="Who can read it">{"You. Invite people in Settings → Members."}</Kv>
      </KvTable>
    </>
  )
}
