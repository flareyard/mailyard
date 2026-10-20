/**
 * A domain's page (design: domain-detail, -zone-token, -failing, -failing-zone-token, -pending, -rechecking,
 * -no-events, -disable-sending). Records on the left with "changed <time>" from `changedAt`, then the zone, the
 * mail switches, delivery events (HAL-3341) and the addresses on the right.
 *
 * Fix records (`POST /v1/domains/{id}/fix`) needs the zone token: without one it stays visible, disabled with
 * the reason. While any row is `checking` the page refreshes every 3 seconds.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { fixturesEnabled } from "../fixtures/mode.ts"
import { fmtAgo, fmtInt, num } from "../lib/format.ts"
import { isRecent, utcFull } from "../ops/format.ts"
import { Time } from "../ops/kit.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import { DisableSendingSheet } from "./DisableSendingSheet.tsx"
import { FixSheet } from "./FixSheet.tsx"
import {
  type Check,
  checkLabel,
  checkPurpose,
  type Domain,
  domainState,
  eventsMissing,
  firstFailure,
  foundLine,
  hasFixable,
  isChecking,
  isPendingZone,
  nameserverMatch,
  recordCounts,
  STATUS_PILL,
  TOKEN_SECRET,
  toBind,
  zoneState,
} from "./logic.ts"
import { candidatesQuery, domainQuery, sendingEventsQuery, useRecheck, useUpdateDomain } from "./queries.ts"
import { DomainsHead, StatePill, StatusWord, TokenNote } from "./ui.tsx"
import "./domains.css"

const route = getRouteApi("/_app/domains/$id")

export function DomainDetail() {
  const { id } = route.useParams()
  const { sheet } = route.useSearch()
  const navigate = route.useNavigate()
  const q = useQuery(domainQuery(id))
  const events = useQuery(sendingEventsQuery)
  const candidates = useQuery(candidatesQuery)
  const recheck = useRecheck(id)
  // Fix records writes, so it opens from the button only. In fixture mode `?sheet=fix` opens it too, so every
  // designed result is reachable by a URL; live, a shared link must never run a fix.
  const [fixOpen, setFixOpen] = useState(false)
  const setSheet = (s: "fix" | "disable" | undefined) =>
    navigate({ search: s ? { sheet: s } : {}, replace: true })

  if (q.isPending)
    return (
      <>
        <DomainsHead title="Domain" mono />
        <div className="split-2">
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={6} />
            </div>
          </section>
          <section className="panel">
            <div className="panel-body">
              <PanelSkeleton rows={4} />
            </div>
          </section>
        </div>
      </>
    )
  if (q.isError)
    return (
      <>
        <DomainsHead title="Domain" mono />
        <section className="panel is-error">
          <div className="panel-body">
            <PanelError
              error={q.error}
              onRetry={() => q.refetch()}
              what={
                q.error instanceof ApiError && q.error.status === 404
                  ? "No domain with this id"
                  : "This domain didn’t load"
              }
            />
          </div>
        </section>
      </>
    )

  const d = q.data
  // Before candidates answer, a zone status on the domain itself is proof enough of a token.
  const connected = candidates.data ? candidates.data.connected : d.zoneStatus !== null
  const state = domainState(d, events.data?.domains)
  const missing = eventsMissing(d, events.data?.domains)
  const checking = isChecking(d) || recheck.isPending
  const pending = isPendingZone(d.zoneStatus)
  const failure = firstFailure(d.checks)
  const fixable = hasFixable(d.checks)

  const recheckNow = () =>
    recheck.mutate(undefined, {
      onError: (e) => toast({ tone: "bad", title: "Re-check didn’t start", sub: e.message }),
    })

  const actions = (
    <>
      {checking ? (
        <button className="btn btn-secondary is-loading" type="button" aria-disabled="true">
          <span className="spinner" />
          Checking…
        </button>
      ) : (
        <button
          className={`btn ${fixable ? "btn-secondary" : "btn-primary"}`}
          type="button"
          onClick={recheckNow}
          data-endpoint={`POST /v1/domains/${d.id}/recheck`}
        >
          <Icon name="refresh" />
          {pending ? "Check nameservers now" : "Re-check now"}
        </button>
      )}
      {fixable && !pending ? (
        <Gated
          allowed={connected}
          side="right"
          reason="Fixing needs a zone token"
          who={`Mailyard can only change records with ${TOKEN_SECRET} set. Until then, set the records below by hand; each row has its value to copy.`}
        >
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => setFixOpen(true)}
            data-endpoint={`POST /v1/domains/${d.id}/fix`}
          >
            <Icon name="zap" className="icon-12" />
            Fix records
          </button>
        </Gated>
      ) : null}
    </>
  )

  return (
    <>
      <DomainsHead
        title={d.name}
        mono
        sub={
          <>
            <StatePill state={checking ? { tone: "info", label: "Checking", spinner: true } : state} />
            {pending ? (
              " · Cloudflare has the zone; the registrar still points elsewhere"
            ) : (
              <>
                {" · "}
                {d.lastCheckedAt ? (
                  <>
                    checked <Time value={d.lastCheckedAt} />
                  </>
                ) : (
                  "not checked yet"
                )}
                {d.zoneName ? (
                  <>
                    {" · zone "}
                    <span className="mono">{d.zoneName}</span>
                  </>
                ) : null}
              </>
            )}
          </>
        }
        actions={actions}
      />
      {checking ? (
        <div className="callout callout-info" role="status" style={{ marginBottom: 16 }}>
          <span className="spinner" aria-hidden="true" />
          <span>
            <b>Checking {d.checks.length || 7} records against public DNS.</b> Rows that are still waiting say
            Checking; each ticks as its answer comes back, usually within 20 seconds.
          </span>
        </div>
      ) : null}
      {missing ? (
        <div
          className="callout callout-error"
          role="alert"
          style={{ marginBottom: 16 }}
          data-endpoint="GET /v1/sending/events"
        >
          <Icon name="x-circle" />
          <span>
            <b>No delivery events reach Mailyard for this domain.</b> {missing.detail}
            {num(missing.silent)
              ? ` Until then its ${fmtInt(missing.silent)} sends stay “sent”: no delivered, bounce or complaint arrives, so suppression, reports and the governor’s auto-pause can’t see them.`
              : ""}
          </span>
        </div>
      ) : null}
      {!checking && failure && !pending ? (
        <div className="callout callout-error" role="alert" style={{ marginBottom: 16 }}>
          <Icon name="x-circle" />
          <span>
            <b>
              {checkLabel(failure.id)} on <span className="mono">{d.name}</span>{" "}
              {failure.status === "warn" ? "needs a look" : "stopped matching"}
              {failure.changedAt ? ` ${fmtAgo(failure.changedAt)}` : ""}.
            </b>{" "}
            {failure.detail}{" "}
            {connected
              ? "Fix records can re-apply what Cloudflare manages, or set it by hand."
              : "Set the record below by hand, or connect a zone token so Fix records can do it."}
          </span>
        </div>
      ) : null}
      <div className="split-2">
        <div className="stack">
          <RecordsPanel d={d} pending={pending} />
        </div>
        <div className="stack">
          <ZonePanel d={d} connected={connected} />
          <MailPanel d={d} onDisable={() => setSheet("disable")} />
          <EventsPanel d={d} events={events.data?.domains} />
          <AddressesPanel d={d} />
        </div>
      </div>
      {fixOpen || (sheet === "fix" && fixturesEnabled()) ? (
        <FixSheet
          domain={d}
          onClose={() => {
            setFixOpen(false)
            if (sheet) setSheet(undefined)
          }}
        />
      ) : null}
      {sheet === "disable" ? <DisableSendingSheet domain={d} onClose={() => setSheet(undefined)} /> : null}
    </>
  )
}

function RecordsPanel({ d, pending }: { d: Domain; pending: boolean }) {
  const counts = recordCounts(d.checks)
  const checking = counts.checking > 0 || d.checkStatus === "checking"
  const bind = toBind(d.expectedRecords)
  const [copied, setCopied] = useState(false)
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/domains/${d.id} → checks[] (changedAt, checking)`}
      data-od-id="panel-records"
      aria-labelledby="h-records"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-records">
          {pending ? "Records waiting" : "Mail records"}
        </h2>
        <div className="cluster">
          <span className="panel-meta">
            {checking
              ? "checking now · live"
              : pending
                ? `${counts.passing} of ${counts.total} · waiting for nameservers`
                : `${counts.passing} of ${counts.total} passing`}
          </span>
        </div>
      </header>
      <div className="panel-body">
        {d.checks.length ? (
          <div data-od-id="dns-records">
            {d.checks.map((c) => (
              <CheckRow key={c.id} c={c} />
            ))}
          </div>
        ) : (
          <p className="muted t-small">Not checked yet. Re-check to ask public DNS for each record.</p>
        )}
      </div>
      <footer className="panel-foot">
        <span>
          Expected is what Mailyard needs; found is what public DNS answers now. “Changed” is when a row last
          changed state.
        </span>
        {d.expectedRecords.length ? (
          <button
            className="link-quiet dm-link-btn"
            type="button"
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(bind)
                setCopied(true)
                setTimeout(() => setCopied(false), 1600)
              } catch {
                toast({ tone: "bad", title: "Couldn’t copy", sub: "Your browser refused clipboard access." })
              }
            }}
          >
            <Icon name={copied ? "check" : "copy"} className="icon-12" />
            {copied ? "Copied" : "Copy all as a BIND file"}
          </button>
        ) : null}
      </footer>
    </section>
  )
}

const ROW_CLASS: Record<Check["status"], string> = {
  pass: "is-pass",
  warn: "is-warn",
  fail: "is-fail",
  error: "is-fail",
  checking: "is-checking",
}
const ROW_ICON = { pass: "check-circle", warn: "warn", fail: "x-circle", error: "x-circle" } as const
const ROW_ICON_CLASS = {
  pass: "status-pass",
  warn: "status-warn",
  fail: "status-fail",
  error: "status-fail",
} as const

function CheckRow({ c }: { c: Check }) {
  const found = foundLine(c)
  const pill = STATUS_PILL[c.status]
  return (
    <div className={`dns-row ${ROW_CLASS[c.status]}`} data-check={c.id} data-od-id={`check-${c.id}`}>
      <span className="dns-state-icon">
        {c.status === "checking" ? (
          <span className="spinner status-info" role="img" aria-label="Checking" />
        ) : (
          <Icon
            name={ROW_ICON[c.status]}
            className={`status-icon ${ROW_ICON_CLASS[c.status]}`}
            label={pill.label}
          />
        )}
      </span>
      <span className="dns-type">
        {c.type}
        <span className="purpose">{checkPurpose(c)}</span>
      </span>
      <span className="dns-name">
        {c.name}
        {c.changedAt ? (
          <span className="dns-changed" data-od-id="changed-at">
            changed <ChangedAt value={c.changedAt} />
          </span>
        ) : null}
      </span>
      <span className="dns-value">
        <span className="muted t-small" style={{ fontFamily: "var(--font-sans)" }}>
          Expected
        </span>
        <br />
        {c.expected}
        <span className={`actual${found.ok ? " ok" : ""}${c.status === "checking" ? " dm-asking" : ""}`}>
          {found.text}
        </span>
      </span>
      <span className="dns-state cluster cluster-4">
        <StatePill state={pill} />
        <CopyChipIcon value={c.expected} what={`the ${c.id} value`} />
      </span>
      {c.status !== "pass" && c.status !== "checking" && c.detail ? (
        <p className="dns-detail">{c.detail}</p>
      ) : null}
    </div>
  )
}

/** The design's small icon copy button (`.copy-btn`) for each row's expected value. */
function CopyChipIcon({ value, what }: { value: string; what: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy-btn"
      type="button"
      aria-label={`Copy ${what}`}
      data-tip={done ? "Copied" : "Copy value"}
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {
          setDone(false)
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} className="icon-12" />
    </button>
  )
}

