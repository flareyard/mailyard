/**
 * Step 3, preview (design: campaign-preview.html, -dark, -links; GAPS-audience A7.4, A7.14, A7.16). The saved
 * campaign rendered by `POST /v1/campaigns/{id}/render` as a chosen contact, in a desktop and a phone frame, in a
 * client-side dark preview, or as plain text; its headers, size and the links table with stored statuses ("Check
 * links now" sends `checkLinks: true`). Send a test to verified and seed addresses; `lastTest` lists what each got.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { fieldsQuery } from "../../audience/kit/queries.ts"
import { ApiErrorCallout, useCan, useNow } from "../../audience/kit/ui.tsx"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtBytes } from "../../first-run/logic.ts"
import { fmtAgo, fmtInt, num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { PanelError } from "../../ui/Panel.tsx"
import { agentRefusal, linkPill } from "../logic.ts"
import {
  type Campaign,
  complianceQuery,
  type Render,
  type RenderLink,
  renderQuery,
  sampleContactsQuery,
  verifiedQuery,
} from "../queries.ts"
import { AGENT_WHO, AgentRefusalCallout, AppLink } from "../ui.tsx"
import { BlockView } from "./BlockCanvas.tsx"
import { useEditor } from "./EditorContext.tsx"
import { EditorFrame } from "./EditorFrame.tsx"
import { useFocusParam } from "./focus.ts"

const MAX_BYTES = 5 * 1024 * 1024

type Show = "frames" | "dark" | "text"

/** Fixture variants answer render with either the full body or only its links. */
const asRender = (v: unknown): Render | null =>
  v && typeof v === "object" && !Array.isArray(v) && "html" in v ? (v as Render) : null
const asLinks = (v: unknown): RenderLink[] | null =>
  Array.isArray(v)
    ? (v as RenderLink[])
    : v && typeof v === "object" && "links" in v
      ? (v as Render).links
      : null

