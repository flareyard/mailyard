/**
 * Transactional → API keys (design: transactional/api-keys*.html; HANDOFF-ops §20, §23). The list with the
 * purpose filter, requests in the last 24 hours, rotations in flight and revoked keys; create, rotate, revoke
 * and per-key send limits (HAL-3460) in sheets. Senders read; owners and admins change.
 */
import { useQuery } from "@tanstack/react-query"
import { getRouteApi, Link } from "@tanstack/react-router"
import { fmtInt, toDate } from "../../lib/format.ts"
import { utcDate } from "../../ops/format.ts"
import { BuiltPill, Empty, Time } from "../../ops/kit.tsx"
import { Icon } from "../../ui/icons.tsx"
import { Panel } from "../../ui/Panel.tsx"
import { HeadActions } from "../Layout.tsx"
import { CreateKeySheet, LimitsSheet, RevokeSheet, RotateSheet } from "./KeySheets.tsx"
import {
  type KeyLike,
  keyState,
  keysMeta,
  kindLabel,
  orderScopes,
  purposeCounts,
  replacementOf,
} from "./logic.ts"
import { allKeysQuery, type KeysSearch, keysQuery } from "./queries.ts"
import { AdminOnly, Pill, prefixed, useIsAdmin } from "./ui.tsx"
import "./keys.css"

const route = getRouteApi("/_app/transactional/keys")

