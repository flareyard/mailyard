/**
 * Settings → Your sessions (design: sessions, -sign-out-everywhere, -signed-out, -error; HAL-3358, live).
 * Each browser session: device, the key or person behind it, last seen, signed in, and when it ends (14 days
 * after last use, 30-day cap). Sign out one with DELETE /v1/sessions/{id}; "Sign out everywhere else" is one
 * DELETE /v1/sessions → { ended }, keeping this one.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { useMe } from "../auth/session.ts"
import { utcShort } from "../ops/format.ts"
import { BuiltPill, Time } from "../ops/kit.tsx"
import { Sheet } from "../ops/Overlay.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import { sessionEnds, sessionEndsWhy } from "./logic.ts"
import { ApiRefusal } from "./mailboxes/CreateMailbox.tsx"
import { type Session, sessionsQuery } from "./queries.ts"
import { SectionHead } from "./ui.tsx"

export function SessionsPage() {
  const qc = useQueryClient()
  const q = useQuery(sessionsQuery)
  const me = useMe()
  const [ended, setEnded] = useState<Set<string>>(new Set())
  const [confirmAll, setConfirmAll] = useState(false)
  const list = q.data?.sessions ?? []
  const others = list.filter((s) => !s.current && !ended.has(s.id))

  const one = useMutation({
    mutationFn: (s: Session) => unwrap(api.DELETE("/v1/sessions/{id}", { params: { path: { id: s.id } } })),
    onSuccess: (_, s) => {
      setEnded((p) => new Set(p).add(s.id))
      toast({
        title: `Signed out ${s.userAgent ?? "that session"}`,
        sub: "That device goes back to sign-in on its next request",
      })
      qc.invalidateQueries({ queryKey: sessionsQuery.queryKey })
    },
    onError: (e) =>
      toast({ title: "Not signed out", sub: e instanceof Error ? e.message : undefined, tone: "bad" }),
  })
  const all = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/sessions")),
    onSuccess: (r) => {
      setEnded((p) => new Set([...p, ...others.map((s) => s.id)]))
      setConfirmAll(false)
      const n = Number(r?.ended ?? 0)
      toast({
        title: n ? `Signed out ${n} other session${n === 1 ? "" : "s"}` : "No other sessions were signed in",
        sub: "This one stays signed in",
      })
      qc.invalidateQueries({ queryKey: sessionsQuery.queryKey })
    },
  })
  const active = list.filter((s) => !ended.has(s.id)).length

  return (
    <>
      <SectionHead
        title="Your sessions"
        sub={
          me.data?.user
            ? "Where you’re signed in to this workspace."
            : "Where this workspace is signed in, and with which key."
        }
        actions={
          q.isSuccess ? (
            <button
              className="btn btn-danger-ghost"
              type="button"
              onClick={() => setConfirmAll(true)}
              disabled={!others.length}
              data-endpoint="DELETE /v1/sessions → { ended }"
            >
              <Icon name="logout" />
              Sign out everywhere
            </button>
          ) : null
        }
      />
      {q.isError ? null : (
        <div className="callout callout-info" style={{ marginBottom: 12 }}>
          <Icon name="info" />
          <span>
            You sign in with an email link or an API key, and Mailyard keeps you signed in with a secure
            cookie (<span className="mono">__Host-mailyard_session</span>, HttpOnly). A session lasts{" "}
            <b>14 days from when it was last used</b>, and never more than <b>30 days</b> in all. Revoking or
            narrowing a key ends or narrows its sessions too.
          </span>
        </div>
      )}
      <Panel
        id="sessions"
        title="Sessions"
        endpoint="GET /v1/sessions · DELETE /v1/sessions/{id} · DELETE /v1/sessions (built, HAL-3358)"
        query={q}
        meta={
          <>
            {q.isSuccess ? `${active} active` : null} <BuiltPill issue="HAL-3358" />
          </>
        }
        isEmpty={(d) => d.sessions.length === 0}
      >
        {() => (
          <>
            <div className="table-wrap rtable-wrap">
              <table className="rtable" data-od-id="session-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Signed in as</th>
                    <th>Last seen</th>
                    <th>Signed in</th>
                    <th>Ends</th>
                    <th>
                      <span className="sr-only">State</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => {
                    const gone = ended.has(s.id)
                    return (
                      <tr key={s.id} className={gone ? "is-muted" : ""}>
                        <td className="is-head">
                          <div className="cell-main">
                            <span style={{ fontWeight: 600, color: "var(--my-fg)" }}>
                              {s.userAgent ?? "Unknown device"}
                            </span>
                            <span className="cell-sub">
                              {s.location}
                              {s.location && s.ip ? " · " : ""}
                              {s.ip ? <span className="mono">{s.ip}</span> : null}
                              {!s.location && !s.ip ? "Location not recorded" : null}
                            </span>
                          </div>
                        </td>
                        <td data-label="Signed in as">
                          {s.key ? (
                            <>
                              <span style={{ color: "var(--my-fg)" }}>{s.key.name}</span>{" "}
                              <span className="mono muted">{s.key.prefix}…</span>
                              <span className="cell-sub" style={{ display: "block" }}>
                                <span className="scope-tags">
                                  {s.key.scopes.map((sc) => (
                                    <span key={sc} className="tag">
                                      {sc}
                                    </span>
                                  ))}
                                </span>
                              </span>
                            </>
                          ) : s.via === "admin-key" ? (
                            <span style={{ color: "var(--my-fg)" }}>The admin key</span>
                          ) : (
                            <span style={{ color: "var(--my-fg)" }}>
                              {s.current && me.data?.user ? me.data.user.name : "You"}, with an email link
                            </span>
                          )}
                        </td>
                        <td data-label="Last seen">
                          {s.current ? "now" : <Time value={s.lastSeenAt as number} />}
                        </td>
                        <td data-label="Signed in">
                          <Time value={s.createdAt as number} mode="full" />
                        </td>
                        <td data-label="Ends">
                          {gone ? (
                            "—"
                          ) : (
                            <>
                              {utcShort(sessionEnds(s))}
                              <span className="cell-sub" style={{ display: "block" }}>
                                {sessionEndsWhy(s)}
                              </span>
                            </>
                          )}
                        </td>
                        <td className="is-aside">
                          {s.current ? (
                            <span className="pill pill-info">
                              <span className="dot" />
                              This session
                            </span>
                          ) : gone ? (
                            <span className="pill pill-neutral">
                              <span className="dot" />
                              Signed out
                            </span>
                          ) : (
                            <button
                              className="btn btn-secondary btn-sm"
                              type="button"
                              disabled={one.isPending && one.variables?.id === s.id}
                              onClick={() => one.mutate(s)}
                              aria-label={`Sign out ${s.userAgent ?? "this session"}`}
                              data-endpoint={`DELETE /v1/sessions/${s.id}`}
                            >
                              <Icon name="logout" />
                              Sign out
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <footer className="panel-foot">
              <span>
                A cross-site request without a matching Origin is refused with{" "}
                <span className="mono">403 reason: "csrf"</span>.
              </span>
            </footer>
          </>
        )}
      </Panel>
      {confirmAll ? (
        <Sheet
          title="Sign out everywhere else?"
          sub="Every other session ends. This one stays signed in."
          onClose={() => setConfirmAll(false)}
          odId="signout-all"
          foot={
            <>
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setConfirmAll(false)}
                data-autofocus=""
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => all.mutate()}
                disabled={all.isPending}
                data-endpoint="DELETE /v1/sessions → { ended }"
              >
                <Icon name="logout" />
                {all.isPending ? "Signing out…" : "Sign out everywhere else"}
              </button>
            </>
          }
        >
          <ul className="consequences">
            <li>
              <Icon name="x-circle" />
              <span>
                {others.length} session{others.length === 1 ? "" : "s"} end now:{" "}
                {others.map((s) => s.userAgent ?? "an unknown device").join(", ")}.
              </span>
            </li>
            <li className="ok">
              <Icon name="check-circle" />
              <span>
                This session stays signed in. One call, <span className="mono">DELETE /v1/sessions</span>,
                ends the others and answers <span className="mono">{`{ ended: ${others.length} }`}</span>.
              </span>
            </li>
            <li className="ok">
              <Icon name="check-circle" />
              <span>
                API keys keep working. To lock a key out entirely, revoke it in Transactional → API keys.
              </span>
            </li>
          </ul>
          {all.isError ? <ApiRefusal error={all.error} /> : null}
        </Sheet>
      ) : null}
    </>
  )
}