/** "2 hours ago" within a week, otherwise the day ("1 Oct"), with the full UTC time on hover. */
function ChangedAt({ value }: { value: number | string }) {
  const ms = num(value)
  if (ms === null) return null
  return (
    <time dateTime={new Date(ms).toISOString()} title={utcFull(ms)}>
      {isRecent(ms)
        ? fmtAgo(ms)
        : new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}
    </time>
  )
}

function NsLines({ list }: { list: readonly string[] }) {
  return (
    <>
      {list.map((n) => (
        <span key={n} className="mono ns-line">
          {n}
        </span>
      ))}
    </>
  )
}

function ZonePanel({ d, connected }: { d: Domain; connected: boolean }) {
  const zone = zoneState(d.zoneStatus, connected)
  const match = nameserverMatch(d.nameservers, d.currentNameservers)
  return (
    <section
      className="panel"
      data-endpoint={`GET /v1/domains/${d.id} → zoneName, nameservers, currentNameservers, registrar, dnssec, complaints30d, returnPath, zoneCheckedAt`}
      data-od-id="panel-zone"
      aria-labelledby="h-zone"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-zone">
          Zone
        </h2>
      </header>
      <div className="panel-body">
        <dl className="kv dm-kv" data-od-id="zone-kv">
          <dt>Zone</dt>
          <dd>
            {d.zoneName ? (
              <span className="mono">{d.zoneName}</span>
            ) : (
              <span className="muted">Not known</span>
            )}
            {zone ? (
              <>
                {" · "}
                <StatusWord tone={zone.tone}>{zone.label}</StatusWord>
              </>
            ) : null}
          </dd>
          {connected ? (
            <>
              <dt>Nameservers</dt>
              <dd>
                {match === "match" ? (
                  <StatusWord tone="pass">They match</StatusWord>
                ) : match === "mismatch" ? (
                  <StatusWord tone="warn">They don’t match yet</StatusWord>
                ) : (
                  <span className="muted">Not known</span>
                )}
              </dd>
              <dt>Assigned by Cloudflare</dt>
              <dd>
                {d.nameservers?.length ? <NsLines list={d.nameservers} /> : <span className="muted">—</span>}
              </dd>
              <dt>Public DNS says</dt>
              <dd className={match === "mismatch" ? "is-mismatch" : ""}>
                {d.currentNameservers?.length ? (
                  <NsLines list={d.currentNameservers} />
                ) : (
                  <span className="muted">Nothing</span>
                )}
              </dd>
              <dt>Registrar</dt>
              <dd>{d.registrar ?? <span className="muted">Unknown</span>}</dd>
              <dt>DNSSEC</dt>
              <dd>
                {d.dnssec ? (
                  d.dnssec.charAt(0).toUpperCase() + d.dnssec.slice(1)
                ) : (
                  <span className="muted">Unknown</span>
                )}
              </dd>
              <dt>Complaints, 30 d</dt>
              <dd>
                {d.complaints30d === null ? (
                  <span className="muted">—</span>
                ) : (
                  <>
                    {fmtInt(d.complaints30d)} <span className="muted">from Cloudflare</span>
                  </>
                )}
              </dd>
            </>
          ) : (
            <>
              <dt>Nameservers</dt>
              <dd>
                {d.currentNameservers?.length ? (
                  <>
                    <span className="mono">{d.currentNameservers.join(", ")}</span>{" "}
                    <span className="muted">from public DNS</span>
                  </>
                ) : (
                  <span className="muted">Public DNS has none</span>
                )}
              </dd>
            </>
          )}
          <dt>Return path</dt>
          <dd>
            {d.returnPath ? <span className="mono">{d.returnPath}</span> : <span className="muted">—</span>}
          </dd>
          {connected ? (
            <>
              <dt>Zone checked</dt>
              <dd>
                <Time value={d.zoneCheckedAt} />
              </dd>
            </>
          ) : null}
        </dl>
        {!connected ? (
          <div style={{ marginTop: 12 }}>
            <TokenNote lead="Connect a zone token to see registrar, DNSSEC and complaints, and to fix records here." />
          </div>
        ) : null}
      </div>
    </section>
  )
}