export function KeysPage() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const { admin } = useIsAdmin()
  const list = useQuery(keysQuery(search.purpose))
  const all = useQuery(allKeysQuery)
  const counts = purposeCounts(all.data?.keys ?? [])
  const now = Date.now()
  const rotating = (list.data?.keys ?? []).filter((k) => keyState(k, now) === "rotating")

  const open = (patch: Partial<KeysSearch>) =>
    navigate({
      search: (prev) => {
        const { sheet: _s, rotate: _r, revoke: _v, limits: _l, ...rest } = prev
        return { ...rest, ...patch }
      },
    })
  const close = () => open({})
  const byId = (id?: string) => (id ? all.data?.keys.find((k) => k.id === id) : undefined)

  const create = (
    <AdminOnly allowed={admin} reason="Senders can’t create keys" who="Owners and admins manage API keys.">
      <button
        className="btn btn-primary"
        type="button"
        onClick={() => open({ sheet: "create" })}
        data-endpoint="POST /v1/api-keys"
      >
        <Icon name="plus" />
        Create key
      </button>
    </AdminOnly>
  )

  return (
    <>
      <HeadActions>{create}</HeadActions>
      <Panel
        id="keys"
        title="API keys"
        endpoint="GET /v1/api-keys?purpose=&include=usage (built, HAL-3414) · POST /v1/api-keys/{id}/rotate (built, HAL-3414) · POST /v1/api-keys · DELETE /v1/api-keys/{id} · GET/PUT /v1/api-keys/{id}/limits (built, HAL-3460)"
        query={list}
        meta={
          <span className="cluster tb-meta">
            {list.data ? <span>{keysMeta(list.data.keys, now)}</span> : null}
            <BuiltPill issue="HAL-3414" />
            <BuiltPill issue="HAL-3410" />
            <BuiltPill issue="HAL-3460" />
          </span>
        }
        isEmpty={(d) => d.keys.length === 0 && !search.purpose}
        empty={
          <Empty
            icon="key"
            title="No API keys yet"
            action={
              <AdminOnly
                allowed={admin}
                reason="Senders can’t create keys"
                who="Owners and admins manage API keys."
              >
                <button className="btn btn-secondary" type="button" onClick={() => open({ sheet: "create" })}>
                  <Icon name="plus" className="icon-12" />
                  Create a key
                </button>
              </AdminOnly>
            }
          >
            Create a secret key for your server to send mail, or a public key for a browser form to track
            events. Either is shown once.
          </Empty>
        }
      >
        {(d) => (
          <>
            {rotating.map((old) => {
              const fresh = replacementOf(old, d.keys, now)
              return (
                <div key={old.id} className="callout callout-warn" role="status" style={{ marginBottom: 12 }}>
                  <Icon name="refresh" />
                  <span>
                    <b>{old.name} is rotating.</b>{" "}
                    {fresh ? (
                      <>
                        The new key <span className="mono">{prefixed(fresh.prefix)}</span> is in use; the old
                        one
                      </>
                    ) : (
                      "The old key"
                    )}{" "}
                    works until <Time value={old.revokedAt} mode="full" />, then stops. Stop it sooner once
                    every deploy has the new key.
                  </span>
                </div>
              )
            })}
            <div className="keys-toolbar">
              {/* biome-ignore lint/a11y/useSemanticElements: the design's segmented control */}
              <div className="seg seg-links" role="group" aria-label="Purpose">
                {(
                  [
                    [undefined, "All", counts.all],
                    ["api", "api", counts.api],
                    ["mcp", "mcp", counts.mcp],
                  ] as const
                ).map(([p, label, n]) => (
                  <Link
                    key={label}
                    to="/transactional/keys"
                    search={withPurpose(search, p)}
                    role="button"
                    aria-pressed={search.purpose === p}
                    data-endpoint={p ? `GET /v1/api-keys?purpose=${p}` : "GET /v1/api-keys"}
                  >
                    {label} <span className="num">{all.data ? n : "…"}</span>
                  </Link>
                ))}
              </div>
              <p className="purpose-note" data-od-id="purpose-note">
                <Icon name="info" className="icon-12" />
                <span>
                  <b>Purpose is a label.</b> Scopes and mailboxes decide what an agent can do; an{" "}
                  <span className="mono">api</span> key with the right scopes also works over MCP.
                </span>
              </p>
            </div>
            {d.keys.length === 0 ? (
              <p className="muted t-small">
                No <span className="mono">{search.purpose}</span> keys.{" "}
                {search.purpose === "mcp" ? (
                  <>
                    Agents get one from <Link to="/settings/integrations">Connect an agent</Link>.
                  </>
                ) : null}
              </p>
            ) : (
              <div className="table-wrap rtable-wrap">
                <table className="rtable is-wide" data-od-id="key-table">
                  <thead>
                    <tr>
                      <th>Name and prefix</th>
                      <th>Scopes</th>
                      <th>Purpose</th>
                      <th>Created by</th>
                      <th>Last used</th>
                      <th className="r">Requests, 24h</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.keys.map((k) => (
                      <KeyRow
                        key={k.id}
                        k={k}
                        isNew={d.keys.some(
                          (o) =>
                            keyState(o, now) === "rotating" && replacementOf(o, d.keys, now)?.id === k.id,
                        )}
                        admin={admin}
                        open={open}
                        now={now}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Panel>
      <p className="t-small muted keys-foot">
        The deploy-time <span className="mono">ADMIN_KEY</span> isn’t listed: it lives in your Worker’s
        secrets. Rotate it from Flareyard.
      </p>
      {search.sheet === "create" ? <CreateKeySheet onClose={close} /> : null}
      {search.rotate ? <RotateSheet k={byId(search.rotate)} loading={all.isPending} onClose={close} /> : null}
      {search.revoke ? <RevokeSheet k={byId(search.revoke)} loading={all.isPending} onClose={close} /> : null}
      {search.limits ? (
        <LimitsSheet k={byId(search.limits)} id={search.limits} admin={admin} onClose={close} />
      ) : null}
    </>
  )
}

function withPurpose(s: KeysSearch, p: KeysSearch["purpose"]): KeysSearch {
  const { purpose: _p, ...rest } = s
  return p ? { ...rest, purpose: p } : rest
}

function KeyRow({
  k,
  isNew,
  admin,
  open,
  now,
}: {
  k: KeyLike & { createdBy: string | null }
  isNew: boolean
  admin: boolean
  open: (p: Partial<KeysSearch>) => void
  now: number
}) {
  const st = keyState(k, now)
  const created = toDate(k.createdAt ?? null)
  const reason = "Senders can’t rotate or revoke keys"
  return (
    <tr className={st === "revoked" ? "is-muted" : st === "rotating" ? "is-rotating" : ""}>
      <td className="is-head">
        <div className="cell-main">
          <span className="key-name">
            {k.name}
            {isNew ? (
              <span className="tag" style={{ marginLeft: 6 }}>
                new
              </span>
            ) : null}
          </span>
          <span className="cell-sub">
            <span className="mono">{prefixed(k.prefix)}</span> · {kindLabel(k.kind)}
          </span>
          {st === "rotating" ? (
            <span className="cell-sub rot-note" style={{ display: "block" }}>
              Rotating: the old key works until <Time value={k.revokedAt} mode="full" />
            </span>
          ) : null}
        </div>
      </td>
      <td data-label="Scopes">
        <span className="scope-tags">
          {orderScopes(k.scopes).map((s) => (
            <span key={s} className={`tag${s === "admin" ? " is-strong" : ""}`}>
              {s}
            </span>
          ))}
        </span>
      </td>
      <td data-label="Purpose">
        {k.purpose === "mcp" ? (
          <Link
            className="tag"
            to="/settings/integrations"
            title="Created by Connect an agent: Settings → Integrations"
          >
            mcp
          </Link>
        ) : (
          <span className="tag">api</span>
        )}
      </td>
      <td data-label="Created by">
        {k.createdBy ?? <span className="muted">Admin key</span>}
        {created ? (
          <span className="cell-sub" style={{ display: "block" }}>
            {utcDate(created.getTime())}
          </span>
        ) : null}
      </td>
      <td data-label="Last used">
        {k.lastUsedAt ? <Time value={k.lastUsedAt} /> : <span className="muted">Never</span>}
      </td>
      <td className="r" data-label="Requests, 24h">
        {k.requests24h === undefined ? <span className="muted">—</span> : fmtInt(k.requests24h)}
      </td>
      <td className="actions">
        {st === "revoked" ? (
          <span className="cell-sub">
            Revoked <Time value={k.revokedAt} mode="full" />. Rotate is off: a revoked key can’t be rotated.
          </span>
        ) : st === "rotating" ? (
          <AdminOnly allowed={admin} reason={reason} who="Owners and admins manage API keys." side="right">
            <button
              className="btn btn-danger-ghost btn-sm"
              type="button"
              onClick={() => open({ revoke: k.id })}
              data-endpoint={`DELETE /v1/api-keys/${k.id}`}
            >
              Stop the old key now
            </button>
          </AdminOnly>
        ) : (
          <>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => open({ limits: k.id })}
              data-endpoint={`GET /v1/api-keys/${k.id}/limits`}
              aria-label={`Send limits for ${k.name}`}
            >
              <Icon name="gauge" className="icon-12" />
              Limits
            </button>
            <AdminOnly allowed={admin} reason={reason} who="Owners and admins manage API keys." side="right">
              <button
                className="btn btn-ghost btn-sm"
                type="button"
                onClick={() => open({ rotate: k.id })}
                data-endpoint={`POST /v1/api-keys/${k.id}/rotate { graceSeconds }`}
                aria-label={`Rotate ${k.name}`}
              >
                <Icon name="refresh" className="icon-12" />
                Rotate
              </button>
            </AdminOnly>
            <AdminOnly allowed={admin} reason={reason} who="Owners and admins manage API keys." side="right">
              <button
                className="btn btn-danger-ghost btn-sm"
                type="button"
                onClick={() => open({ revoke: k.id })}
                data-endpoint={`DELETE /v1/api-keys/${k.id}`}
                aria-label={`Revoke ${k.name}`}
              >
                Revoke
              </button>
            </AdminOnly>
          </>
        )}
      </td>
      <td className="is-aside">
        {st === "active" ? (
          <Pill tone="pill-pass">Active</Pill>
        ) : st === "rotating" ? (
          <Pill tone="pill-warn">Rotating</Pill>
        ) : (
          <Pill tone="pill-neutral">Revoked</Pill>
        )}
      </td>
    </tr>
  )
}
