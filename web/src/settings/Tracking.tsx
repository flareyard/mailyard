/**
 * Settings → Tracking and compliance (design: tracking, tracking-check-failed, tracking-check-never,
 * tracking-privacy-invalid; HANDOFF-ops §28, §30, HAL-3376). Tracking defaults as On / Off / Use deploy default
 * (null), the tracking hostname and its check, allowed link domains, postal address and privacy URL (https
 * only), double opt-in, the preference page and seed addresses, with one save bar.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type KeyboardEvent, useEffect, useMemo, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { BuiltPill, Time } from "../ops/kit.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import {
  changedFields,
  hostOrigin,
  looksLikeEmail,
  normaliseDomain,
  originHost,
  privacyUrlProblem,
  type Tri,
  unsavedLine,
} from "./logic.ts"
import { ApiRefusal } from "./mailboxes/CreateMailbox.tsx"
import { type Compliance, complianceQuery } from "./queries.ts"
import { SaveBar, SectionHead } from "./ui.tsx"

type Form = {
  trackOpens: Tri
  trackClicks: Tri
  doubleOptIn: Tri
  host: string
  links: string[]
  postal: string
  privacy: string
  useBrand: boolean
  showTopicDescriptions: boolean
  seeds: string[]
}

const formOf = (c: Compliance): Form => ({
  trackOpens: c.trackOpensDefault ?? null,
  trackClicks: c.trackClicksDefault ?? null,
  doubleOptIn: c.doubleOptInDefault ?? null,
  host: originHost(c.trackingOrigin),
  links: c.linkAllowlist,
  postal: c.postalAddress ?? "",
  privacy: c.privacyUrl ?? "",
  useBrand: c.preferencePage?.useBrand ?? true,
  showTopicDescriptions: c.preferencePage?.showTopicDescriptions ?? true,
  seeds: c.seedAddresses,
})

const LABELS: Partial<Record<keyof Form, string>> = {
  trackOpens: "open tracking",
  trackClicks: "click tracking",
  doubleOptIn: "double opt-in",
  host: "tracking hostname",
  links: "link domains",
  postal: "postal address",
  privacy: "privacy URL",
  useBrand: "preference page",
  showTopicDescriptions: "preference page",
  seeds: "seed addresses",
}

export function TrackingPage() {
  const q = useQuery(complianceQuery)
  return (
    <>
      <SectionHead
        title="Tracking and compliance"
        sub="What every bulk message carries, and how consent is collected."
      />
      {q.isPending ? (
        <div className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={8} />
          </div>
        </div>
      ) : q.isError ? (
        <div className="panel is-error">
          <div className="panel-body">
            <PanelError
              error={q.error}
              onRetry={() => q.refetch()}
              what="Tracking and compliance didn’t load"
            />
          </div>
        </div>
      ) : (
        <>
          <TrackingCheck c={q.data} />
          <ComplianceForm c={q.data} />
        </>
      )}
    </>
  )
}

function TrackingCheck({ c }: { c: Compliance }) {
  const qc = useQueryClient()
  const check = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/settings/compliance/tracking-check")),
    onSuccess: (r) => {
      qc.setQueryData(complianceQuery.queryKey, r)
      const k = r.trackingOriginCheck
      toast(
        k && k.certificate === "valid" && k.routesHere
          ? { title: "Tracking hostname checks out" }
          : { title: "Tracking hostname still fails", tone: "warn" },
      )
    },
  })
  const k = c.trackingOriginCheck
  const host = k?.host ?? originHost(c.trackingOrigin)
  const fine = k ? k.certificate === "valid" && k.routesHere : false
  const target = typeof window === "undefined" ? "" : window.location.host
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/settings/compliance → trackingOriginCheck · POST /v1/settings/compliance/tracking-check (built, HAL-3376)"
      data-od-id="panel-tracking-check"
      aria-labelledby="h-tracking-check"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-tracking-check">
          Tracking hostname check
        </h2>
        <div className="cluster">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            onClick={() => check.mutate()}
            disabled={check.isPending || !host}
            data-endpoint="POST /v1/settings/compliance/tracking-check"
          >
            <Icon name="refresh" />
            {check.isPending ? "Checking…" : k ? "Check again" : "Check now"}
          </button>
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-12">
          {!host ? (
            <div className="callout callout-info" role="status">
              <Icon name="info" />
              <span>
                <b>No tracking hostname.</b> Clicks and opens go through this Mailyard’s own address. Set one
                below to use your domain.
              </span>
            </div>
          ) : !k ? (
            <div className="callout callout-info" role="status">
              <Icon name="info" />
              <span>
                <b>Not checked yet.</b> Mailyard checks the tracking hostname whenever it changes. Check it
                now to see its CNAME, certificate and whether it reaches this Mailyard.
              </span>
            </div>
          ) : !fine ? (
            <div className="callout callout-error" role="alert">
              <Icon name="x-circle" />
              <span>
                <b>Tracked links would break.</b> {host}{" "}
                {k.cname
                  ? "doesn’t reach this Mailyard"
                  : `has no CNAME${k.certificate === "failed" ? " and no valid certificate" : ""}`}
                , so clicks and opens can’t reach Mailyard. Add a CNAME from{" "}
                <span className="mono">{host}</span> to <span className="mono">{target}</span>, wait for the
                certificate, then check again. Until then links go out untracked.
              </span>
            </div>
          ) : null}
          {host ? (
            <dl className="kv">
              <dt>Host</dt>
              <dd>
                <span className="mono">{host}</span>
              </dd>
              {k ? (
                <>
                  <dt>CNAME</dt>
                  <dd>
                    {k.cname ? (
                      <span className="mono">{k.cname}</span>
                    ) : (
                      <span className="muted">None found</span>
                    )}
                  </dd>
                  <dt>Certificate</dt>
                  <dd>
                    <span
                      className="status-word"
                      style={k.certificate === "valid" ? undefined : { color: "var(--red-900)" }}
                    >
                      <Icon name={k.certificate === "valid" ? "check-circle" : "x-circle"} />
                      {k.certificate === "valid" ? "Valid" : "Failed"}
                    </span>
                  </dd>
                  <dt>Routes here</dt>
                  <dd>
                    <span
                      className="status-word"
                      style={k.routesHere ? undefined : { color: "var(--red-900)" }}
                    >
                      <Icon name={k.routesHere ? "check-circle" : "x-circle"} />
                      {k.routesHere ? "Yes, it reaches this Mailyard" : "No"}
                    </span>
                  </dd>
                </>
              ) : null}
              <dt>Checked</dt>
              <dd className={k ? undefined : "muted"}>
                {k ? <Time value={k.checkedAt as number} /> : "Never"}
              </dd>
            </dl>
          ) : null}
          {check.isError ? <ApiRefusal error={check.error} /> : null}
        </div>
      </div>
    </section>
  )
}

function TriRow({
  id,
  title,
  sub,
  value,
  onChange,
}: {
  id: string
  title: string
  sub: string
  value: Tri
  onChange: (v: Tri) => void
}) {
  const opts: [Tri, string][] = [
    [true, "On"],
    [false, "Off"],
    [null, "Use deploy default"],
  ]
  return (
    <div className="tri-row" data-od-id={id}>
      <div>
        <span className="tr-title">{title}</span>
        <span className="tr-sub">{sub}</span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
      <div className="seg" role="group" aria-label={title}>
        {opts.map(([v, l]) => (
          <button key={l} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  )
}

function Chips({
  label,
  values,
  onChange,
  normalise,
  placeholder,
  error,
}: {
  label: string
  values: string[]
  onChange: (v: string[]) => void
  normalise: (v: string) => string | null
  placeholder: string
  error: string
}) {
  const [draft, setDraft] = useState("")
  const [bad, setBad] = useState(false)
  const add = () => {
    const v = normalise(draft)
    if (!v) {
      setBad(Boolean(draft.trim()))
      return
    }
    if (!values.includes(v)) onChange([...values, v])
    setDraft("")
    setBad(false)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      add()
    } else if (e.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1))
  }
  return (
    <>
      <div className="st-chips">
        {values.map((v) => (
          <span key={v} className="chip">
            <span className="mono">{v}</span>
            <button
              type="button"
              aria-label={`Remove ${v}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon name="x" />
            </button>
          </span>
        ))}
        <input
          className="input mono"
          placeholder={placeholder}
          aria-label={label}
          value={draft}
          aria-invalid={bad ? true : undefined}
          onChange={(e) => {
            setDraft(e.target.value)
            setBad(false)
          }}
          onKeyDown={onKey}
          onBlur={add}
        />
      </div>
      {bad ? (
        <span className="field-error">
          <Icon name="x-circle" />
          {error}
        </span>
      ) : null}
    </>
  )
}

function ComplianceForm({ c }: { c: Compliance }) {
  const qc = useQueryClient()
  const initial = useMemo(() => formOf(c), [c])
  const [f, setF] = useState(initial)
  useEffect(() => setF(initial), [initial])
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((p) => ({ ...p, [k]: v }))
  const changed = changedFields(initial, f, LABELS)
  const privacyError = privacyUrlProblem(f.privacy)
  const hostBad = f.host.trim() !== "" && !normaliseDomain(f.host)
  const blocked = Boolean(privacyError) || hostBad
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/v1/settings/compliance", {
          body: {
            postalAddress: f.postal.trim() || null,
            linkAllowlist: f.links,
            seedAddresses: f.seeds,
            trackingOrigin: hostOrigin(f.host),
            privacyUrl: f.privacy.trim() || null,
            trackOpensDefault: f.trackOpens,
            trackClicksDefault: f.trackClicks,
            doubleOptInDefault: f.doubleOptIn,
            preferencePage: { useBrand: f.useBrand, showTopicDescriptions: f.showTopicDescriptions },
          },
        }),
      ),
    onSuccess: (r) => {
      qc.setQueryData(complianceQuery.queryKey, r)
      toast({
        title: "Tracking and compliance saved",
        sub: f.host !== initial.host ? "The tracking hostname is checked again" : undefined,
      })
    },
  })
  return (
    <>
      <div
        className="panel"
        data-endpoint="GET/PUT /v1/settings/compliance (built, HAL-3376)"
        data-od-id="panel-compliance"
      >
        <div className="panel-body">
          <section className="form-section">
            <div className="fs-head">
              <h2>Tracking defaults</h2>
              <p>
                For new campaigns; each campaign can change its own. “Use deploy default” leaves it to the
                Worker’s setting (null).
              </p>
            </div>
            <div className="fs-body">
              <TriRow
                id="default-opens"
                title="Track opens"
                sub="Privacy proxies make opens unreliable, and some readers mind the pixel."
                value={f.trackOpens}
                onChange={(v) => set("trackOpens", v)}
              />
              <TriRow
                id="default-clicks"
                title="Track clicks"
                sub="Links go through your tracking hostname, then on to the real page."
                value={f.trackClicks}
                onChange={(v) => set("trackClicks", v)}
              />
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Tracking hostname</h2>
              <p>Click and open links use your domain, not ours. Its check is above.</p>
            </div>
            <div className="fs-body">
              <div className="field">
                <label className="label" htmlFor="trk">
                  Hostname
                </label>
                <div className="input-group">
                  <span className="addon">https://</span>
                  <input
                    className="input mono"
                    id="trk"
                    value={f.host}
                    onChange={(e) => set("host", e.target.value)}
                    aria-invalid={hostBad ? true : undefined}
                    placeholder="t.yourdomain.com"
                  />
                </div>
                {hostBad ? (
                  <span className="field-error">
                    <Icon name="x-circle" />A hostname, like t.coursified.app.
                  </span>
                ) : (
                  <span className="hint">
                    Changing it runs the check again. Leave it empty to use this Mailyard’s own address.
                  </span>
                )}
              </div>
              <div className="field">
                <span className="label">Allowed link domains</span>
                <Chips
                  label="Add an allowed link domain"
                  values={f.links}
                  onChange={(v) => set("links", v)}
                  normalise={normaliseDomain}
                  placeholder="Add a domain"
                  error="A domain, like coursified.app."
                />
                <span className="hint">Campaign checks warn about links to anywhere else.</span>
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Postal address and privacy</h2>
              <p>
                The postal address is required in the footer of every bulk message (CAN-SPAM, and Gmail’s
                bulk-sender rules). Both show in the footer of the public pages.
              </p>
            </div>
            <div className="fs-body">
              <div className="field">
                <label className="label" htmlFor="postal">
                  Postal address
                </label>
                <textarea
                  className="textarea"
                  id="postal"
                  rows={2}
                  value={f.postal}
                  onChange={(e) => set("postal", e.target.value)}
                />
                {!f.postal.trim() ? (
                  <span className="hint">Campaigns are blocked until there’s a postal address.</span>
                ) : null}
              </div>
              <div className="field" data-od-id="privacy-url">
                <label className="label" htmlFor="privacy">
                  Privacy policy URL <span className="opt">· optional</span>
                </label>
                <input
                  className="input mono"
                  id="privacy"
                  type="url"
                  inputMode="url"
                  value={f.privacy}
                  onChange={(e) => set("privacy", e.target.value)}
                  aria-invalid={privacyError ? true : undefined}
                  aria-describedby={privacyError ? "privacy-err" : "privacy-hint"}
                />
                {privacyError ? (
                  <span className="field-error" id="privacy-err">
                    <Icon name="x-circle" />
                    {privacyError}
                  </span>
                ) : (
                  <span className="hint" id="privacy-hint">
                    https only. It becomes the Privacy link in the footer of the preference, confirmation and
                    view-in-browser pages; leave it empty to hide the link.
                  </span>
                )}
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Consent</h2>
              <p>How new contacts become subscribed.</p>
            </div>
            <div className="fs-body">
              <TriRow
                id="default-double-opt-in"
                title="Double opt-in for new topics"
                sub="New subscribers confirm by email before they get anything. Imports need a consent statement instead."
                value={f.doubleOptIn}
                onChange={(v) => set("doubleOptIn", v)}
              />
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Preference page</h2>
              <p>What recipients see when they manage topics or unsubscribe.</p>
            </div>
            <div className="fs-body">
              <div className="toggle-row">
                <span className="tr-title">Use the workspace brand</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={f.useBrand}
                    onChange={(e) => set("useBrand", e.target.checked)}
                    aria-label="Use the workspace brand"
                  />
                </label>
                <span className="tr-sub">
                  Your logo, colours and fonts from Brand. Off shows Flareyard’s look with your name.
                </span>
              </div>
              <div className="toggle-row">
                <span className="tr-title">Show topic descriptions</span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={f.showTopicDescriptions}
                    onChange={(e) => set("showTopicDescriptions", e.target.checked)}
                    aria-label="Show topic descriptions"
                  />
                </label>
                <span className="tr-sub">Each topic’s one-line description under its name.</span>
              </div>
            </div>
          </section>
          <section className="form-section">
            <div className="fs-head">
              <h2>Seed addresses</h2>
              <p>
                Your own inboxes that get every campaign first, to see where it lands. Free, because they’re
                verified.
              </p>
            </div>
            <div className="fs-body">
              <Chips
                label="Add a seed address"
                values={f.seeds}
                onChange={(v) => set("seeds", v)}
                normalise={(v) => (looksLikeEmail(v) ? v.trim().toLowerCase() : null)}
                placeholder="Add an address"
                error="An email address, like seed@gmail.com."
              />
            </div>
          </section>
        </div>
      </div>
      {save.isError ? <ApiRefusal error={save.error} /> : null}
      <SaveBar
        line={
          privacyError
            ? "Fix the privacy URL to save"
            : hostBad
              ? "Fix the tracking hostname to save"
              : unsavedLine(changed)
        }
        tone={blocked ? "error" : "muted"}
      >
        {changed.length ? (
          <button className="btn btn-ghost" type="button" onClick={() => setF(initial)}>
            Discard
          </button>
        ) : null}
        <button
          className="btn btn-primary"
          type="button"
          aria-disabled={blocked || !changed.length || save.isPending ? true : undefined}
          onClick={() => !blocked && changed.length && !save.isPending && save.mutate()}
          data-endpoint="PUT /v1/settings/compliance"
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </SaveBar>
      <p className="t-small muted">
        <BuiltPill issue="HAL-3376" /> Saved settings apply to the next send.
      </p>
    </>
  )
}
