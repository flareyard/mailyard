/**
 * From the library (design: templates.html; HANDOFF-ops §21, HAL-3304): the templates that ship in the user's
 * Mailyard repo (`src/templates/library`). This is repo content: the web app never installs them, so the panel
 * carries the "In your repo" marker, shows the command, and says what a dry run would do here, from the names
 * this workspace already has.
 */
import { CodeBlock } from "../../ops/Copy.tsx"
import { Icon } from "../../ui/icons.tsx"

type LibTemplate = {
  slug: string
  name: string
  sub: string
  reads: string
}

/** The library as shipped in src/templates/library (welcome.ts, receipt.ts). */
const LIBRARY: LibTemplate[] = [
  {
    slug: "welcome",
    name: "Welcome",
    sub: "Sent once, right after someone signs up: what to do first.",
    reads:
      "Reads name, email, unsubscribe_url and trigger.url. Sent by an automation on a tracked signed_up event.",
  },
  {
    slug: "receipt",
    name: "Receipt",
    sub: "Sent after a payment, from your own code (POST /v1/send with data), with the order’s lines and total.",
    reads: "Reads name, email and data.order, data.item, data.amount, data.url.",
  },
]

export function Library({ existing }: { existing: Set<string> }) {
  const origin = typeof window === "undefined" ? "https://your-mailyard" : window.location.origin
  const has = (t: LibTemplate) => existing.has(t.slug) || existing.has(t.name)
  const dry = LIBRARY.map((t) =>
    has(t)
      ? `${t.slug}: would add a new draft version of "${t.name}"`
      : `${t.slug}: would create "${t.name}" as a draft`,
  ).join("\n")
  return (
    <section
      className="panel"
      data-endpoint="none: repo content (src/templates/library; HAL-3304) · bun run templates:install calls GET /v1/templates, POST /v1/templates, PUT /v1/templates/{id}/draft, POST /v1/templates/{id}/publish"
      data-od-id="panel-library"
      aria-labelledby="h-library"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-library">
          From the library
        </h2>
        <div className="cluster">
          <span className="pill pill-repo" data-od-id="repo-marker">
            <Icon name="code" />
            In your repo
            <span className="sr-only">
              . Files in your Mailyard repo, used by your coding agent or a CLI command. The web app doesn’t
              run them, and there’s no API behind this.
            </span>
          </span>
        </div>
      </header>
      <div className="panel-body">
        <div className="stack stack-16">
          <p className="muted">
            Templates that ship with your Mailyard repo, in{" "}
            <span className="mono">src/templates/library</span>: welcome, receipt.{" "}
            <span className="mono">bun run check</span> renders each one, so a broken template never ships. A
            command in your repo copies them into this workspace through the API; this screen doesn’t install
            anything itself.
          </p>
          <div className="lib-grid">
            {LIBRARY.map((t) => (
              <div className="lib-card" data-od-id={`lib-${t.slug}`} key={t.slug}>
                <div className="lc-head">
                  <b>
                    {t.name} <code className="tag">{t.slug}</code>
                  </b>
                  <span className="pill pill-neutral">
                    <span className="dot" />
                    {has(t)
                      ? "In this workspace: install adds a draft"
                      : "Not in this workspace: install creates it"}
                  </span>
                </div>
                <p className="lc-sub">{t.sub}</p>
                <p className="t-small muted" style={{ margin: 0 }}>
                  {t.reads}
                </p>
                {t.slug === "welcome" ? <WelcomePreview /> : <ReceiptPreview />}
                <p className="t-small muted" style={{ margin: 0 }}>
                  Rendered with its own sample data (<span className="mono">sample</span> in{" "}
                  <span className="mono">src/templates/library/{t.slug}.ts</span>).
                </p>
              </div>
            ))}
          </div>
          <CodeBlock
            title="In your Mailyard repo"
            code={`MAILYARD_URL=${origin} MAILYARD_KEY=<admin key> bun run templates:install --dry-run`}
          />
          <dl className="kv">
            <dt>Usage</dt>
            <dd>
              <span className="mono">
                MAILYARD_URL=… MAILYARD_KEY=&lt;admin key&gt; bun run templates:install [--dry-run]
                [--publish] [slug…]
              </span>
            </dd>
            <dt>Matched by name</dt>
            <dd>
              <span>
                A name that’s new here creates the template. A name that exists gets a{" "}
                <b>new draft version</b>; the live version keeps sending until you publish.
              </span>
            </dd>
            <dt>
              <span className="mono">--publish</span>
            </dt>
            <dd>
              <span>
                Publishes what it installs, which is what automations and{" "}
                <span className="mono">POST /v1/send</span> use. Without it, everything lands as a draft and
                sends nothing.
              </span>
            </dd>
            <dt>
              <span className="mono">--dry-run</span>
            </dt>
            <dd>Says what it would do and changes nothing. Name slugs to install only those.</dd>
          </dl>
          <div className="stack stack-8">
            <span className="label">
              What <span className="mono">--dry-run</span> prints for this workspace
            </span>
            <pre className="term-out" data-od-id="dry-run-out">
              {dry}
            </pre>
          </div>
          <p className="skill-hint" data-od-id="skill-hint">
            <Icon name="zap" />
            <span>
              Need an email the library doesn’t have, like a birthday email? Ask your coding agent: the{" "}
              <code className="mono">add-template</code> skill adds one to the library, with sample data and a
              test. <span className="sh-where">In your repo, not this app.</span>
            </span>
          </p>
        </div>
      </div>
    </section>
  )
}

function WelcomePreview() {
  return (
    <div className="lib-email" role="img" aria-label="Preview of Welcome with its sample data">
      <div className="le-bar">
        <b>Welcome, Ada</b>
        <span>Three steps to get going.</span>
      </div>
      <div className="le-body">
        <h3 className="le-h">Welcome, Ada</h3>
        <p>Thanks for signing up. Here’s how to get the most out of it.</p>
        <ol className="le-steps">
          <li>
            <b>Finish your profile</b>
            <span>So we can tailor what you see.</span>
          </li>
          <li>
            <b>Try the main feature</b>
            <span>It takes about two minutes.</span>
          </li>
          <li>
            <b>Tell us how it went</b>
            <span>Reply to this email: a person reads every one.</span>
          </li>
        </ol>
        <span className="le-btn">Get started</span>
        <p className="le-foot">
          You’re getting this because you signed up with ada@example.com. · <u>Unsubscribe</u>
        </p>
      </div>
    </div>
  )
}

function ReceiptPreview() {
  return (
    <div className="lib-email" role="img" aria-label="Preview of Receipt with its sample data">
      <div className="le-bar">
        <b>Your receipt for A-1042</b>
        <span>Thanks for your payment.</span>
      </div>
      <div className="le-body">
        <h3 className="le-h">Thanks, Ada</h3>
        <p>We’ve received your payment for order A-1042.</p>
        <dl className="le-receipt">
          <dt>Annual plan</dt>
          <dd>$120.00</dd>
          <dt className="is-total">Total</dt>
          <dd className="is-total">$120.00</dd>
        </dl>
        <span className="le-btn is-ghost">View your order</span>
        <p className="le-foot">You’re getting this because you made a payment with ada@example.com.</p>
      </div>
    </div>
  )
}