export function PreviewStep({ focus }: { focus?: string | undefined }) {
  const ed = useEditor()
  const c = ed.draft
  const contacts = useQuery(sampleContactsQuery)
  const [contactId, setContactId] = useState<string | undefined>(undefined)
  const [variant, setVariant] = useState<"a" | "b">("a")
  const [show, setShow] = useState<Show>("frames")
  const version = num(ed.server.updatedAt)
  const render = useQuery(
    renderQuery(ed.id, { contactId: contactId ?? contacts.data?.[0]?.id, variant, version }),
  )
  useFocusParam(
    focus === "plain-text" || focus === "bodyText" ? "plain-text" : focus === "test" ? "test" : undefined,
  )
  const r = asRender(render.data)
  const pickedContact = contacts.data?.find((x) => x.id === (contactId ?? contacts.data?.[0]?.id))

  return (
    <EditorFrame step="preview">
      {ed.state === "dirty" || ed.state === "saving" ? (
        <div className="callout callout-info" role="status" style={{ marginBottom: 16 }}>
          <Icon name="refresh" />
          <span>Showing the last saved version; your changes render once they save.</span>
        </div>
      ) : null}
      <div className="editor cmp-editor">
        <div className="stack">
          <section
            className="panel"
            data-endpoint={`POST /v1/campaigns/${ed.id}/render {contactId, variant}`}
            data-od-id="panel-render"
            aria-labelledby="h-render"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-render">
                Render
              </h2>
            </header>
            <div className="panel-body">
              <div className="stack">
                <div className="spread" style={{ alignItems: "flex-end" }}>
                  <div className="field" style={{ minWidth: "min(240px, 100%)" }}>
                    <label className="label" htmlFor="as">
                      Render as
                    </label>
                    <select
                      className="select"
                      id="as"
                      value={contactId ?? contacts.data?.[0]?.id ?? ""}
                      onChange={(e) => setContactId(e.target.value || "")}
                    >
                      {(contacts.data ?? []).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name ? `${x.name} · ${x.email}` : x.email}
                        </option>
                      ))}
                      <option value="">A contact with every field empty</option>
                    </select>
                  </div>
                  <div className="cluster">
                    {c.subjectB !== null ? (
                      // biome-ignore lint/a11y/useSemanticElements: the design's .seg button group
                      <div className="seg" role="group" aria-label="Variant">
                        <button type="button" aria-pressed={variant === "a"} onClick={() => setVariant("a")}>
                          Subject A
                        </button>
                        <button type="button" aria-pressed={variant === "b"} onClick={() => setVariant("b")}>
                          Subject B
                        </button>
                      </div>
                    ) : null}
                    {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg button group */}
                    <div className="seg" role="group" aria-label="Show">
                      <button
                        type="button"
                        aria-pressed={show === "frames"}
                        onClick={() => setShow("frames")}
                      >
                        <Icon name="monitor-phone" />
                        Desktop and phone
                      </button>
                      <button type="button" aria-pressed={show === "dark"} onClick={() => setShow("dark")}>
                        <Icon name="moon" />
                        Dark mode
                      </button>
                      <button
                        type="button"
                        aria-pressed={show === "text"}
                        onClick={() => {
                          setShow("text")
                          setTimeout(
                            () => document.getElementById("plain-text")?.scrollIntoView({ block: "center" }),
                            30,
                          )
                        }}
                      >
                        <Icon name="file" />
                        Plain text
                      </button>
                    </div>
                  </div>
                </div>
                {render.isPending ? (
                  <div className="frames" aria-busy="true">
                    <div className="devframe">
                      <div className="df-body" style={{ padding: 24 }}>
                        <span className="sk sk-title" />
                        <span className="sk sk-text" />
                        <span className="sk sk-text" />
                      </div>
                    </div>
                  </div>
                ) : render.isError ? (
                  <PanelError
                    error={render.error}
                    onRetry={() => render.refetch()}
                    what="The render didn’t load"
                  />
                ) : (
                  <div className="frames" data-od-id="render-frames">
                    <Frame
                      r={r}
                      c={c}
                      to={pickedContact?.email ?? null}
                      phone={false}
                      dark={show === "dark"}
                    />
                    <Frame r={r} c={c} to={pickedContact?.email ?? null} phone dark={show === "dark"} />
                  </div>
                )}
                <details
                  className="stack stack-8"
                  id="plain-text"
                  tabIndex={-1}
                  open={show === "text" || undefined}
                >
                  <summary className="label" style={{ cursor: "pointer", minHeight: 24 }}>
                    Plain-text version
                  </summary>
                  <pre
                    className="plaintext"
                    style={{ border: "1px solid var(--my-border)", borderRadius: "var(--radius-base)" }}
                  >
                    {r?.text ?? "—"}
                  </pre>
                </details>
              </div>
            </div>
          </section>
          <section
            className="panel"
            data-endpoint="POST /v1/campaigns/:id/render → headers"
            data-od-id="panel-headers"
            aria-labelledby="h-headers"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-headers">
                Headers
              </h2>
            </header>
            <div className="panel-body">
              {r ? (
                <dl className="kv">
                  {Object.entries(r.headers ?? {}).map(([k, v]) => (
                    <div key={k} style={{ display: "contents" }}>
                      <dt>{k}</dt>
                      <dd>
                        <code className="mono" style={{ overflowWrap: "anywhere" }}>
                          {v}
                        </code>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <span className="sk sk-text" />
              )}
            </div>
          </section>
        </div>
        <div className="side">
          <TestPanel />
          <section
            className="panel"
            data-endpoint="POST /v1/campaigns/:id/render → size"
            data-od-id="panel-size"
            aria-labelledby="h-size"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-size">
                Size
              </h2>
            </header>
            <div className="panel-body">
              {r ? (
                <div className="sizebar">
                  <div className="sb-row">
                    <span>This email</span>
                    <b>{fmtBytes(r.size)} of 5 MiB</b>
                  </div>
                  {/* biome-ignore lint/a11y/useSemanticElements: the design's styled .meter, as the shell's quota meter */}
                  <div
                    className={`meter${(num(r.size) ?? 0) > MAX_BYTES * 0.8 ? " is-warn" : ""}`}
                    role="meter"
                    aria-valuenow={num(r.size) ?? 0}
                    aria-valuemax={MAX_BYTES}
                    aria-label="Size against 5 MiB"
                  >
                    <span
                      style={{
                        width: `${Math.min(100, Math.max(1, ((num(r.size) ?? 0) / MAX_BYTES) * 100)).toFixed(1)}%`,
                      }}
                    />
                  </div>
                  <p className="hint">
                    Cloudflare’s Email Service refuses messages over 5 MiB, headers included.
                  </p>
                </div>
              ) : (
                <span className="sk sk-text" />
              )}
            </div>
          </section>
          <LinksPanel links={asLinks(render.data)} contactId={contactId} variant={variant} />
        </div>
      </div>
    </EditorFrame>
  )
}

const DARK_CSS =
  "<style>html{background:#111!important;filter:invert(1) hue-rotate(180deg)}img,picture,video{filter:invert(1) hue-rotate(180deg)}</style>"

function Frame({
  r,
  c,
  to,
  phone,
  dark,
}: {
  r: Render | null
  c: Campaign
  to: string | null
  phone: boolean
  dark: boolean
}) {
  const fields = useQuery(fieldsQuery)
  const [h, setH] = useState(480)
  const html = r?.html ?? ""
  // A real render is a whole HTML document; a stub (fixture data) falls back to the blocks as the editor draws them.
  const real = html.length > 200
  const fromName = c.fromAddress.includes("<")
    ? c.fromAddress.slice(0, c.fromAddress.indexOf("<")).trim()
    : c.fromAddress
  const doc = real
    ? html.replace(/<head[^>]*>/i, (m) => `${m}<base target="_blank">${dark ? DARK_CSS : ""}`)
    : ""
  return (
    <div className={`devframe${phone ? " is-phone" : ""}${dark ? " is-dark" : ""}`}>
      <div className="df-bar">
        <Icon name={phone ? "monitor-phone" : "monitor"} />
        <span>{phone ? "Phone · 375 px" : "Desktop · 600 px"}</span>
        {!phone && to ? (
          <>
            <span className="grow" />
            <span className="mono">To {to}</span>
          </>
        ) : null}
      </div>
      <div className="df-head">
        <span className="df-subj">{r?.subject ?? c.subject}</span>
        <span className="df-pre">
          {fromName}
          {c.preheader || c.bodyBlocks?.preheader ? ` · ${c.preheader ?? c.bodyBlocks?.preheader}` : ""}
        </span>
      </div>
      <div className="df-body" style={real ? { padding: 0 } : undefined}>
        {real ? (
          <iframe
            title={`${phone ? "Phone" : "Desktop"} preview`}
            srcDoc={doc}
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            style={{ width: "100%", height: h, border: 0, display: "block", background: "transparent" }}
            onLoad={(e) => {
              const d = (e.target as HTMLIFrameElement).contentDocument
              if (d) setH(Math.min(4000, Math.max(200, d.documentElement.scrollHeight)))
            }}
          />
        ) : c.bodyBlocks ? (
          <>
            {c.bodyBlocks.blocks.map((b, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a block's place is its identity
              <div key={i} className="eblock" data-block={i} data-path={`bodyBlocks.blocks[${i}]`}>
                <BlockView b={b} fieldKeys={fields.data ? fields.data.map((f) => f.key) : null} />
              </div>
            ))}
            <div className="footer-lock" data-od-id="unsubscribe-footer">
              <span>{c.bodyBlocks.footer.reason}</span>
              <p style={{ margin: 0 }}>
                <span className="cmp-link-like">Manage your topics</span> ·{" "}
                <span className="cmp-link-like">Unsubscribe</span>
              </p>
            </div>
            <div className="em-viewline" data-od-id="view-in-browser-line">
              <span className="cmp-link-like">View this email in your browser</span>
            </div>
          </>
        ) : (
          <p className="hint" style={{ padding: "0 16px" }}>
            Nothing to render yet: add a body in Content.
          </p>
        )}
      </div>
    </div>
  )
}

function TestPanel() {
  const ed = useEditor()
  const qc = useQueryClient()
  const verified = useQuery(verifiedQuery)
  const compliance = useQuery(complianceQuery)
  const write = useCan("campaigns.write", "send tests")
  const now = useNow(30_000)
  const addresses = [
    ...new Set([
      ...(verified.data?.available ? verified.data.addresses.map((a) => a.email) : []),
      ...(compliance.data?.seedAddresses ?? []),
    ]),
  ]
  const [picked, setPicked] = useState<string[] | null>(null)
  const [extra, setExtra] = useState("")
  const chosen = picked ?? addresses
  const to = [...new Set([...chosen, ...extra.split(/[\s,]+/).filter((s) => s.includes("@"))])]
  const [refused, setRefused] = useState<ReturnType<typeof agentRefusal>>(null)
  const test = useMutation({
    mutationFn: async () => {
      if (ed.editable && ed.state !== "saved") {
        const ok = await ed.flush()
        if (!ok) throw new Error("Save the campaign first: it has changes that didn’t save.")
      }
      return unwrap(api.POST("/v1/campaigns/{id}/test", { params: { path: { id: ed.id } }, body: { to } }))
    },
    onSuccess: () => {
      setRefused(null)
      qc.invalidateQueries({ queryKey: ["campaigns", ed.id], exact: true })
    },
    onError: (e) => setRefused(agentRefusal(e)),
  })
  const sentNow = test.data && "sent" in test.data ? test.data.sent : null
  const last = ed.server.lastTest
  const results = sentNow ?? last?.results ?? []
  const lastAt = sentNow ? Date.now() : num(last?.at)
  const failed = results.filter((x) => !["sent", "delivered", "queued"].includes(x.status)).length
  const blocked = refused?.reason === "agent_limit"
  const n = c2(to.length)
  return (
    <section
      className="panel"
      data-endpoint={`POST /v1/campaigns/${ed.id}/test {to} · GET /v1/settings/compliance seedAddresses`}
      data-od-id="panel-test"
      aria-labelledby="h-test"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-test">
          Send a test
        </h2>
      </header>
      <div className="panel-body">
        <div className="stack stack-12" id="test" tabIndex={-1}>
          <fieldset className="stack stack-8" style={{ border: 0, margin: 0, padding: 0 }}>
            <legend className="label" style={{ marginBottom: 6 }}>
              To your verified addresses
            </legend>
            {verified.isPending || compliance.isPending ? <span className="sk sk-text" /> : null}
            {addresses.map((a) => (
              <label key={a} className="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(a)}
                  onChange={(e) =>
                    setPicked(e.target.checked ? [...chosen, a] : chosen.filter((x) => x !== a))
                  }
                />
                <span className="mono" style={{ overflowWrap: "anywhere" }}>
                  {a}
                </span>
              </label>
            ))}
            {verified.data && !verified.data.available ? (
              <p className="hint">{verified.data.reason}</p>
            ) : null}
          </fieldset>
          <div className="field">
            <label className="label" htmlFor="test-extra">
              Other addresses <span className="opt">comma-separated</span>
            </label>
            <input
              className="input mono"
              id="test-extra"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
          <p className="hint">
            Tests to verified addresses are free and don’t count against the daily quota.
            {ed.draft.subjectB !== null ? " Both subjects are sent, marked [A] and [B]." : ""}
          </p>
          {refused ? <AgentRefusalCallout refusal={refused} what="The test wasn’t sent." /> : null}
          {test.isError && !refused ? (
            <ApiErrorCallout error={test.error} what="The test wasn’t sent." />
          ) : null}
          <Gated
            allowed={write.allowed && !blocked && to.length > 0}
            reason={
              !write.allowed
                ? "You can’t send tests"
                : blocked
                  ? "This key can’t send campaign tests"
                  : "Pick an address first"
            }
            who={!write.allowed ? write.who : blocked ? AGENT_WHO : "Tick a verified address, or type one."}
          >
            <button
              className={`btn btn-secondary btn-sm edit-only${test.isPending ? " is-loading" : ""}`}
              type="button"
              data-endpoint={`POST /v1/campaigns/${ed.id}/test`}
              onClick={() => test.mutate()}
            >
              {test.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="send" />}
              {n}
            </button>
          </Gated>
          {results.length ? (
            <div
              className="stack stack-8"
              data-od-id="last-test"
              data-endpoint={`GET /v1/campaigns/${ed.id} · lastTest`}
            >
              <span className="label">Last test · {fmtAgo(lastAt, now)}</span>
              <ul className="list">
                {results.map((x) => (
                  <li key={x.messageId || x.email} className="list-row">
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="row-title mono" style={{ overflowWrap: "anywhere" }}>
                        {x.email}
                      </span>
                      {x.messageId ? (
                        <AppLink
                          className="row-sub link mono"
                          href={`/transactional/messages/${x.messageId}`}
                        >
                          {x.messageId}
                        </AppLink>
                      ) : null}
                    </span>
                    <span
                      className={`pill ${["sent", "delivered"].includes(x.status) ? "pill-pass" : x.status === "queued" ? "pill-info" : "pill-fail"}`}
                    >
                      <span className="dot" />
                      {x.status.replace(/^./, (s) => s.toUpperCase())}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint">
                Status is what each address got when the test went
                {failed
                  ? `; ${failed} ${failed === 1 ? "was" : "were"} refused, so open its message for why`
                  : ""}
                . Delivery and opens show on the message.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}

const c2 = (n: number) => (n === 0 ? "Send a test" : `Send ${fmtInt(n)} test${n === 1 ? "" : "s"}`)

function LinksPanel({
  links,
  contactId,
  variant,
}: {
  links: RenderLink[] | null
  contactId: string | undefined
  variant: "a" | "b"
}) {
  const ed = useEditor()
  const qc = useQueryClient()
  const now = useNow(30_000)
  const [checked, setChecked] = useState<RenderLink[] | null>(null)
  const check = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/campaigns/{id}/render", {
          params: { path: { id: ed.id } },
          body: { variant, checkLinks: true, ...(contactId ? { contactId } : {}) },
        }),
      ),
    onSuccess: (res) => {
      const l = asLinks(res)
      if (l) setChecked(l)
      qc.invalidateQueries({ queryKey: ["campaigns", ed.id, "checks"] })
    },
  })
  const list = checked ?? links
  const broken = (list ?? []).filter((l) => linkPill(l).cls === "pill-fail").length
  return (
    <section
      className="panel"
      data-endpoint={`POST /v1/campaigns/${ed.id}/render → links [{url, status, error, redirectsTo, checkedAt}]`}
      data-od-id="panel-links"
      aria-labelledby="h-links"
    >
      <header className="panel-head">
        <h2 className="panel-title" id="h-links">
          Links
        </h2>
      </header>
      <div className="panel-body">
        {!list ? (
          <span className="sk sk-text" />
        ) : list.length === 0 ? (
          <p className="hint">No clickable links in this email.</p>
        ) : (
          <div className="table-wrap">
            <table className="table dt lk-table" data-od-id="link-statuses">
              <thead>
                <tr>
                  <th>Link</th>
                  <th>Status · checked</th>
                </tr>
              </thead>
              <tbody>
                {list.map((l) => {
                  const p = linkPill(l)
                  return (
                    <tr key={l.url}>
                      <td>
                        <code className="mono lk-url">{l.url}</code>
                        {l.redirectsTo ? (
                          <span className="cell-sub">
                            → <code className="mono">{l.redirectsTo}</code>
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <span className={`pill ${p.cls} lk-pill${p.mono ? " mono" : ""}`}>{p.label}</span>
                        <span className="cell-sub">
                          {num(l.checkedAt) === null
                            ? "never followed"
                            : `checked ${fmtAgo(l.checkedAt, now)}`}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {broken ? (
          <div className="callout callout-error" role="alert" style={{ marginTop: 8 }}>
            <Icon name="x-circle" />
            <span>
              <b>{broken} broken.</b> The links check fails until it’s fixed, and scheduling waits on it.
            </span>
          </div>
        ) : null}
        <div className="cluster" style={{ marginTop: 10 }}>
          <button
            className={`btn btn-secondary btn-sm${check.isPending ? " is-loading" : ""}`}
            type="button"
            data-endpoint={`POST /v1/campaigns/${ed.id}/render {checkLinks: true}`}
            data-od-id="check-links"
            onClick={() => check.mutate()}
            disabled={check.isPending}
          >
            {check.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
            {check.isPending ? "Checking links…" : "Check links now"}
          </button>
        </div>
        {check.isError ? <ApiErrorCallout error={check.error} what="The links weren’t checked." /> : null}
        <p className="hint" style={{ marginTop: 8 }}>
          Statuses are what the links check stored. Check now follows up to 30 links not checked in the last
          hour, then answers; a redirect shows its final address. Only clickable links count: the stylesheet
          that loads fonts isn’t listed.
        </p>
      </div>
    </section>
  )
}
