/**
 * Step 2, turn on mail (design: first-run/enable-{empty,progress,pass,fail}.html, GAPS 4.2).
 * `PATCH /v1/domains/{id} { receiving, sending }`, then the seven records tick live: `POST …/recheck` runs
 * every 20 s while records are settling (a reader sees `checking` while a recheck runs), every minute while
 * something needs a fix, and on demand. "Fix records" is `POST …/fix`, refused with `no_dns_token` until
 * Mailyard has a zone token, in which case the records are set by hand.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { checksPassing, type EnablePhase, enablePhase, fmtUtc, rowState } from "../logic.ts"
import { candidatesQuery, type Domain, type DomainCheck, domainQuery } from "../queries.ts"
import { nextAfter, SETUP_WHO, useSetup } from "../setup.tsx"
import { ApiErrorCallout, DnsRow, StepPanel, useEvery, useNow } from "../ui.tsx"

const ENDPOINT =
  "PATCH /v1/domains/{id} {receiving, sending} · GET /v1/domains/{id} (checks incl. checking, changedAt) · POST /v1/domains/{id}/recheck · POST /v1/domains/{id}/fix (built, HAL-3365)"

const purposeLabel = (c: { id?: string; purpose: string; name: string }) =>
  c.id?.startsWith("bounce") || c.name.startsWith("cf-bounce.")
    ? "Return path"
    : c.purpose === "receiving"
      ? "Receiving"
      : "Sending"

const CHECK_LABEL: Record<string, string> = {
  mx: "MX",
  spf: "SPF",
  dkim: "DKIM",
  dmarc: "DMARC",
  "bounce-mx": "the return-path MX",
  "bounce-spf": "the return-path SPF",
  "bounce-dkim": "the return-path DKIM",
}

type FixResult = { actions: Array<{ checks: string[]; action: string; ok: boolean; detail: string }> }

export function EnableStep() {
  const s = useSetup()
  if (!s.domain)
    return (
      <StepPanel
        id="enable"
        n={2}
        title="Turn on mail"
        lede="Mailyard turns on receiving and sending for your domain, then checks each DNS record as Cloudflare sees it."
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
          <span>This step needs a domain in the workspace. Add one in step 1.</span>
        </div>
      </StepPanel>
    )
  return <Enable id={s.domain.id} />
}

function Enable({ id }: { id: string }) {
  const s = useSetup()
  const qc = useQueryClient()
  const candidates = useQuery(candidatesQuery)
  const connected = candidates.data?.connected === true
  // While a recheck runs elsewhere (another tab, the cron), stored checks read `checking`: follow it closely.
  const q = useQuery({
    ...domainQuery(id),
    refetchInterval: (query) =>
      query.state.data?.checks?.some((c) => c.status === "checking") ? 3000 : false,
  })
  const d: Domain | undefined = q.data && "checks" in q.data ? q.data : s.detail
  const now = useNow(5000)
  const phase: EnablePhase = enablePhase(d, { turnedOnAt: s.memory.turnedOnAt, now })
  const [receiving, setReceiving] = useState(() => (d && (d.receiving || d.sending) ? d.receiving : true))
  const [sending, setSending] = useState(() => (d && (d.receiving || d.sending) ? d.sending : true))
  const [fix, setFix] = useState<FixResult | null>(null)

  const store = (fresh: Domain) => {
    qc.setQueryData(domainQuery(id).queryKey, fresh)
    qc.invalidateQueries({ queryKey: ["domains"], exact: true })
  }

  const turnOn = useMutation({
    mutationFn: () =>
      unwrap(api.PATCH("/v1/domains/{id}", { params: { path: { id } }, body: { receiving, sending } })),
    onSuccess: (fresh) => {
      if (fresh && "checks" in fresh) store(fresh)
      s.remember((m) => ({ ...m, started: true, turnedOnAt: Date.now() }))
    },
  })
  const recheck = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/domains/{id}/recheck", { params: { path: { id } } })),
    onSuccess: (fresh) => {
      if (fresh && "checks" in fresh) store(fresh)
    },
  })
  const fixRecords = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/domains/{id}/fix", { params: { path: { id } } })),
    onSuccess: (res) => {
      if (res && "domain" in res) {
        store(res.domain)
        setFix({ actions: res.actions })
      }
    },
  })

  const settling = phase === "progress" || phase === "fail"
  const left = useEvery(
    () => recheck.mutateAsync().catch(() => {}),
    phase === "progress" ? 20_000 : 60_000,
    settling && !recheck.isPending && !turnOn.isPending,
  )

  const checks: DomainCheck[] = d?.checks ?? []
  const expected = d?.expectedRecords ?? []
  const { passing, total } = checksPassing(checks)
  const name = d?.name ?? s.domain?.name ?? ""
  const rows = checks.length
    ? checks.map((c) => ({
        key: c.id,
        type: c.type,
        purpose: purposeLabel(c),
        name: c.name,
        value: c.expected,
        actual: c.actual,
        check: c,
        detail: c.detail,
      }))
    : expected.map((r, i) => ({
        key: `${r.type}-${r.name}-${i}`,
        type: r.type,
        purpose: purposeLabel(r),
        name: r.name,
        value: r.value,
        actual: [] as string[],
        check: undefined,
        detail: undefined,
      }))
  const rechecking = recheck.isPending || turnOn.isPending
  const failing = checks.filter((c) => c.status !== "pass" && c.status !== "checking")
  const noToken = fixRecords.error instanceof ApiError && fixRecords.error.status === 409

  const lede = connected
    ? `Mailyard adds these records to ${name}. MX and SPF let it receive; DKIM, DMARC and the cf-bounce return path let it send and be trusted. Each one ticks green as Cloudflare sees it.`
    : `These are the records ${name} needs. MX and SPF let it receive; DKIM, DMARC and the cf-bounce return path let it send and be trusted. Each one ticks green as Cloudflare sees it.`

  return (
    <StepPanel
      id="enable"
      n={2}
      title="Turn on mail"
      lede={lede}
      endpoint={ENDPOINT}
      actions={
        phase === "idle" ? (
          <>
            <Gated allowed={s.canSetUp} reason="You can’t turn on mail" who={SETUP_WHO}>
              <button
                className={`btn btn-primary${turnOn.isPending ? " is-loading" : ""}`}
                type="button"
                data-endpoint={`PATCH /v1/domains/${id}`}
                onClick={() => turnOn.mutate()}
                disabled={turnOn.isPending}
              >
                {turnOn.isPending ? <span className="spinner" aria-hidden="true" /> : null}
                {turnOn.isPending ? "Turning on mail…" : "Turn on mail"}
              </button>
            </Gated>
            <ExistingMx name={name} />
          </>
        ) : phase === "pass" ? (
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => s.goTo(nextAfter(s.steps, "enable"))}
          >
            <Icon name="arrow-right" />
            Next: create a mailbox
          </button>
        ) : phase === "fail" ? (
          <>
            <Gated allowed={s.canSetUp} reason="You can’t change DNS" who={SETUP_WHO}>
              <button
                className={`btn btn-primary${fixRecords.isPending ? " is-loading" : ""}`}
                type="button"
                data-endpoint={`POST /v1/domains/${id}/fix (built, HAL-3365)`}
                onClick={() => {
                  setFix(null)
                  fixRecords.mutate()
                }}
                disabled={fixRecords.isPending}
              >
                {fixRecords.isPending ? (
                  <span className="spinner" aria-hidden="true" />
                ) : (
                  <Icon name="refresh" />
                )}
                Fix records
              </button>
            </Gated>
            <RecheckButton onClick={() => recheck.mutate()} busy={recheck.isPending} />
            <Link className="link-quiet" to="/domains">
              Open domain detail
            </Link>
            {!connected ? (
              <p className="hint" style={{ flexBasis: "100%" }}>
                Fixing records needs access to the zone. Without one, Mailyard answers “connect a zone token”
                and you set the records above by hand at your DNS host.
              </p>
            ) : null}
          </>
        ) : (
          <RecheckButton onClick={() => recheck.mutate()} busy={recheck.isPending} />
        )
      }
    >
      {phase === "idle" ? (
        <>
          <fieldset className="cluster cluster-16" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr-only">What the domain is for</legend>
            <label className="switch">
              <input
                type="checkbox"
                checked={receiving}
                onChange={(e) => setReceiving(e.target.checked)}
                disabled={turnOn.isPending}
              />{" "}
              Receiving (routing)
            </label>
            <label className="switch">
              <input
                type="checkbox"
                checked={sending}
                onChange={(e) => setSending(e.target.checked)}
                disabled={turnOn.isPending}
              />{" "}
              Sending
            </label>
          </fieldset>
          {!receiving || !sending || (d && (d.receiving || d.sending)) ? (
            <p className="hint" role="status">
              Setup needs both: receiving for the mailbox in step 3, sending for the test in step 4.
              {d && (d.receiving || d.sending)
                ? ` Right now ${name} has ${d.receiving ? "receiving" : "sending"} on only.`
                : ""}
            </p>
          ) : null}
        </>
      ) : phase === "progress" ? (
        <div className="callout callout-info" role="status">
          <Icon name="refresh" />
          <span>
            <b>
              Checking live: {passing} of {total || 7} passing.
            </b>{" "}
            DNS on Cloudflare usually settles within a minute.{" "}
            {rechecking ? "Checking now." : left !== null ? `Next check in ${left} s.` : ""} You can leave;
            you’ll get a “domain activated” alert.
          </span>
        </div>
      ) : phase === "fail" ? (
        <div className="callout callout-error" role="alert">
          <Icon name="x-circle" />
          <span>
            <b>
              {failing.length} of {total} records need a fix.
            </b>{" "}
            {failing.length
              ? `${sentenceList(failing.map((c) => CHECK_LABEL[c.id] ?? c.id))} ${failing.length === 1 ? "doesn’t" : "don’t"} pass yet. `
              : ""}
            “Fix records” re-applies what Mailyard expects; it won’t touch your other records.
            {left !== null && !rechecking ? ` Checking again in ${left} s.` : ""}
          </span>
        </div>
      ) : (
        <div className="callout callout-ok">
          <Icon name="check-circle" />
          <span>
            <b>Mail is on for {name}.</b> All {total} records pass.
            {d?.lastCheckedAt ? ` Last checked ${fmtUtc(d.lastCheckedAt)}.` : ""}
          </span>
        </div>
      )}

      {turnOn.isError ? <ApiErrorCallout error={turnOn.error} what="Mail wasn’t turned on." /> : null}
      {recheck.isError ? <ApiErrorCallout error={recheck.error} what="The check didn’t run." /> : null}
      {noToken ? (
        <div className="callout callout-warn" role="alert">
          <Icon name="key" />
          <span>
            <b>Mailyard can’t change DNS without a zone token.</b> {(fixRecords.error as ApiError).message}{" "}
            Set the records below at your DNS host; each row has a copy button.
          </span>
        </div>
      ) : fixRecords.isError ? (
        <ApiErrorCallout error={fixRecords.error} what="Records weren’t fixed." />
      ) : null}
      {fix?.actions.length ? (
        <ul className="list" aria-label="What Fix records did">
          {fix.actions.map((a) => (
            <li
              key={`${a.action}-${a.checks.join(",")}`}
              className="list-row"
              style={{ alignItems: "flex-start" }}
            >
              <Icon
                name={a.ok ? "check-circle" : "x-circle"}
                className={a.ok ? "status-pass" : "status-fail"}
              />
              <span className="grow">
                <span className="row-title">{a.checks.map((c) => CHECK_LABEL[c] ?? c).join(", ")}</span>
                <span className="row-sub" style={{ whiteSpace: "normal" }}>
                  {a.detail}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <div>
        <div className="spread" style={{ marginBottom: 4 }}>
          <h3 className="t-h4">Records for {name}</h3>
          <span className="t-small muted num">
            {phase === "idle" || !total ? "" : `${passing} / ${total}`}
          </span>
        </div>
        {rows.length ? (
          rows.map((r) => (
            <DnsRow
              key={r.key}
              check={r.key}
              type={r.type}
              purpose={r.purpose}
              name={r.name}
              value={r.value}
              actual={r.actual}
              state={rowState(r.check, phase, rechecking)}
              idleLabel={connected ? "Will be added" : "To add"}
              detail={r.detail}
            />
          ))
        ) : (
          <div className="callout callout-info">
            <Icon name="info" />
            <span>
              Mailyard lists the records here as soon as mail is on: MX and SPF to receive; DKIM, DMARC and
              the cf-bounce return path to send. Each one is checked against public DNS.
            </span>
          </div>
        )}
      </div>
    </StepPanel>
  )
}

function RecheckButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <button
      className={`btn btn-secondary${busy ? " is-loading" : ""}`}
      type="button"
      onClick={onClick}
      disabled={busy}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
      Re-check now
    </button>
  )
}

/** What the zone receives mail at today, from the candidates list (zone token only). */
function ExistingMx({ name }: { name: string }) {
  const candidates = useQuery(candidatesQuery)
  const zone = candidates.data?.candidates.find((c) => c.name === name)
  if (!candidates.data?.connected || !zone) return null
  return (
    <span className="hint">
      {zone.existingMx.length
        ? `Existing MX records: ${zone.existingMx.join(", ")}. Turning on receiving moves this domain’s mail to Mailyard.`
        : "Existing MX records: none. Nothing else on the domain changes."}
    </span>
  )
}

function sentenceList(items: string[]): string {
  const xs = items.map((x, i) => (i === 0 ? x.replace(/^the /, "The ") : x))
  return xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? "")
}
