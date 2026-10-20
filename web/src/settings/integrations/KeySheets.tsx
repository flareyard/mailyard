/**
 * Rotate and revoke an agent's key (design: integrations-agent-rotate, -rotated, -revoke). Rotation copies the
 * old key's name, scopes, purpose and mailbox memberships, shows the new key once with the `claude mcp`
 * lines, and keeps the old one working for the grace period. Revoking is typed-confirmed: the agent's next
 * call gets 401. Both work for any key, so the agent detail uses them too.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { num } from "../../lib/format.ts"
import { CodeTabs, Secret } from "../../ops/Copy.tsx"
import { fmtSeconds, utcShort } from "../../ops/format.ts"
import { TypedConfirm } from "../../ops/kit.tsx"
import { Sheet } from "../../ops/Overlay.tsx"
import { toast } from "../../ops/toast.tsx"
import { Icon } from "../../ui/icons.tsx"
import { PanelError, RequestId } from "../../ui/Panel.tsx"
import { ScopeTags } from "./common.tsx"
import { claudeSwap, mcpUrl } from "./logic.ts"
import { type Body, mcpKeysQuery } from "./queries.ts"

const PRESETS = [0, 3600, 86400, 604800] as const
const MAX_GRACE = 604800

type Rotated = Body<"/v1/api-keys/{id}/rotate", "post">

function useKey(keyId: string) {
  const q = useQuery(mcpKeysQuery)
  return { q, key: q.data?.keys.find((k) => k.id === keyId) }
}

function invalidateKeys(qc: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ["api-keys"] }),
    qc.invalidateQueries({ queryKey: ["agents"] }),
  ])
}

export function RotateKeySheet({
  keyId,
  name,
  onClose,
}: {
  keyId: string
  name?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { q, key } = useKey(keyId)
  const [grace, setGrace] = useState(3600)
  const [done, setDone] = useState<Rotated | null>(null)
  const rotate = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/api-keys/{id}/rotate", {
          params: { path: { id: keyId } },
          body: { graceSeconds: grace },
        }),
      ),
    onSuccess: async (r) => {
      setDone(r)
      await invalidateKeys(qc)
    },
  })
  const label = key?.name ?? name ?? "this key"
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const url = mcpUrl(origin)

  if (done) {
    const until = num(done.previous.revokedAt)
    return (
      <Sheet
        title={`New key for “${done.apiKey.name}”`}
        sub="Copy the key before you close this."
        wide
        onClose={onClose}
        odId="rotate-key-sheet"
        endpoint={`POST /v1/api-keys/${keyId}/rotate`}
        foot={
          <button className="btn btn-primary" type="button" onClick={onClose} data-autofocus="">
            I’ve updated the agent
          </button>
        }
      >
        <Secret
          value={done.key}
          label="The new key"
          note={
            <>
              <b>This is the only time you’ll see it.</b> Swap it into the agent now.
            </>
          }
        />
        <CodeTabs
          label="Reconnect the agent"
          tabs={[
            { id: "rot-claude", label: "Claude Code", code: claudeSwap(url, done.key) },
            {
              id: "rot-any",
              label: "Any MCP client",
              code: `URL     ${url}\nHeader  Authorization: Bearer ${done.key}`,
            },
          ]}
        />
        <dl className="kv">
          <dt>New key</dt>
          <dd>
            <span className="mono">{done.apiKey.prefix}…</span> · purpose {done.apiKey.purpose}
          </dd>
          <dt>Scopes</dt>
          <dd>
            <ScopeTags scopes={done.apiKey.scopes} />
          </dd>
          <dt>Old key</dt>
          <dd>
            {until !== null && until > Date.now() ? (
              <>
                Rotating: works until <b>{utcShort(until)}</b>, then answers <span className="mono">401</span>
                .
              </>
            ) : (
              <>Stopped now.</>
            )}
          </dd>
        </dl>
      </Sheet>
    )
  }

  const stopsAt = Date.now() + grace * 1000
  const graceValid = Number.isInteger(grace) && grace >= 0 && grace <= MAX_GRACE
  return (
    <Sheet
      title={`Rotate “${label}”`}
      sub="Creates a replacement key; the old one stops when the grace period ends."
      wide
      onClose={onClose}
      odId="rotate-key-sheet"
      endpoint={`POST /v1/api-keys/${keyId}/rotate { graceSeconds }`}
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={rotate.isPending || !graceValid || (!key && q.isSuccess)}
            onClick={() => rotate.mutate()}
          >
            <Icon name="refresh" />
            {rotate.isPending ? "Rotating…" : "Rotate key"}
          </button>
        </>
      }
    >
      {q.isSuccess && !key ? (
        <div className="callout callout-warn" role="alert">
          <Icon name="warn" />
          <span>This key isn’t among the agent keys any more. It may have been revoked.</span>
        </div>
      ) : null}
      <p>
        A new key replaces <b>{label}</b>
        {key ? <span className="mono muted"> {key.prefix}…</span> : null}. It copies the old one’s{" "}
        <b>name, scopes, purpose and mailbox memberships (the mail tools keep working for the agent)</b>, and
        is shown once.
      </p>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="label" style={{ marginBottom: 6 }}>
          Keep the old key working for
        </legend>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control inside a fieldset */}
        <div className="seg seg-grace" role="group" aria-label="Grace period">
          {PRESETS.map((p) => (
            <button key={p} type="button" aria-pressed={grace === p} onClick={() => setGrace(p)}>
              {fmtSeconds(p).replace(/^1 day$/, "24 hours")}
            </button>
          ))}
        </div>
        <div className="field-row" style={{ marginTop: 10 }}>
          <div className={`field${graceValid ? "" : " is-invalid"}`}>
            <label className="label" htmlFor="grace-s">
              Or exactly, in seconds
            </label>
            <div className="input-group">
              <input
                className="input num"
                id="grace-s"
                type="number"
                min={0}
                max={MAX_GRACE}
                step={60}
                value={Number.isFinite(grace) ? grace : ""}
                aria-invalid={graceValid ? undefined : true}
                onChange={(e) => setGrace(e.target.value === "" ? 0 : Number(e.target.value))}
              />
              <span className="addon">s · 0 to 604,800</span>
            </div>
          </div>
        </div>
        <span className={graceValid ? "hint" : "field-error"}>
          {graceValid ? (
            grace === 0 ? (
              <>The old key stops the moment the new one is made.</>
            ) : (
              <>
                With {fmtSeconds(grace)}, the old key stops at <b>{utcShort(stopsAt)}</b>, giving you time to
                update the agent.
              </>
            )
          ) : (
            "A whole number of seconds from 0 to 604,800 (7 days)."
          )}
        </span>
      </fieldset>
      <ul className="consequences">
        <li className="ok">
          <Icon name="check-circle" />
          <span>
            Until then both keys work, and the old one shows as <b>Rotating</b> in the list.
          </span>
        </li>
        <li>
          <Icon name="x-circle" />
          <span>
            After that, the agent’s calls with the old key get <span className="mono">401</span>. Choose Now
            to cut it off at once.
          </span>
        </li>
      </ul>
      {rotate.isError ? <MutationError error={rotate.error} what="The key wasn’t rotated" /> : null}
    </Sheet>
  )
}

