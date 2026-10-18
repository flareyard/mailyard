/**
 * The third way in on /sign-in (design: auth/sign-in.html leaves room under "or"): email me a sign-in link.
 * The sent state never says whether the address is a member, because the API doesn't either.
 */
import { type FormEvent, useEffect, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import { useCapabilities } from "./capabilities.ts"
import { emailLooksValid, type LinkOutcome, linkOutcome } from "./emailLink.ts"
import { Gated } from "./NoPermission.tsx"

export function EmailLinkForm() {
  const caps = useCapabilities()
  const live = caps.has("POST", "/v1/session/link")
  const input = useRef<HTMLInputElement>(null)
  const [email, setEmail] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<LinkOutcome | null>(null)
  const [wait, setWait] = useState(0)

  useEffect(() => {
    if (outcome?.kind !== "rate-limited") return
    setWait(outcome.retryAfter)
    const t = setInterval(() => {
      setWait((w) => {
        if (w > 1) return w - 1
        clearInterval(t)
        return 0
      })
    }, 1000)
    return () => clearInterval(t)
  }, [outcome])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const v = email.trim()
    if (!emailLooksValid(v)) {
      setFieldError("Type the email address you were invited with, like you@example.com.")
      input.current?.focus()
      return
    }
    setFieldError(null)
    setBusy(true)
    try {
      await unwrap(api.POST("/v1/session/link", { body: { email: v } }))
      setOutcome(linkOutcome(v, {}))
    } catch (err) {
      setOutcome(linkOutcome(v, { error: err }))
    } finally {
      setBusy(false)
    }
  }

  if (outcome?.kind === "sent")
    return (
      <div className="stack stack-12" data-od-id="email-link-sent">
        <div className="callout callout-ok" role="status">
          <Icon name="envelope" />
          <span>
            <b>
              If <span className="mono">{outcome.email}</span> is a member, a link is on its way.
            </b>{" "}
            Open it on this device to sign in. Nothing arrived? Check spam, or ask for another in a minute.
          </span>
        </div>
        <button
          className="btn btn-secondary btn-lg btn-block"
          type="button"
          onClick={() => {
            setOutcome(null)
            requestAnimationFrame(() => input.current?.focus())
          }}
        >
          Use another address
        </button>
      </div>
    )

  const limited = outcome?.kind === "rate-limited" && wait > 0
  const blocked = !live
    ? {
        reason: "Email sign-in isn’t on this Mailyard",
        who: "Update the deploy to a release with people and roles (HAL-3361).",
      }
    : outcome?.kind === "no-sender"
      ? {
          reason: "This Mailyard can’t send sign-in links yet",
          who: "An owner sets a system sender first. Use an access key meanwhile.",
        }
      : limited
        ? { reason: `Too many links asked for. Try again in ${wait} seconds.`, who: undefined }
        : null

  return (
    <form
      className="stack stack-12"
      onSubmit={submit}
      noValidate
      data-endpoint="POST /v1/session/link (built, HAL-3361)"
    >
      <div className="field">
        <label className="label" htmlFor="link-email">
          Email
        </label>
        <input
          ref={input}
          className="input mono"
          id="link-email"
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setFieldError(null)
            if (outcome?.kind === "other" || outcome?.kind === "unreachable") setOutcome(null)
          }}
          placeholder="you@example.com"
          autoComplete="email"
          spellCheck={false}
          disabled={busy}
          {...(fieldError
            ? { "aria-invalid": true, "aria-describedby": "link-err" }
            : { "aria-describedby": "link-hint" })}
        />
        {fieldError ? (
          <div className="field-error" id="link-err" role="alert">
            <Icon name="x-circle" />
            <div>{fieldError}</div>
          </div>
        ) : null}
        <p className="hint" id="link-hint">
          For people who’ve joined this workspace. The link signs you in once.
        </p>
      </div>
      {outcome?.kind === "no-sender" ? (
        <div className="callout callout-warn" role="alert" data-od-id="email-link-no-sender">
          <Icon name="warn" />
          <span>
            <b>This Mailyard can’t send sign-in links yet: no system sender is set.</b> Sign in with an access
            key, or ask an owner to set one.
          </span>
        </div>
      ) : null}
      {outcome?.kind === "unreachable" ? (
        <div className="callout callout-fail" role="alert">
          <Icon name="wifi-off" />
          <span>
            <b>Mailyard isn’t answering.</b> Check your connection. Nothing was sent.
          </span>
        </div>
      ) : null}
      {outcome?.kind === "other" ? (
        <div className="callout callout-fail" role="alert">
          <Icon name="warn" />
          <div className="stack stack-4">
            <span>{outcome.message}</span>
            {outcome.requestId ? <RequestId id={outcome.requestId} /> : null}
          </div>
        </div>
      ) : null}
      <Gated allowed={!blocked} reason={blocked?.reason} who={blocked?.who} block>
        <button
          className={`btn btn-secondary btn-lg btn-block${busy ? " is-loading" : ""}`}
          type="submit"
          disabled={busy}
        >
          {busy ? <span className="spinner" aria-hidden="true" /> : <Icon name="envelope" />}
          {busy ? "Sending…" : limited ? `Try again in ${wait} s` : "Email me a sign-in link"}
        </button>
      </Gated>
    </form>
  )
}
