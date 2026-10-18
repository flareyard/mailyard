/**
 * Step 4, send yourself a test (design: first-run/test-{empty,verified,progress,pass,own,auth-fail,fail}.html,
 * GAPS 4.4 and 4.5). `POST /v1/test-send { from, to? }`, then `GET /v1/test-send/{id}` every 2 s until the
 * status is final. Without `to` it goes to Mailyard's probe, `mailyard-test@<receiving domain>`, which reports
 * SPF, DKIM and DMARC as a receiver saw them; to your own address it reports delivery only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { type Auth, dmarcPolicyCopy, isEmail, isFinalTest, testVerdict } from "../logic.ts"
import { type TestSend, testSendQuery, verifiedQuery } from "../queries.ts"
import { nextAfter, SETUP_WHO, useSetup } from "../setup.tsx"
import { ApiErrorCallout, clock, describe, FieldError, StepPanel, TlItem } from "../ui.tsx"

const ENDPOINT =
  "POST /v1/test-send (built, HAL-3378) · GET /v1/test-send/{id} (polled) · GET /v1/verified-addresses (built, HAL-3378)"
const GIVE_UP_MS = 2 * 60_000

export function TestStep() {
  const s = useSetup()
  const qc = useQueryClient()
  const [composing, setComposing] = useState(false)
  const holding = s.mailboxes.filter((m) => m.holdsMail && m.kind !== "alias" && m.kind !== "catch_all")
  const from = s.mailbox
  const domain = s.domain
  const receivingDomain = domain?.receiving
    ? domain.name
    : (from?.address.split("@")[1] ?? domain?.name ?? "")
  const probe = `mailyard-test@${receivingDomain}`
  const lede = `Mailyard sends a short message from ${from?.address ?? "your mailbox"} and tells you whether it arrived authenticated: whether receivers will trust it as ${from?.address.split("@")[1] ?? domain?.name ?? "your domain"}.`

  const testId = s.memory.lastTestId
  const startedAt = useState(() => Date.now())[0]
  const test = useQuery({
    ...testSendQuery(testId ?? "-"),
    enabled: Boolean(testId) && !composing,
    retry: false,
    refetchInterval: (q) => {
      const t = q.state.data
      if (!t || !("status" in t) || isFinalTest(t)) return false
      const since = num(t.sentAt) ?? startedAt
      return Date.now() - Math.max(since, startedAt) < GIVE_UP_MS ? 2000 : false
    },
  })

  const send = useMutation({
    mutationFn: (body: { from: string; to?: string }) => unwrap(api.POST("/v1/test-send", { body })),
    onSuccess: (t) => {
      if (!t || !("id" in t)) return
      qc.setQueryData(testSendQuery(t.id).queryKey, t)
      qc.invalidateQueries({ queryKey: ["messages"] })
      s.remember((m) => ({ ...m, started: true, lastTestId: t.id }))
      setComposing(false)
    },
  })

  if (!from)
    return (
      <StepPanel
        id="test"
        n={4}
        title="Send yourself a test"
        lede="Mailyard sends a short message from your mailbox and tells you whether it arrived authenticated."
        endpoint={ENDPOINT}
        actions={
          <button className="btn btn-primary" type="button" onClick={() => s.goTo("mailbox")}>
            <Icon name="arrow-right" />
            First, create a mailbox
          </button>
        }
      >
        <div className="callout callout-info">
          <Icon name="info" />
          <span>The test is sent from a mailbox. Create one in step 3.</span>
        </div>
      </StepPanel>
    )

  const t = test.data && "status" in test.data ? test.data : undefined
  if (!t || composing || !testId)
    return (
      <StepPanel id="test" n={4} title="Send yourself a test" lede={lede} endpoint={ENDPOINT}>
        <SendForm
          mailboxes={holding.length ? holding : [from]}
          defaultFrom={from.address}
          probe={probe}
          busy={send.isPending}
          error={send.isError ? send.error : null}
          onSend={(body) => send.mutate(body)}
          onCancel={t ? () => setComposing(false) : undefined}
        />
      </StepPanel>
    )

  const verdict = testVerdict(t)
  const fromDomain = t.from.split("@")[1] ?? ""
  const sendProbe = () => send.mutate({ from: t.from })
  const again = () => send.mutate(t.probe ? { from: t.from } : { from: t.from, to: t.to })
  const waitingTooLong =
    verdict === "waiting" &&
    !test.isFetching &&
    Date.now() - Math.max(num(t.sentAt) ?? 0, startedAt) >= GIVE_UP_MS

  return (
    <StepPanel
      id="test"
      n={4}
      title="Send yourself a test"
      lede={lede}
      endpoint={ENDPOINT}
      actions={
        verdict === "waiting" ? (
          waitingTooLong ? (
            <>
              <button className="btn btn-primary" type="button" onClick={() => test.refetch()}>
                <Icon name="refresh" />
                Check again
              </button>
              <button className="btn btn-secondary" type="button" onClick={() => setComposing(true)}>
                Send another
              </button>
            </>
          ) : (
            <Gated
              allowed={false}
              reason="This test is still on its way"
              who="It usually arrives in a few seconds; this page checks every 2 seconds."
            >
              <button className="btn btn-secondary" type="button">
                Send another
              </button>
            </Gated>
          )
        ) : verdict === "pass" || verdict === "delivered" ? (
          <>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => s.goTo(nextAfter(s.steps, "test"))}
            >
              <Icon name="arrow-right" />
              Next: bring your old mail
            </button>
            {verdict === "delivered" ? (
              <SendButton
                className="btn btn-secondary"
                busy={send.isPending}
                onClick={sendProbe}
                label="Send to the test address"
              />
            ) : (
              <button className="btn btn-secondary" type="button" onClick={() => setComposing(true)}>
                Send another
              </button>
            )}
          </>
        ) : verdict === "auth-fail" ? (
          <>
            <button className="btn btn-primary" type="button" onClick={() => s.goTo("enable")}>
              Fix records
            </button>
            <button className="btn btn-secondary" type="button" onClick={() => setComposing(true)}>
              Send another
            </button>
          </>
        ) : (
          <>
            <SendButton
              className="btn btn-primary"
              busy={send.isPending}
              onClick={sendProbe}
              label="Send to the test address"
            />
            <button className="btn btn-secondary" type="button" onClick={again} disabled={send.isPending}>
              <Icon name="refresh" />
              Try again
            </button>
          </>
        )
      }
    >
      {verdict === "waiting" ? (
        <>
          <p className="t-body">
            To <span className="mono">{t.to}</span>
            {t.probe ? ", Mailyard’s test address." : "."}
          </p>
          <ul className="timeline" aria-live="polite" data-od-id="test-progress">
            {t.status === "sending" ? (
              <TlItem icon="circle-dash" time="now">
                <b>Sending</b> · Mailyard is handing it to Cloudflare Email Service
              </TlItem>
            ) : (
              <>
                <TlItem icon="check-circle" time={clock(num(t.sentAt))}>
                  <b>Sent</b> · Cloudflare Email Service accepted it
                </TlItem>
                <TlItem icon={waitingTooLong ? "clock" : "circle-dash"} time="now">
                  {waitingTooLong ? (
                    <>
                      <b>It hasn’t arrived after 2 minutes.</b> Mail can be delayed; check again, or send
                      another.
                    </>
                  ) : (
                    <>
                      <b>Waiting for it to arrive…</b> Usually a few seconds. This page checks every 2
                      seconds.
                    </>
                  )}
                </TlItem>
              </>
            )}
          </ul>
        </>
      ) : verdict === "pass" ? (
        <>
          <div className="callout callout-ok">
            <Icon name="check-circle" />
            <span>
              <b>
                Arrived at Mailyard’s test address
                {num(t.deliveryTimeMs) !== null ? ` in ${fmtInt(t.deliveryTimeMs)} ms` : ""}.
              </b>{" "}
              {t.authentication ? (
                <>
                  SPF, DKIM and DMARC all pass
                  {t.authentication.dmarcPolicy === "reject"
                    ? `, and ${fromDomain} tells receivers to reject mail that fails`
                    : t.authentication.dmarcPolicy === "quarantine"
                      ? `, and ${fromDomain} tells receivers to send mail that fails to spam`
                      : ""}
                  . Your mail is trusted as {fromDomain}.
                </>
              ) : (
                "Mailyard received it."
              )}
            </span>
          </div>
          <Arrival t={t} />
          {t.authentication ? <AuthTable auth={t.authentication} fromDomain={fromDomain} heading /> : null}
        </>
      ) : verdict === "auth-fail" ? (
        <>
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <AuthFailSentence auth={t.authentication} fromDomain={fromDomain} />
            </span>
          </div>
          {t.authentication ? <AuthTable auth={t.authentication} fromDomain={fromDomain} /> : null}
        </>
      ) : verdict === "delivered" ? (
        <>
          <div className="callout callout-ok">
            <Icon name="check-circle" />
            <span>
              <b>
                Delivered to <span className="mono">{t.to}</span>
                {num(t.deliveryTimeMs) !== null ? ` in ${fmtInt(t.deliveryTimeMs)} ms` : ""}.
              </b>{" "}
              Open that inbox to see it.
            </span>
          </div>
          <ul className="timeline">
            <TlItem icon="check-circle" time={clock(num(t.sentAt))}>
              <b>Sent</b>
            </TlItem>
            <TlItem
              icon="check-circle"
              time={
                num(t.sentAt) !== null && num(t.deliveryTimeMs) !== null
                  ? clock((num(t.sentAt) ?? 0) + (num(t.deliveryTimeMs) ?? 0))
                  : undefined
              }
            >
              <b>Delivered</b> · the receiving server accepted it
            </TlItem>
          </ul>
          <div className="callout callout-info" data-od-id="test-no-auth">
            <Icon name="info" />
            <span>
              <b>No SPF, DKIM or DMARC results for this one.</b> They’re recorded by the inbox that received
              it, which Mailyard can’t see. Send to Mailyard’s test address for the full report.
            </span>
          </div>
        </>
      ) : (
        <>
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <b>The test didn’t send.</b>{" "}
              {t.error?.startsWith("SendSuppressed") ? (
                <>
                  <span className="mono">{t.to}</span> is on your suppression list, so Mailyard refused to
                  send to it. Remove it in Audience → Suppressions, or send to Mailyard’s test address.
                </>
              ) : (
                "Mailyard’s reason is below. Send to the test address, or try again."
              )}
            </span>
          </div>
          <ul className="timeline">
            <TlItem icon="check-circle" time={clock(num(t.sentAt))}>
              <b>Sending</b>
            </TlItem>
            <TlItem icon="x-circle">
              <b>Failed</b>
            </TlItem>
          </ul>
          {t.error ? (
            <div className="stack stack-8">
              <span className="t-small muted">Error</span>
              <pre
                className="mono"
                style={{
                  margin: 0,
                  padding: 12,
                  border: "1px solid var(--my-border)",
                  borderRadius: "var(--radius-base)",
                  background: "var(--gray-100)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {t.error}
              </pre>
            </div>
          ) : null}
        </>
      )}
      {test.isError ? <ApiErrorCallout error={test.error} what="The test’s status didn’t load." /> : null}
      {send.isError ? <ApiErrorCallout error={send.error} what="The test wasn’t sent." /> : null}
    </StepPanel>
  )
}

function SendButton({
  className,
  busy,
  onClick,
  label,
}: {
  className: string
  busy: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      className={`${className}${busy ? " is-loading" : ""}`}
      type="button"
      onClick={onClick}
      disabled={busy}
    >
      {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />}
      {label}
    </button>
  )
}

function Arrival({ t }: { t: TestSend }) {
  return (
    <ul className="timeline">
      <TlItem icon="check-circle" time={clock(num(t.sentAt))}>
        <b>Sent</b>
      </TlItem>
      <TlItem icon="check-circle" time={clock(num(t.receivedAt))}>
        <b>Received</b> · <span className="mono">{t.to}</span>
        {num(t.deliveryTimeMs) !== null ? ` · ${fmtInt(t.deliveryTimeMs)} ms after sending` : ""}
      </TlItem>
    </ul>
  )
}

const chip = (v: string | null) => {
  const cls =
    v === "pass"
      ? "pass"
      : v === "fail" || v === "permerror" || v === "temperror"
        ? "fail"
        : v === "softfail" || v === "neutral"
          ? "warn"
          : "off"
  return (
    <span className={`check-chip ${cls}`}>
      <Icon
        name={
          cls === "pass" ? "check-circle" : cls === "fail" ? "x-circle" : cls === "warn" ? "warn" : "circle"
        }
      />
      {v ?? "none"}
    </span>
  )
}

function AuthTable({
  auth,
  fromDomain,
  heading = false,
}: {
  auth: Auth
  fromDomain: string
  heading?: boolean
}) {
  const policy = dmarcPolicyCopy(auth.dmarcPolicy)
  const table = (
    <table className="table" data-od-id="test-auth">
      <thead>
        <tr>
          <th scope="col">Check and domain</th>
          <th scope="col" style={{ textAlign: "right" }}>
            Result
          </th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <b>SPF</b> <span className="mono">{auth.spfDomain ?? "—"}</span>
            <span className="hint" style={{ display: "block" }}>
              The sending server may send for this domain
            </span>
          </td>
          <td style={{ textAlign: "right" }}>{chip(auth.spf)}</td>
        </tr>
        <tr>
          <td>
            <b>DKIM</b> <span className="mono">{auth.dkimDomain ?? "—"}</span>
            <span className="hint" style={{ display: "block" }}>
              The message is signed, and the signature checks out
            </span>
          </td>
          <td style={{ textAlign: "right" }}>{chip(auth.dkim)}</td>
        </tr>
        <tr>
          <td>
            <b>DMARC</b> <span className="mono">{fromDomain}</span>
            <span className="hint" style={{ display: "block" }}>
              SPF or DKIM passes for the From domain
            </span>
          </td>
          <td style={{ textAlign: "right" }}>{chip(auth.dmarc)}</td>
        </tr>
      </tbody>
    </table>
  )
  const policyLine =
    auth.dmarcPolicy && policy ? (
      <p className="t-body" data-od-id="test-dmarc-policy">
        <b>DMARC policy</b> <span className="mono">{auth.dmarcPolicy}</span>: {policy}
      </p>
    ) : null
  if (!heading)
    return (
      <>
        {table}
        {policyLine}
      </>
    )
  return (
    <div className="stack stack-8">
      <h3 className="t-h4">As a receiver saw it</h3>
      {table}
      {policyLine}
    </div>
  )
}

function AuthFailSentence({ auth, fromDomain }: { auth: Auth | null; fromDomain: string }) {
  if (!auth) return <b>Arrived, but its authentication didn’t pass.</b>
  const failed = (["spf", "dkim"] as const).filter((k) => auth[k] !== "pass").map((k) => k.toUpperCase())
  const dmarcFailed = auth.dmarc !== "pass"
  const head = failed.length
    ? `Arrived, but ${failed.join(" and ")} failed${dmarcFailed ? `, so DMARC failed too` : ""}.`
    : "Arrived, but DMARC failed."
  return (
    <>
      <b>{head}</b>{" "}
      {dmarcFailed && auth.dmarcPolicy === "none"
        ? `It got through because ${fromDomain}’s DMARC policy is none. Receivers that check ${failed.join(" and ") || "DMARC"} will send it to spam. `
        : dmarcFailed
          ? "Receivers that check DMARC will refuse it or send it to spam. "
          : ""}
      Check the records in step 2: one of them doesn’t match what Cloudflare signs and sends with.
    </>
  )
}

function SendForm({
  mailboxes,
  defaultFrom,
  probe,
  busy,
  error,
  onSend,
  onCancel,
}: {
  mailboxes: Array<{ id: string; address: string; displayName: string | null }>
  defaultFrom: string
  probe: string
  busy: boolean
  error: unknown
  onSend: (b: { from: string; to?: string }) => void
  onCancel: (() => void) | undefined
}) {
  const s = useSetup()
  const verified = useQuery(verifiedQuery)
  const [from, setFrom] = useState(defaultFrom)
  const [dest, setDest] = useState<"probe" | "own">("probe")
  const [own, setOwn] = useState<string>("")
  const [typed, setTyped] = useState("")
  const [toError, setToError] = useState<string | null>(null)
  const v = verified.data
  const addresses = v && v.available === true ? v.addresses : []

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (dest === "probe") return onSend({ from })
    const to = typed.trim() || own
    if (!to) return setToError("Pick a verified address, or type one.")
    if (!isEmail(to)) return setToError(`“${to}” isn’t an email address.`)
    setToError(null)
    onSend({ from, to })
  }

  return (
    <form className="step-form" onSubmit={submit} noValidate>
      <div className="field">
        <label className="label" htmlFor="ts-from">
          From
        </label>
        <select
          className="select"
          id="ts-from"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          disabled={busy}
        >
          {mailboxes.map((m) => (
            <option key={m.id} value={m.address}>
              {m.displayName ? `${m.displayName} <${m.address}>` : m.address}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
        <legend className="label" style={{ marginBottom: 6 }}>
          Send to
        </legend>
        <label className="check">
          <input type="radio" name="ts-dest" checked={dest === "probe"} onChange={() => setDest("probe")} />
          <span>
            <b>Mailyard’s test address</b> <span className="mono">{probe}</span>
            <span className="hint" style={{ display: "block" }}>
              Recommended. Mailyard receives it and reports SPF, DKIM and DMARC as a receiver saw them, plus
              the delivery time.
            </span>
          </span>
        </label>
        <label className="check" style={{ marginTop: 12 }}>
          <input type="radio" name="ts-dest" checked={dest === "own"} onChange={() => setDest("own")} />
          <span>
            <b>Send to my own address instead</b>
            <span className="hint" style={{ display: "block" }}>
              Reports delivery only: Mailyard can’t see another inbox’s authentication results.
            </span>
          </span>
        </label>
        {dest === "own" ? (
          <div className="stack stack-8" style={{ paddingLeft: 28, marginTop: 8 }}>
            {v && v.available === false ? (
              <div className="callout callout-info" data-od-id="verified-addresses-unavailable">
                <Icon name="info" />
                <div className="stack stack-4">
                  <span>
                    Can’t list your verified addresses until Mailyard has a read token (HAL-3318). Type the
                    address instead.
                  </span>
                  <span className="t-small muted">{v.reason}</span>
                </div>
              </div>
            ) : addresses.length ? (
              <div data-od-id="verified-addresses">
                <span className="t-small muted">Your verified addresses</span>
                {addresses.map((a) => (
                  <label key={a.email} className="check" style={{ marginTop: 6 }}>
                    <input
                      type="radio"
                      name="ts-own"
                      checked={own === a.email && !typed.trim()}
                      onChange={() => {
                        setOwn(a.email)
                        setTyped("")
                        setToError(null)
                      }}
                    />
                    <span>
                      <span className="mono">{a.email}</span>
                      <span className="hint" style={{ display: "block" }}>
                        Verified in Cloudflare{" "}
                        {new Date(num(a.verifiedAt) ?? 0).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          timeZone: "UTC",
                        })}
                      </span>
                    </span>
                  </label>
                ))}
                <p className="hint">
                  From Cloudflare Email Routing’s verified destination addresses. Add another there.
                </p>
              </div>
            ) : null}
            <div className="field">
              <label className="label" htmlFor="ts-to">
                {addresses.length ? "Or type another address" : "Your address"}
              </label>
              <input
                className="input mono"
                id="ts-to"
                type="email"
                placeholder="you@example.com"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value)
                  setToError(null)
                }}
                autoComplete="email"
                {...describe(toError, "ts-to-err", "ts-to-hint")}
              />
              {toError ? <FieldError id="ts-to-err">{toError}</FieldError> : null}
              <p className="hint" id="ts-to-hint">
                Any inbox you can open.
              </p>
            </div>
          </div>
        ) : null}
      </fieldset>
      {error ? <ApiErrorCallout error={error} what="The test wasn’t sent." /> : null}
      <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
        <Gated allowed={s.canSetUp} reason="You can’t send a test" who={SETUP_WHO}>
          <button className={`btn btn-primary${busy ? " is-loading" : ""}`} type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />}
            {busy ? "Sending the test…" : "Send the test"}
          </button>
        </Gated>
        {onCancel ? (
          <button className="btn btn-ghost" type="button" onClick={onCancel}>
            Back to the last result
          </button>
        ) : null}
      </div>
    </form>
  )
}
