/**
 * Settings → Gmail mode (design: gmail-mode, -done, -fail; GAPS-ops 4.6). `GET /v1/gmail-mode` and
 * `POST /v1/gmail-mode/check` are Planned · HAL-3314 and absent from the live OpenAPI, so the page shows the
 * setup as a guide with its checks waiting and Check off, and turns live by itself when the routes ship
 * (`useCapabilities`). Fixture mode renders the design's sample of the planned response.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError } from "../api/client.ts"
import { fixtureFetch, fixturesEnabled } from "../fixtures/mode.ts"
import { CopyChip } from "../ops/Copy.tsx"
import { NeedsRoute, PlannedPill, useRoute } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import { SectionHead } from "./ui.tsx"

type Status = "pass" | "running" | "waiting" | "fail"
/** The planned response (GAPS-ops 4.6), typed by hand until the route is in the OpenAPI. */
type GmailMode = {
  address: string
  gmail: string
  steps: { id: string; title: string; status: Status; detail: string; checkedAt: number | null }[]
}

const SMTP = { host: "smtp.mx.cloudflare.net", port: 465, security: "SSL", username: "api_token" }

/** The four steps as they read before anything is checked: the guide production shows today. */
const GUIDE: GmailMode["steps"] = [
  {
    id: "verify",
    title: "Verify your Gmail address with Cloudflare",
    status: "waiting",
    detail: "Cloudflare sends a link to your Gmail address; click it to verify it as a destination.",
    checkedAt: null,
  },
  {
    id: "route",
    title: "Route your address to Gmail",
    status: "waiting",
    detail: "An Email Routing rule forwards a copy to Gmail and keeps one in Mailyard.",
    checkedAt: null,
  },
  {
    id: "smtp",
    title: "Add “Send mail as” in Gmail",
    status: "waiting",
    detail: "In Gmail, Settings → Accounts → Send mail as, with Cloudflare’s SMTP server:",
    checkedAt: null,
  },
  {
    id: "test",
    title: "Send a test from Gmail as your address",
    status: "waiting",
    detail: "We check SPF, DKIM and DMARC on the message Gmail sends.",
    checkedAt: null,
  },
]

const PILL: Record<Status, { cls: string; text: string }> = {
  pass: { cls: "pill-pass", text: "Passing" },
  running: { cls: "pill-info", text: "Checking live" },
  waiting: { cls: "pill-neutral", text: "Next" },
  fail: { cls: "pill-fail", text: "Failing" },
}

/** The route isn't in the typed client yet, so it's fetched by hand (through the fixture table in fixture mode). */
async function fetchGmail(): Promise<GmailMode> {
  const req = new Request(new URL("/v1/gmail-mode", window.location.origin), { credentials: "same-origin" })
  const r = await (fixturesEnabled() ? fixtureFetch(req) : fetch(req))
  if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({ message: r.statusText })))
  return (await r.json()) as GmailMode
}

export function GmailModePage() {
  const live = useRoute("GET", "/v1/gmail-mode")
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["gmail-mode"],
    queryFn: fetchGmail,
    enabled: live,
    refetchInterval: (query) => (query.state.data?.steps.some((s) => s.status === "running") ? 5_000 : false),
  })
  const planned = fixturesEnabled() || !live
  const data = live ? q.data : undefined
  const steps = data?.steps ?? GUIDE
  const allPass = data ? steps.every((s) => s.status === "pass") : false
  return (
    <>
      <SectionHead title="Gmail mode" sub="Use Gmail as the inbox for one address on your domain." />
      <section
        className="panel"
        data-endpoint="GET /v1/gmail-mode · POST /v1/gmail-mode/check (planned, HAL-3314)"
        data-od-id="panel-gmail"
        aria-labelledby="h-gmail"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-gmail">
            Set up Gmail mode
            {planned ? <PlannedPill issue="HAL-3314" /> : null}
          </h2>
          <div className="cluster">
            <span className="panel-meta">
              {live ? "checks tick on their own" : "checks start when HAL-3314 ships"}
            </span>
          </div>
        </header>
        <div className="panel-body">
          {live && q.isPending ? (
            <PanelSkeleton rows={4} />
          ) : live && q.isError ? (
            <PanelError error={q.error} onRetry={() => q.refetch()} what="Gmail mode didn’t load" />
          ) : (
            <>
              <div className="callout callout-info" style={{ marginBottom: 12 }}>
                <Icon name="info" />
                <span>
                  Gmail mode gives{" "}
                  {data ? <span className="mono">{data.address}</span> : "one address on your domain"} a real
                  Gmail inbox at no seat cost: Cloudflare forwards mail to{" "}
                  {data ? <span className="mono">{data.gmail}</span> : "your Gmail address"}, and Gmail sends
                  as your address through Cloudflare’s SMTP. It suits one owner, because the token can send as
                  any domain on the account.
                </span>
              </div>
              <ol className="checks" data-od-id="gmail-steps">
                {steps.map((s, i) => (
                  <li key={s.id} className={`chk is-${s.status}`}>
                    <span className="chk-n">
                      {s.status === "pass" ? (
                        <Icon name="check" />
                      ) : s.status === "fail" ? (
                        <Icon name="x" />
                      ) : (
                        i + 1
                      )}
                    </span>
                    <span className="chk-title">{s.title}</span>
                    <span className={`pill ${PILL[s.status].cls}`}>
                      <span className="dot" />
                      {data ? PILL[s.status].text : "Not checked"}
                    </span>
                    <div className="chk-body">
                      {s.id === "smtp" && s.status === "fail" ? null : s.detail}
                      {s.id === "smtp" ? (
                        <>
                          <dl className="kv" style={{ marginTop: 6 }}>
                            <dt>SMTP server</dt>
                            <dd>
                              <span className="mono">{SMTP.host}</span>{" "}
                              <CopyChip value={SMTP.host} what="host" />
                            </dd>
                            <dt>Port</dt>
                            <dd>
                              <span className="mono">{SMTP.port}</span> · {SMTP.security}
                            </dd>
                            <dt>Username</dt>
                            <dd>
                              <span className="mono">{SMTP.username}</span>{" "}
                              <CopyChip value={SMTP.username} what="username" />
                            </dd>
                            <dt>Password</dt>
                            <dd>a Cloudflare API token with Email Sending: Send</dd>
                          </dl>
                          {s.status === "fail" ? (
                            <div className="callout callout-error">
                              <Icon name="x-circle" />
                              <span>{s.detail}</span>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                      {s.status === "fail" || (!data && s.id === "verify") ? (
                        <div style={{ marginTop: 8 }}>
                          <NeedsRoute
                            method="POST"
                            path="/v1/gmail-mode/check"
                            issue="HAL-3314"
                            what="Checking Gmail mode"
                          >
                            <button
                              className="btn btn-secondary btn-sm"
                              type="button"
                              onClick={() => qc.invalidateQueries({ queryKey: ["gmail-mode"] })}
                            >
                              <Icon name="refresh" />
                              {data ? "Check again" : "Start checking"}
                            </button>
                          </NeedsRoute>
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
              {allPass && data ? (
                <div className="callout callout-ok" style={{ marginTop: 12 }}>
                  <Icon name="check-circle" />
                  <span>
                    <b>Gmail mode is on.</b> Replies from Gmail pass SPF, DKIM and DMARC as{" "}
                    {data.address.split("@")[1]}.
                  </span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </>
  )
}