function MailPanel({ d, onDisable }: { d: Domain; onDisable: () => void }) {
  const update = useUpdateDomain(d.id)
  const patch = (
    body: { receiving?: boolean; sending?: boolean; catchAll?: "bounce" | "keep" },
    done: string,
    undo?: typeof body,
  ) =>
    update.mutate(body, {
      onSuccess: () =>
        toast({
          title: done,
          ...(undo ? { action: { label: "Undo", run: () => update.mutate(undo) } } : {}),
        }),
      onError: (e) => toast({ tone: "bad", title: "Not saved", sub: e.message }),
    })
  return (
    <section
      className="panel"
      data-endpoint={`PATCH /v1/domains/${d.id}`}
      data-od-id="panel-mail"
      aria-labelledby="h-mail"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-mail">
          Mail on this domain
        </h2>
        <div className="cluster">{update.isPending ? <span className="panel-meta">Saving…</span> : null}</div>
      </header>
      <div className="panel-body">
        <div>
          <div className="toggle-row">
            <span className="tr-title">Routing (receive mail)</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={d.receiving}
                aria-label="Routing (receive mail)"
                disabled={update.isPending}
                onChange={(e) =>
                  patch(
                    { receiving: e.target.checked },
                    e.target.checked ? `Routing on for ${d.name}` : `Routing off for ${d.name}`,
                    { receiving: !e.target.checked },
                  )
                }
              />
            </label>
            <span className="tr-sub">
              Email Routing sends mail for this domain to Mailyard. Turning it off bounces new mail at
              Cloudflare.
            </span>
          </div>
          <div className="toggle-row">
            <span className="tr-title">Sending</span>
            <label className="switch">
              <input
                type="checkbox"
                checked={d.sending}
                aria-label="Sending"
                disabled={update.isPending}
                onChange={(e) => {
                  // Turning sending off is guarded by a typed confirmation; turning it on is instant.
                  if (!e.target.checked) onDisable()
                  else patch({ sending: true }, `Sending on for ${d.name}`)
                }}
              />
            </label>
            <span className="tr-sub">
              Allows sends from any address here. Off makes every send from this domain fail before it’s
              billed.
            </span>
          </div>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label className="label" htmlFor={`catchall-${d.id}`}>
            Mail to an address that doesn’t exist
          </label>
          <select
            className="select"
            id={`catchall-${d.id}`}
            value={d.catchAll}
            disabled={update.isPending}
            onChange={(e) => {
              const v = e.target.value === "keep" ? "keep" : "bounce"
              patch(
                { catchAll: v },
                v === "keep" ? "Unknown addresses go to the catch-all" : "Unknown addresses bounce",
                {
                  catchAll: d.catchAll,
                },
              )
            }}
          >
            <option value="bounce">Bounce it back to the sender</option>
            <option value="keep">Keep it in the catch-all mailbox</option>
          </select>
          <span className="hint">
            Currently: {d.catchAll === "keep" ? "keep" : "bounce"}. Keeping invites spam to random addresses.
          </span>
        </div>
      </div>
    </section>
  )
}