export function RevokeKeySheet({
  keyId,
  name,
  prefix,
  onClose,
  onDone,
}: {
  keyId: string
  name?: string
  prefix?: string
  onClose: () => void
  onDone?: () => void
}) {
  const qc = useQueryClient()
  const { key } = useKey(keyId)
  const label = key?.name ?? name ?? keyId
  const shown = key?.prefix ?? prefix
  const revoke = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/api-keys/{id}", { params: { path: { id: keyId } } })),
    onSuccess: async () => {
      await invalidateKeys(qc)
      toast({ title: `Revoked “${label}”`, sub: "Its next call gets 401." })
      onDone?.()
      onClose()
    },
  })
  return (
    <Sheet
      title={`Revoke “${label}”?`}
      sub="The agent loses access at once."
      onClose={onClose}
      odId="agent-revoke-sheet"
      endpoint={`DELETE /v1/api-keys/${keyId}`}
    >
      <p>
        <b>{label}</b> {shown ? <span className="mono muted">{shown}…</span> : null} stops working at once.
        The agent’s next call to <span className="mono">/mcp</span> gets <span className="mono">401</span>.
      </p>
      <ul className="consequences">
        <li>
          <Icon name="x-circle" />
          <span>
            Any workflow using this key stops; there’s no grace period. Rotate instead to swap it gently.
          </span>
        </li>
        <li className="ok">
          <Icon name="check-circle" />
          <span>What it drafted or sent stays, and the audit log keeps its entries.</span>
        </li>
      </ul>
      <TypedConfirm match={label}>
        {(ok) => (
          <>
            {revoke.isError ? <MutationError error={revoke.error} what="The key wasn’t revoked" /> : null}
            <div className="cluster" style={{ justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                type="button"
                aria-disabled={!ok || revoke.isPending}
                onClick={() => ok && !revoke.isPending && revoke.mutate()}
              >
                {revoke.isPending ? "Revoking…" : "Revoke key"}
              </button>
            </div>
          </>
        )}
      </TypedConfirm>
    </Sheet>
  )
}

/** A refused or failed call inside a sheet: what failed, the API's message and the request id. */
export function MutationError({ error, what }: { error: unknown; what: string }) {
  const e = error instanceof ApiError ? error : null
  if (!e) return <PanelError error={error} onRetry={() => undefined} what={what} />
  return (
    <div className="callout callout-error" role="alert">
      <Icon name="warn" />
      <span>
        <b>{what}.</b> {e.message}
        {e.requestId ? (
          <>
            {" "}
            <RequestId id={e.requestId} />
          </>
        ) : null}
      </span>
    </div>
  )
}
