/**
 * The re-auth sheet (design: auth/session-expired.html; GAPS 1.9; HANDOFF §4 "Session expired"): when any API
 * call answers 401 while you're in the app, this opens over the page instead of navigating away, so the page,
 * its scroll and any local draft stay exactly where they were. Signing in again (`POST /v1/session` with a key,
 * or the Flareyard handoff) closes it and refetches what failed.
 *
 * Mount it once inside the app frame: `<ReauthSheet />`, optionally with `kept` naming what's safe ("Your draft
 * to ada@… is saved on this device").
 */
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { type ApiError, onUnauthorized } from "../api/client.ts"
import { Icon } from "../ui/icons.tsx"
import { RequestId } from "../ui/Panel.tsx"
import { useCapabilities } from "./capabilities.ts"
import { Gated } from "./NoPermission.tsx"
import { keyLooksValid, type SignInError, signInError, useSessionActions } from "./session.ts"

type Ended = {
  at: number
  reason: string | undefined
  revokedAt: string | undefined
  requestId: string | undefined
}

const utc = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`
}

export function ReauthSheet({ kept }: { kept?: ReactNode }) {
  const [ended, setEnded] = useState<Ended | null>(null)
  useEffect(() => {
    const off = onUnauthorized((e: ApiError) => {
      // The first 401 opens the sheet; the ones that follow while it's open are the same story.
      setEnded(
        (cur) =>
          cur ?? {
            at: Date.now(),
            reason: e.reason,
            revokedAt: typeof e.body.revokedAt === "string" ? e.body.revokedAt : undefined,
            requestId: e.requestId,
          },
      )
    })
    return () => {
      off()
    }
  }, [])
  if (!ended) return null
  return <Sheet ended={ended} kept={kept} onDone={() => setEnded(null)} />
}

function Sheet({ ended, kept, onDone }: { ended: Ended; kept: ReactNode; onDone: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const caps = useCapabilities()
  const { signIn, signOut } = useSessionActions()
  const sessionsLive = caps.has("POST", "/v1/session")
  const flareyardLive = caps.has("GET", "/v1/session/flareyard/start")
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<SignInError | null>(null)
  const [wait, setWait] = useState(0)
  const sheet = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const returnTo = useRef<Element | null>(null)

  // Focus moves into the sheet and comes back to where it was when the sheet closes.
  useEffect(() => {
    returnTo.current = document.activeElement
    input.current?.focus()
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return () => {
      document.body.style.overflow = prevOverflow
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (error?.kind !== "rate-limited") return
    setWait(error.retryAfter)
    const t = setInterval(() => {
      setWait((w) => {
        if (w > 1) return w - 1
        clearInterval(t)
        return 0
      })
    }, 1000)
    return () => clearInterval(t)
  }, [error])

  /** Keep Tab inside the sheet while it's open: the page behind is inert until you're signed in. */
  const trap = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !sheet.current) return
    const items = [
      ...sheet.current.querySelectorAll<HTMLElement>(
        "a[href], button, input, [tabindex]:not([tabindex='-1'])",
      ),
    ].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null)
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!keyLooksValid(key)) {
      setError({ kind: "format" })
      input.current?.focus()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await signIn(key)
      setKey("")
      onDone()
      // Everything that failed while signed out loads again; nothing else on the page moves.
      await qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "me" })
    } catch (err) {
      setError(signInError(err))
      input.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  const leave = async () => {
    try {
      await signOut()
    } catch {
      // The session is already gone; signing out here only clears this page's data.
    }
    onDone()
    navigate({ to: "/signed-out" })
  }

  const why =
    ended.reason === "revoked"
      ? `The key behind your session was revoked${ended.revokedAt ? ` at ${utc(Date.parse(ended.revokedAt))}` : ""}.`
      : ended.reason === "session-expired"
        ? `Your session ended at ${utc(ended.at)}.`
        : `Mailyard stopped recognising this session at ${utc(ended.at)}.`
  const fieldError = error ? message(error) : null
  const limited = error?.kind === "rate-limited" && wait > 0
  const blocked = !sessionsLive
    ? {
        reason: "Browser sign-in isn’t live yet",
        who: "It arrives with sessions (HAL-3358). Reload and sign in from the sign-in page.",
      }
    : limited
      ? {
          reason: `Too many failed sign-ins from this network. Try again in ${wait} seconds.`,
          who: undefined,
        }
      : null

  return (
    <div
      className="sheet-wrap"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
      aria-describedby="reauth-why"
      data-endpoint="POST /v1/session (planned, HAL-3358) · GET /v1/session/flareyard/start (planned, HAL-3360)"
      data-od-id="reauth-sheet"
      style={{ zIndex: 80 }}
      onKeyDown={trap}
    >
      <div className="scrim" />
      <div className="sheet" ref={sheet} style={{ position: "relative", zIndex: 1 }}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <div className="stack stack-8">
            <span className="cluster" style={{ ["--gap" as string]: "6px" }}>
              <span className="pill pill-warn">
                <span className="dot" />
                Session ended
              </span>
              {caps.ready && !sessionsLive ? (
                <span className="pill pill-proposal" data-od-id="proposed-marker">
                  Planned · HAL-3358
                  <span className="sr-only">
                    . Signing in from the browser is part of sessions (HAL-3358).
                  </span>
                </span>
              ) : null}
            </span>
            <h2 className="t-h2" id="reauth-title">
              Sign in again to keep going
            </h2>
          </div>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="sheet-body">
            <p className="t-copy" id="reauth-why">
              {why} <b>{kept ?? "This page stays exactly as it is"}</b>
              {kept
                ? " and this page stays exactly as it is, so nothing is lost."
                : ", so nothing you were doing is lost."}
            </p>
            <p className="hint">
              Sessions last 14 days from your last visit and 30 days at most. One also ends early if its key
              is revoked or loses the <b>read</b> scope.
            </p>
            <Gated
              allowed={flareyardLive}
              reason="Flareyard sign-in isn’t live yet"
              who="It arrives with HAL-3360. Use an access key for now."
              block
            >
              <a
                className="btn btn-primary btn-lg btn-block fy-btn"
                href={`/v1/session/flareyard/start?return=${encodeURIComponent(window.location.pathname + window.location.search)}`}
                data-od-id="continue-with-flareyard"
              >
                <span
                  className="fy-chip"
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 22,
                    height: 22,
                    borderRadius: 4,
                    background: "var(--background-100)",
                  }}
                >
                  <img src="/ui/brand/flareyard-mark.svg" alt="" width={14} height={14} />
                </span>
                Continue with Flareyard
              </a>
            </Gated>
            <div className="or">or</div>
            <div className="field">
              <label className="label" htmlFor="rk">
                Access key
              </label>
              <input
                ref={input}
                className="input mono"
                id="rk"
                type="password"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value)
                  if (error && error.kind !== "rate-limited") setError(null)
                }}
                placeholder="sk_… or your admin key"
                autoComplete="off"
                spellCheck={false}
                disabled={busy || limited}
                {...(fieldError
                  ? { "aria-invalid": true, "aria-describedby": "rk-err" }
                  : { "aria-describedby": "rk-hint" })}
              />
              {fieldError ? (
                <div className="field-error" id="rk-err" role="alert">
                  <Icon name="x-circle" />
                  <div>{fieldError}</div>
                </div>
              ) : null}
              <p className="hint" id="rk-hint">
                Swapped for the <code className="mono">__Host-mailyard_session</code> cookie (HTTP-only),
                never kept in this page.
              </p>
            </div>
            {error?.kind === "unreachable" ? (
              <div className="callout callout-fail" role="alert">
                <Icon name="wifi-off" />
                <span>
                  <b>Mailyard isn’t answering.</b> Check your connection. Nothing was sent.
                </span>
              </div>
            ) : null}
            {error?.kind === "other" ? (
              <div className="callout callout-fail" role="alert">
                <Icon name="warn" />
                <div className="stack stack-4">
                  <span>{error.message}</span>
                  {error.requestId ? <RequestId id={error.requestId} /> : null}
                </div>
              </div>
            ) : null}
            {ended.requestId ? (
              <span className="t-small muted">
                The refused request: <RequestId id={ended.requestId} />
              </span>
            ) : null}
          </div>
          <div className="sheet-foot">
            <button className="btn btn-ghost" type="button" onClick={leave}>
              Sign out instead
            </button>
            <Gated allowed={!blocked} reason={blocked?.reason} who={blocked?.who} side="up">
              <button
                className={`btn btn-secondary${busy ? " is-loading" : ""}`}
                type="submit"
                disabled={busy}
              >
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {busy ? "Checking the key…" : limited ? `Try again in ${wait} s` : "Sign in with key"}
              </button>
            </Gated>
          </div>
        </form>
      </div>
    </div>
  )
}

function message(e: SignInError): string | null {
  switch (e.kind) {
    case "format":
      return "That isn’t a key Mailyard recognises. Secret keys start with sk_; the admin key is the whole value on your Flareyard install page."
    case "unknown":
      return "No key with that value exists in this workspace. It may belong to another Mailyard, or it was deleted."
    case "revoked":
      return "This key was revoked, so it can’t sign in. Use another key, or make one in Settings → API keys."
    case "public-key":
      return "That’s a public key (pk_). Public keys can only track events from a website, so they can’t open the app. Use a secret key (sk_) or the admin key."
    case "insufficient-scope":
      return `This key can’t open Mailyard: it needs the ${e.required} scope. Use a key with ${e.required}, or the admin key.`
    case "session-expired":
      return "That session has ended. Sign in with a key."
    default:
      return null
  }
}