function EventsPanel({ d, events }: { d: Domain; events: Parameters<typeof eventsMissing>[1] }) {
  const e = events?.find((x) => x.domainId === d.id)
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/sending/events"
      data-od-id="panel-sending-events"
      aria-labelledby="h-sending-events"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-sending-events">
          Delivery events
        </h2>
        <div className="cluster">
          <Link className="panel-link" to="/domains/dmarc" search={{ domain: d.id }}>
            DMARC reports
            <Icon name="chevron-right" />
          </Link>
        </div>
      </header>
      <div className="panel-body">
        <dl className="kv dm-kv">
          <dt>Sending events</dt>
          <dd>
            {!d.sending ? (
              <span className="muted">Sending is off, so there are no delivery events to receive.</span>
            ) : !e ? (
              <span className="muted">Not measured yet: Mailyard looks once this domain has sent.</span>
            ) : (
              <>
                <StatePill
                  state={
                    e.status === "ok"
                      ? { tone: "pass", label: "Subscribed" }
                      : e.status === "warn"
                        ? { tone: "warn", label: "Check" }
                        : { tone: "neutral", label: "Unknown" }
                  }
                />{" "}
                {e.detail}
              </>
            )}
          </dd>
          {e && (num(e.withEvents) || num(e.silent)) ? (
            <>
              <dt>Sends, 7 d</dt>
              <dd>
                {fmtInt(e.withEvents)} with events · {fmtInt(e.silent)} without
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  )
}

function AddressesPanel({ d }: { d: Domain }) {
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/domains/{id} → mailboxes"
      data-od-id="panel-addresses"
      aria-labelledby="h-addresses"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-addresses">
          Addresses
        </h2>
        <div className="cluster">
          {/* Settings → Mailboxes (HAL-3309's settings half); typed as /settings until that route file lands. */}
          <Link className="panel-link" to={"/settings/mailboxes" as "/settings"}>
            Mailboxes
            <Icon name="chevron-right" />
          </Link>
        </div>
      </header>
      <div className="panel-body">
        <ul className="list">
          {d.mailboxes.length ? (
            d.mailboxes.map((m) => (
              <li key={m.id} className="list-row">
                <span className="grow">
                  <span className="row-title mono">{m.address}</span>
                  <span className="row-sub">
                    {m.kind.replace("_", "-")}
                    {m.displayName ? ` · ${m.displayName}` : ""}
                  </span>
                </span>
              </li>
            ))
          ) : (
            <li className="list-row">
              <span className="grow">
                <span className="row-sub">
                  {d.receiving ? "No addresses here yet." : "Sending only; no addresses receive here."}
                </span>
              </span>
            </li>
          )}
        </ul>
      </div>
    </section>
  )
}
