/**
 * Connect an agent (design: integrations-connect, -connect-mailboxes, -connect-mailboxes-admin, -connect-key;
 * HAL-3303, HAL-3410): a `purpose: mcp` key for an agent that works in mailboxes you already have.
 *
 *   1. Name and scopes, with the tools each unlocks.
 *   2. Mailboxes: no access, viewer or member. An admin key sees every mailbox, so the step says so.
 *   3. The key once, with the `claude mcp add` line and the URL and header for any client.
 *
 * Memberships are saved with PUT /v1/mailboxes/{id}/members, which replaces the whole list, so each mailbox is
 * read first and the key added to what's there (`mergeMembers`). A membership that fails to save is listed on
 * the last step; the key itself is already made.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { CodeTabs, Secret } from "../../ops/Copy.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelSkeleton } from "../../ui/Panel.tsx"
import { ScopeTags } from "./common.tsx"
import { MutationError } from "./KeySheets.tsx"
import {
  type Access,
  anyClient,
  claudeAdd,
  mcpUrl,
  mergeMembers,
  SCOPE_INFO,
  type Scope,
  TOOLS,
  toolsFor,
} from "./logic.ts"
import { type Body, mailboxesQuery } from "./queries.ts"

type Step = 1 | 2 | 3
type CreatedKey = Body<"/v1/api-keys", "post">
type Saved = { address: string; access: Access; ok: boolean; error?: string }

const STEPS = ["1. Name and scopes", "2. Mailboxes", "3. Key and snippet"]
const SCOPES: Scope[] = ["read", "send", "track", "admin"]
const ACCESS_LABEL: Record<Access, string> = {
  none: "No access",
  viewer: "Viewer · reads only",
  member: "Member · reads, drafts, sends",
}

function Wizard({ step }: { step: Step }) {
  return (
    <ol className="wiz wiz-3" aria-label="Connect an agent, steps">
      {STEPS.map((label, i) => {
        const n = (i + 1) as Step
        return (
          <li
            key={label}
            className={n < step ? "is-done" : n === step ? "is-current" : ""}
            aria-current={n === step ? "step" : undefined}
          >
            <span className="wiz-bar" />
            <span className="wiz-label">{label}</span>
          </li>
        )
      })}
    </ol>
  )
}

export function ConnectSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const mailboxes = useQuery(mailboxesQuery)
  const holding = (mailboxes.data?.mailboxes ?? []).filter((m) => m.holdsMail)
  const [step, setStep] = useState<Step>(1)
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<Scope[]>(["read", "send"])
  const [access, setAccess] = useState<Record<string, Access>>({})
  const [tried, setTried] = useState(false)
  const [created, setCreated] = useState<{ key: CreatedKey; saved: Saved[] } | null>(null)
  const admin = scopes.includes("admin")
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const url = mcpUrl(origin)

  const create = useMutation({
    mutationFn: async () => {
      const key = await unwrap(
        api.POST("/v1/api-keys", { body: { name: name.trim(), kind: "secret", scopes, purpose: "mcp" } }),
      )
      const saved: Saved[] = []
      if (!admin) {
        for (const m of holding) {
          const want = access[m.id] ?? "none"
          if (want === "none") continue
          try {
            const cur = await unwrap(api.GET("/v1/mailboxes/{id}", { params: { path: { id: m.id } } }))
            const members = mergeMembers(cur, key.apiKey.id, want)
            if (members)
              await unwrap(
                api.PUT("/v1/mailboxes/{id}/members", { params: { path: { id: m.id } }, body: { members } }),
              )
            saved.push({ address: m.address, access: want, ok: true })
          } catch (e) {
            saved.push({
              address: m.address,
              access: want,
              ok: false,
              error: e instanceof Error ? e.message : "It didn’t save.",
            })
          }
        }
      }
      return { key, saved }
    },
    onSuccess: async (r) => {
      setCreated(r)
      setStep(3)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["api-keys"] }),
        qc.invalidateQueries({ queryKey: ["mailboxes"] }),
      ])
      toast({ title: `Connected “${r.key.apiKey.name}”`, sub: "Copy its key before you close the sheet." })
    },
  })

  const nameProblem = !name.trim() ? "Name the agent, and whose it is." : null
  const scopeProblem = scopes.length === 0 ? "Pick at least one scope." : null

  const next = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (nameProblem || scopeProblem) return
    setStep(2)
  }

  if (step === 3 && created) {
    const k = created.key
    const failed = created.saved.filter((s) => !s.ok)
    const ok = created.saved.filter((s) => s.ok)
    return (
      <Sheet
        title="Agent connected"
        sub="Copy the key before you close this."
        wide
        onClose={onClose}
        odId="connect-sheet"
        foot={
          <button className="btn btn-primary" type="button" onClick={onClose}>
            I’ve added it
          </button>
        }
      >
        <Wizard step={3} />
        <Secret
          value={k.key}
          label="The agent’s key"
          note={
            <>
              <b>This is the only time you’ll see it.</b> Mailyard keeps a hash, not the key. Paste it into
              the agent now; if it’s lost, revoke it and connect again.
            </>
          }
        />
        <CodeTabs
          label="Add the server to the agent"
          tabs={[
            { id: "mcp-add-claude", label: "Claude Code", code: claudeAdd(url, k.key) },
            { id: "mcp-add-any", label: "Any MCP client", code: anyClient(url, k.key) },
          ]}
        />
        {failed.length ? (
          <div className="callout callout-warn" role="alert">
            <Icon name="warn" />
            <span>
              <b>
                The key works, but {failed.length === 1 ? "one membership" : `${failed.length} memberships`}{" "}
                didn’t save.
              </b>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {failed.map((f) => (
                  <li key={f.address}>
                    <span className="mono">{f.address}</span> ({f.access}): {f.error}
                  </li>
                ))}
              </ul>
              Add it from Settings → Mailboxes, under the mailbox’s members.
            </span>
          </div>
        ) : null}
        <dl className="kv">
          <dt>Name</dt>
          <dd>{k.apiKey.name}</dd>
          <dt>Prefix</dt>
          <dd>
            <span className="mono">{k.apiKey.prefix}…</span>
          </dd>
          <dt>Scopes</dt>
          <dd>
            <ScopeTags scopes={k.apiKey.scopes} /> · {toolsFor(k.apiKey.scopes).length} tools
          </dd>
          <dt>Mailboxes</dt>
          <dd>
            {admin
              ? "Every mailbox, as admin"
              : ok.length
                ? ok.map((s, i) => (
                    <span key={s.address}>
                      {i ? "; " : ""}
                      <span className="mono">{s.address}</span> ({s.access})
                    </span>
                  ))
                : "None: the mail tools see nothing until it’s a member somewhere"}
          </dd>
          <dt>Purpose</dt>
          <dd>
            <span className="tag">mcp</span>{" "}
            <span className="t-small muted">
              A label for finding it later; the scopes and mailboxes above are what limit it.
            </span>
          </dd>
        </dl>
      </Sheet>
    )
  }

  if (step === 2) {
    return (
      <Sheet
        title="Connect an agent"
        sub={`${name.trim()} · scopes ${scopes.join(", ")}`}
        wide
        onClose={onClose}
        odId="connect-sheet"
        endpoint="POST /v1/api-keys { name, kind: secret, scopes, purpose: mcp } · PUT /v1/mailboxes/{id}/members"
        foot={
          <>
            <button className="btn btn-secondary" type="button" onClick={() => setStep(1)}>
              Back
            </button>
            <button
              className="btn btn-primary"
              type="button"
              aria-disabled={create.isPending}
              onClick={() => !create.isPending && create.mutate()}
            >
              {create.isPending ? "Creating…" : "Create the key"}
            </button>
          </>
        }
      >
        <Wizard step={2} />
        <div className="stack stack-12">
          {admin ? (
            <div className="callout callout-info" role="status">
              <Icon name="info" />
              <div>
                <b>An admin key sees every mailbox.</b> Memberships don’t apply to it: the agent can read,
                draft and send as any address in the workspace, including mailboxes added later. To limit it,
                go back and choose read and send instead of admin.
              </div>
            </div>
          ) : null}
          {mailboxes.isPending ? (
            <PanelSkeleton rows={3} />
          ) : mailboxes.isError ? (
            <MutationError error={mailboxes.error} what="Mailboxes didn’t load" />
          ) : holding.length === 0 ? (
            <p className="muted">No mailboxes hold mail yet, so there’s nothing to give it access to.</p>
          ) : (
            <table className="rtable" aria-label="Mailbox access">
              {admin ? null : (
                <thead>
                  <tr>
                    <th>Mailbox</th>
                    <th>Access for this agent</th>
                  </tr>
                </thead>
              )}
              <tbody>
                {holding.map((m) => (
                  <tr key={m.id} className={admin ? "is-muted" : ""}>
                    <td className="is-head">
                      <span className="mono">{m.address}</span>
                      {m.displayName && !admin ? (
                        <span className="cell-sub" style={{ display: "block" }}>
                          {m.displayName}
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Access">
                      {admin ? (
                        "Every tool, as admin"
                      ) : (
                        <select
                          className="select"
                          style={{ height: 44 }}
                          aria-label={`Access to ${m.address}`}
                          value={access[m.id] ?? "none"}
                          onChange={(e) => setAccess((a) => ({ ...a, [m.id]: e.target.value as Access }))}
                        >
                          {(["none", "viewer", "member"] as const).map((v) => (
                            <option key={v} value={v}>
                              {ACCESS_LABEL[v]}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {admin ? null : (
            <>
              <span className="hint">
                The mail tools (list_mailboxes, search_mail, read_thread, draft_reply, send_draft) only see
                mailboxes the key is a member of. A viewer can read but not draft or send there. send_email
                isn’t tied to a mailbox: it sends from a sending domain.
              </span>
              <p className="hint">
                Saved with <span className="mono">PUT /v1/mailboxes/{"{id}"}/members</span> for each mailbox
                you change. That call replaces the whole list, so the app reads the current members first (
                <span className="mono">GET /v1/mailboxes/{"{id}"}</span>) and adds this key, leaving everyone
                else as they were.
              </p>
            </>
          )}
          {create.isError ? <MutationError error={create.error} what="The key wasn’t created" /> : null}
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet
      title="Connect an agent"
      sub="Creates an API key for it. Nothing else to install on Mailyard."
      wide
      onClose={onClose}
      odId="connect-sheet"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" type="submit" form="connect-form">
            Next: mailboxes
          </button>
        </>
      }
    >
      <Wizard step={1} />
      <form className="stack stack-16" id="connect-form" onSubmit={next} noValidate>
        <div className={`field${tried && nameProblem ? " is-invalid" : ""}`}>
          <label className="label" htmlFor="agent-name">
            Name
          </label>
          <input
            className="input"
            id="agent-name"
            value={name}
            maxLength={80}
            data-autofocus=""
            placeholder="Claude Code (Tolu)"
            aria-invalid={tried && nameProblem ? true : undefined}
            aria-describedby="agent-name-hint"
            onChange={(e) => setName(e.target.value)}
          />
          <span className={tried && nameProblem ? "field-error" : "hint"} id="agent-name-hint">
            {tried && nameProblem
              ? nameProblem
              : "Which agent, and whose. It’s how the key appears in lists and the audit log."}
          </span>
        </div>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Scopes, and the tools each unlocks
          </legend>
          <div className="pick-grid">
            {SCOPES.map((s) => {
              const on = scopes.includes(s)
              const tools = s === "admin" ? null : toolsFor([s])
              return (
                <label key={s} className={`pick${on ? " is-on" : ""}`}>
                  <input
                    className="check"
                    type="checkbox"
                    checked={on}
                    style={{ appearance: "auto", width: 16, height: 16 }}
                    onChange={(e) =>
                      setScopes((cur) => (e.target.checked ? [...cur, s] : cur.filter((x) => x !== s)))
                    }
                  />
                  <span className="p-name">
                    {SCOPE_INFO[s].label} <code className="tag">{s}</code>
                  </span>
                  <span className="p-sub">
                    {SCOPE_INFO[s].sub}
                    <span className="scope-tags" style={{ marginTop: 6 }}>
                      {tools ? (
                        tools.map((t) => (
                          <code
                            key={t.name}
                            className={`tag mono${t.effect === "sends" ? " tag-danger" : ""}`}
                          >
                            {t.name}
                          </code>
                        ))
                      ) : (
                        <code className="tag mono">all {TOOLS.length} tools</code>
                      )}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>
          {tried && scopeProblem ? <span className="field-error">{scopeProblem}</span> : null}
          <span className="hint" style={{ marginTop: 6 }}>
            <b>draft_reply</b> only ever writes a draft. <b>send_draft</b> and <b>send_email</b> send mail to
            real people: the agent must pass <span className="mono">confirm: true</span>, and{" "}
            <b>send_draft</b> still waits the undo window.
          </span>
        </fieldset>
        <p className="hint">
          Created as a secret key (<span className="mono">sk_</span>) with{" "}
          <span className="mono">purpose: mcp</span>. Public keys can’t be used for MCP: the server refuses
          them with 403, and creating one with this purpose is refused with 400.
        </p>
      </form>
    </Sheet>
  )
}
