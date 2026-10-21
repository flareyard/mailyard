/**
 * Quick start (design: transactional/quickstart.html): snippets for POST /v1/send and POST /v1/track against
 * this Mailyard, and three live checks before the first send: a domain that can send, a secret key with send,
 * and one message in the log.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import { api, unwrap } from "../api/client.ts"
import { CodeBlock, CodeTabs } from "../ops/Copy.tsx"
import { Icon } from "../ui/icons.tsx"
import { HeadActions } from "./Layout.tsx"
import { andList } from "./logic.ts"
import { domainsQuery, keysQuery } from "./queries.ts"

export function Quickstart() {
  const origin = typeof window === "undefined" ? "https://your-mailyard" : window.location.origin
  const send = [
    {
      id: "curl",
      label: "curl",
      code: `curl ${origin}/v1/send \\
  -H "Authorization: Bearer $MAILYARD_KEY" \\
  -H "Idempotency-Key: order-1042-receipt" \\
  -H "Content-Type: application/json" \\
  -d '{"to":"ada@example.com","template":"payment-receipt","data":{"course":"Data foundations","amount":"$120.00"}}'`,
    },
    {
      id: "ts",
      label: "TypeScript",
      code: `const res = await fetch("${origin}/v1/send", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.MAILYARD_KEY}\`,
    "Idempotency-Key": \`order-\${order.id}-receipt\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    to: order.email,
    template: "payment-receipt",
    data: { course: order.course, amount: order.amountText },
  }),
})
// 200 { success: true, data: { emails: [{ email, status }], timestamp } }`,
    },
    {
      id: "plunk",
      label: "Plunk SDK",
      code: `import Plunk from "@plunk/node"

// Point the Plunk SDK at your Mailyard. Nothing else changes.
const plunk = new Plunk(process.env.MAILYARD_KEY, { baseUrl: "${origin}/v1" })

await plunk.emails.send({ to: "ada@example.com", subject: "Your receipt", body: html })
await plunk.events.track({ event: "course-completed", email: "ada@example.com", data: { course: "Data foundations" } })`,
    },
  ]
  const track = `curl ${origin}/v1/track \\
  -H "Authorization: Bearer pk_…" \\
  -H "Content-Type: application/json" \\
  -d '{"event":"signed-up","email":"ada@example.com","subscribed":true,"data":{"plan":"trial"}}'
# 200 { success: true, data: { contact, event, timestamp } } · a public pk_ key is enough`

  return (
    <>
      <HeadActions>
        <Link className="btn btn-primary" to="/transactional/keys">
          <Icon name="key" />
          Create a key
        </Link>
      </HeadActions>
      <div className="split-2">
        <div className="stack">
          <section
            className="panel"
            data-endpoint="POST /v1/send"
            data-od-id="panel-send"
            aria-labelledby="h-send"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-send">
                Send an email · POST /v1/send
              </h2>
            </header>
            <div className="panel-body">
              <div className="stack stack-12">
                <CodeTabs tabs={send} label="Send snippets" />
                <p className="hint">
                  Send the same <span className="mono">Idempotency-Key</span> twice and you get the first
                  result back, not a second email. A different body with the same key is a{" "}
                  <span className="mono">409</span>.
                </p>
              </div>
            </div>
          </section>
          <section
            className="panel"
            data-endpoint="POST /v1/track"
            data-od-id="panel-track"
            aria-labelledby="h-track"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-track">
                Track an event · POST /v1/track
              </h2>
            </header>
            <div className="panel-body">
              <CodeBlock title="Track" code={track} />
            </div>
          </section>
        </div>
        <div className="stack">
          <Checks />
          <section className="panel" data-endpoint="static" data-od-id="panel-smtp" aria-labelledby="h-smtp">
            <header className="panel-head">
              <h2 className="panel-title" id="h-smtp">
                SMTP for older apps
              </h2>
            </header>
            <div className="panel-body">
              <dl className="kv">
                <dt>Host</dt>
                <dd>
                  <span className="mono">smtp.mx.cloudflare.net</span>
                </dd>
                <dt>Port</dt>
                <dd>
                  <span className="mono">465</span> (TLS) or <span className="mono">587</span> (STARTTLS)
                </dd>
                <dt>Username</dt>
                <dd>
                  <span className="mono">api_token</span>
                </dd>
                <dt>Password</dt>
                <dd>A Cloudflare API token with Email Sending: Send, for your domain</dd>
                <dt>From</dt>
                <dd>Any address on a domain with sending on</dd>
              </dl>
              <p className="hint" style={{ marginTop: 10 }}>
                SMTP mail goes through Cloudflare directly, so it shows in this log only from the events
                Cloudflare publishes. Use the API when you need templates and idempotency.
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}

type Check = { state: "pass" | "fail" | "running" | "todo"; title: string; body: ReactNode }

function Checks() {
  const domains = useQuery(domainsQuery)
  const keys = useQuery(keysQuery)
  const sent = useQuery({
    queryKey: ["messages", "list", "any"],
    queryFn: () => unwrap(api.GET("/v1/messages", { params: { query: { limit: "1" } } })),
  })
  const senders = (domains.data?.domains ?? []).filter((d) => d.sending && d.checkStatus === "pass")
  const sendKeys = (keys.data?.keys ?? []).filter(
    (k) => k.kind === "secret" && !k.revokedAt && k.scopes.includes("send"),
  )
  const checks: Check[] = [
    domains.isPending
      ? { state: "running", title: "A domain that can send", body: "Checking your domains…" }
      : senders.length
        ? {
            state: "pass",
            title: "A domain that can send",
            body: (
              <>
                {andList(senders.map((d) => d.name))} pass{senders.length === 1 ? "es" : ""} every sending
                record.
              </>
            ),
          }
        : {
            state: domains.isError ? "todo" : "fail",
            title: "A domain that can send",
            body: domains.isError ? (
              "Your domains couldn’t be read with this key. Owners and admins can see them under Domains."
            ) : (
              <>
                No domain passes its sending records yet.{" "}
                <Link to="/domains">Add or fix one under Domains</Link>.
              </>
            ),
          },
    keys.isPending
      ? { state: "running", title: "A secret key with the send scope", body: "Checking your keys…" }
      : sendKeys.length
        ? {
            state: "pass",
            title: "A secret key with the send scope",
            body: `${sendKeys.length} active key${sendKeys.length === 1 ? "" : "s"}. Create one per app so you can revoke one without breaking the others.`,
          }
        : {
            state: keys.isError ? "todo" : "fail",
            title: "A secret key with the send scope",
            body: keys.isError ? (
              "Keys couldn’t be listed with this sign-in. An owner or admin can create one under API keys."
            ) : (
              <>
                None yet. <Link to="/transactional/keys">Create a key</Link> with send, and put it in your
                app’s secrets.
              </>
            ),
          },
    sent.data?.messages.length
      ? {
          state: "pass",
          title: "Send one to yourself",
          body: (
            <>
              Done: the log has sends. <Link to="/transactional/messages">Open the message log</Link>.
            </>
          ),
        }
      : {
          state: "todo",
          title: "Send one to yourself",
          body: "Use the snippet with your own address. Sends to your verified addresses are free.",
        },
  ]
  return (
    <section
      className="panel"
      data-endpoint="GET /v1/domains · GET /v1/api-keys · GET /v1/messages?limit=1"
      data-od-id="panel-steps"
      aria-labelledby="h-steps"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-steps">
          Before you send
        </h2>
      </header>
      <div className="panel-body">
        <ol className="checks" data-od-id="quickstart-steps">
          {checks.map((c, i) => (
            <li
              key={c.title}
              className={`chk${c.state === "pass" ? " is-pass" : c.state === "fail" ? " is-fail" : c.state === "running" ? " is-running" : ""}`}
            >
              <span className="chk-n">
                {c.state === "pass" ? <Icon name="check" /> : c.state === "fail" ? <Icon name="x" /> : i + 1}
              </span>
              <span className="chk-title">{c.title}</span>
              {c.state === "pass" ? (
                <span className="pill pill-pass">
                  <span className="dot" />
                  Passing
                </span>
              ) : c.state === "fail" ? (
                <span className="pill pill-fail">
                  <span className="dot" />
                  Not yet
                </span>
              ) : (
                <span />
              )}
              <div className="chk-body">
                <span>{c.body}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="hint" style={{ marginTop: 12 }}>
          Every field, templates, idempotency and webhooks are in the docs:{" "}
          <a href="/docs/sending">Sending email</a>.
        </p>
      </div>
    </section>
  )
}
