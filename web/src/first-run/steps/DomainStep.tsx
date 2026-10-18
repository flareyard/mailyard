/**
 * Step 1, add a domain (design: first-run/domain-{empty,connected,progress,pass,fail}.html, GAPS 4.1).
 * With a zone token, `GET /v1/domains/candidates` lists the account's zones; without one (production today)
 * the domain is typed and checked in public DNS. The domain is created with receiving and sending off, so
 * nothing about its mail changes until step 2.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { Icon } from "../../ui/icons.tsx"
import { nameserversOnCloudflare, normalizeDomain } from "../logic.ts"
import { type Candidates, candidatesQuery, type Domain, domainQuery } from "../queries.ts"
import { nextAfter, SETUP_WHO, useMark, useSetup } from "../setup.tsx"
import {
  ApiErrorCallout,
  ConfirmButton,
  CopyButton,
  clock,
  FieldError,
  Kv,
  KvTable,
  StepPanel,
  TlItem,
  useEvery,
  ZoneTokenHint,
} from "../ui.tsx"

const ENDPOINT = "GET /v1/domains/candidates · POST /v1/domains · GET /v1/domains/{id} (built, HAL-3365)"
const LEDE =
  "Add the domain your mail will live on. Mailyard checks it in public DNS, and with a zone token it can list your Cloudflare zones and fix records for you."

/** Domain import is a Flareyard platform flow (HAL-3124); there's no route for it in this API yet. */
function ImportButton({ name }: { name?: string }) {
  return (
    <Gated
      allowed={false}
      reason="Importing a domain isn’t live yet"
      who="It’s a Flareyard platform flow (HAL-3124): it copies the DNS into Cloudflare and moves the nameservers. Until then, add the zone in Cloudflare first."
    >
      <button className="btn btn-secondary" type="button">
        <Icon name="inbound" />
        {name ? `Import ${name}` : "Import a domain from elsewhere"}
      </button>
    </Gated>
  )
}

export function DomainStep() {
  const s = useSetup()
  const candidates = useQuery(candidatesQuery)
  const connected = candidates.data?.connected === true
  const d = s.domain
  const status = s.steps[0]?.status

  return (
    <StepPanel id="domain" n={1} title="Add a domain" lede={LEDE} endpoint={ENDPOINT}>
      {!d ? (
        <AddDomain candidates={candidates.data} />
      ) : status === "running" ? (
        <WaitingForNameservers domain={s.detail} name={d.name} id={d.id} />
      ) : (
        <>
          <DomainAdded domain={s.detail} name={d.name} candidates={candidates.data} />
          {!connected && candidates.isSuccess ? <ZoneTokenHint /> : null}
          <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => s.goTo(nextAfter(s.steps, "domain"))}
            >
              <Icon name="arrow-right" />
              Next: turn on mail
            </button>
          </div>
        </>
      )}
    </StepPanel>
  )
}

function AddDomain({ candidates }: { candidates: Candidates | undefined }) {
  const s = useSetup()
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const zones = candidates?.connected ? candidates.candidates : []
  const firstFree = zones.find((z) => !z.inWorkspace)
  const [picked, setPicked] = useState<string | null>(null)
  const chosenZone = picked ?? firstFree?.name ?? null
  const [typed, setTyped] = useState("")
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [notAZone, setNotAZone] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: async (body: { name: string; zoneId?: string }) => {
      const res = await unwrap(
        api.POST("/v1/domains", { body: { ...body, receiving: false, sending: false } }),
      )
      if (!res || typeof res !== "object" || !("id" in res))
        throw new ApiError(502, { message: "Mailyard answered without a domain." })
      return res as Domain
    },
    onSuccess: (domain) => {
      qc.setQueryData(domainQuery(domain.id).queryKey, domain)
      qc.invalidateQueries({ queryKey: ["domains"] })
      s.remember((m) => ({ ...m, started: true }))
    },
    onError: (e, body) => {
      if (e instanceof ApiError && e.status === 404) {
        setNotAZone(body.name)
        setFieldError(
          `${body.name} isn’t a zone on this Cloudflare account. Check the spelling, or bring the domain over with the import flow.`,
        )
      } else if (e instanceof ApiError && (e.status === 400 || e.status === 409)) setFieldError(e.message)
    },
  })

  useMark("domain", "running", create.isPending)
  useMark("domain", "fail", Boolean(notAZone) || (create.isError && !create.isPending))
  const typedName = typed.trim() ? normalizeDomain(typed) : null
  const target = typedName ? ("name" in typedName ? typedName.name : typed.trim()) : chosenZone

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setNotAZone(null)
    if (typed.trim() || !zones.length) {
      const n = normalizeDomain(typed)
      if ("error" in n) {
        setFieldError(n.error)
        input.current?.focus()
        return
      }
      setFieldError(null)
      const zone = zones.find((z) => z.name === n.name)
      create.mutate(zone ? { name: n.name, zoneId: zone.zoneId } : { name: n.name })
      return
    }
    const zone = zones.find((z) => z.name === chosenZone)
    if (!zone) return setFieldError("Pick a zone, or type a domain.")
    setFieldError(null)
    create.mutate({ name: zone.name, zoneId: zone.zoneId })
  }

  const label = zones.length ? "Or type a domain" : "Your domain"
  const verb = zones.length && !typed.trim() ? "Use" : "Add"
  const busy = create.isPending
  const otherError = create.isError && !fieldError ? create.error : null

  return (
    <form className="step-form" onSubmit={submit} noValidate>
      {zones.length ? (
        <fieldset className="stack stack-8" style={{ border: 0, padding: 0, margin: 0 }} disabled={busy}>
          <legend className="label" style={{ marginBottom: 8 }}>
            Zones on this Cloudflare account
          </legend>
          {zones.map((z) => {
            const selected = !typed.trim() && chosenZone === z.name && !z.inWorkspace
            return (
              <label
                key={z.zoneId}
                className={`choice check${selected ? " is-selected" : ""}${z.inWorkspace ? " is-disabled" : ""}`}
                style={{ display: "grid" }}
              >
                <input
                  type="radio"
                  name="domain"
                  checked={selected}
                  disabled={z.inWorkspace}
                  onChange={() => {
                    setPicked(z.name)
                    setTyped("")
                    setFieldError(null)
                  }}
                  aria-label={z.name}
                />
                <span className="c-name">{z.name}</span>
                {z.zoneStatus === "active" ? (
                  <span className="pill pill-pass">
                    <span className="dot" />
                    Active on Cloudflare
                  </span>
                ) : z.zoneStatus === "pending" ? (
                  <span className="pill pill-warn">
                    <span className="dot" />
                    Pending nameservers
                  </span>
                ) : (
                  <span className="pill pill-neutral">
                    <span className="dot" />
                    {z.zoneStatus}
                  </span>
                )}
                <span className="c-sub">
                  {z.registrar ? `Registrar ${z.registrar} · ` : ""}
                  {z.zoneStatus === "pending"
                    ? `waiting for its nameservers to move to ${z.nameservers.join(", ")}`
                    : `nameservers ${z.nameservers.join(", ")}`}
                </span>
                {z.inWorkspace ? (
                  <span className="c-sub">
                    Already in this workspace
                    {z.workspaceDomains.length ? `: ${z.workspaceDomains.join(", ")}` : ""}.
                  </span>
                ) : null}
                {z.existingMx.length ? (
                  <span className="c-sub" style={{ color: "var(--amber-900)" }}>
                    <Icon name="warn" /> This domain already receives mail elsewhere (
                    {z.existingMx.join(", ")}). Turning on mail here moves it to Mailyard.
                  </span>
                ) : null}
              </label>
            )
          })}
        </fieldset>
      ) : null}

      <div className="field">
        <label className="label" htmlFor="dom-typed">
          {label} {zones.length ? <span className="opt">· optional</span> : null}
        </label>
        <input
          ref={input}
          className="input mono"
          id="dom-typed"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value)
            setFieldError(null)
            setNotAZone(null)
          }}
          placeholder={zones.length ? "example.com" : "coursified.app"}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          disabled={busy}
          {...(fieldError
            ? { "aria-invalid": true, "aria-describedby": "dom-err" }
            : zones.length
              ? {}
              : { "aria-describedby": "dom-hint" })}
        />
        {fieldError ? <FieldError id="dom-err">{fieldError}</FieldError> : null}
        {!zones.length && !fieldError ? (
          <p className="hint" id="dom-hint">
            The domain itself, like <code className="mono">coursified.app</code>, not an address. It needs to
            be a zone on this Cloudflare account.
          </p>
        ) : null}
      </div>

      {notAZone ? (
        <div className="callout callout-info">
          <Icon name="info" />
          <span>
            The import flow copies its DNS records into Cloudflare, switches the nameservers, and keeps its
            current mail resolving the same until you turn Mailyard on.
          </span>
        </div>
      ) : !zones.length && candidates && !candidates.connected ? (
        <ZoneTokenHint />
      ) : null}

      {otherError ? <ApiErrorCallout error={otherError} what="The domain wasn’t added." /> : null}

      <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
        {notAZone ? (
          <>
            <ImportButton name={notAZone} />
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => {
                setTyped("")
                setFieldError(null)
                setNotAZone(null)
                input.current?.focus()
              }}
            >
              Type another domain
            </button>
          </>
        ) : (
          <>
            <Gated allowed={s.canSetUp} reason="You can’t add domains" who={SETUP_WHO}>
              <button className={`btn btn-primary${busy ? " is-loading" : ""}`} type="submit" disabled={busy}>
                {busy ? <span className="spinner" aria-hidden="true" /> : null}
                {busy ? `Adding ${target ?? "the domain"}…` : target ? `${verb} ${target}` : "Add the domain"}
              </button>
            </Gated>
            <ImportButton />
          </>
        )}
      </div>
    </form>
  )
}

function DomainAdded({
  domain,
  name,
  candidates,
}: {
  domain: Domain | undefined
  name: string
  candidates: Candidates | undefined
}) {
  const zone = candidates?.candidates.find((c) => c.name === name)
  const off = domain ? !domain.receiving && !domain.sending : true
  const mx = zone?.existingMx ?? []
  return (
    <>
      <div className="callout callout-ok">
        <Icon name="check-circle" />
        <span>
          <b>{name} is in this workspace.</b>{" "}
          {mx.length
            ? `Its nameservers are on Cloudflare. It receives mail at ${mx.join(", ")} today; that keeps working until you turn on mail in the next step.`
            : zone
              ? "Its nameservers are on Cloudflare and it has no MX records yet, so nothing that receives mail today will change."
              : "Its nameservers are on Cloudflare. Mail stays off until the next step, so nothing that receives mail today changes."}
        </span>
      </div>
      <KvTable>
        <Kv label="Zone">
          <span className="mono">{domain?.zoneName ?? name}</span>
        </Kv>
        <Kv label="Nameservers">
          {domain?.currentNameservers?.length ? (
            <span className="mono">
              {domain.currentNameservers.map((n) => (
                <span key={n} style={{ display: "block" }}>
                  {n}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">Not read yet</span>
          )}
        </Kv>
        <Kv label="Return path">
          {domain?.returnPath ? (
            <span className="mono">{domain.returnPath}</span>
          ) : (
            <span className="muted">Set when sending is on</span>
          )}
        </Kv>
        <Kv label="Registrar · DNSSEC">
          {domain?.registrar || domain?.dnssec ? (
            `${domain.registrar ?? "—"} · ${domain.dnssec ?? "—"}`
          ) : (
            <span className="muted">{candidates?.connected ? "Not reported" : "Needs a zone token"}</span>
          )}
        </Kv>
        <Kv label="Routing · Sending">
          {off
            ? "Off until the next step"
            : `Receiving ${domain?.receiving ? "on" : "off"} · Sending ${domain?.sending ? "on" : "off"}`}
        </Kv>
      </KvTable>
    </>
  )
}

type NsCheck = { at: number; ns: string[]; onCloudflare: boolean | null }

/** Nameservers still point elsewhere: rechecks every 3 minutes while the step is open, and on demand. */
function WaitingForNameservers({
  domain,
  name,
  id,
}: {
  domain: Domain | undefined
  name: string
  id: string
}) {
  const s = useSetup()
  const qc = useQueryClient()
  const [history, setHistory] = useState<NsCheck[]>(() =>
    domain?.lastCheckedAt
      ? [
          {
            at: Number(domain.lastCheckedAt),
            ns: domain.currentNameservers ?? [],
            onCloudflare: nameserversOnCloudflare(domain.currentNameservers),
          },
        ]
      : [],
  )
  const recheck = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/domains/{id}/recheck", { params: { path: { id } } })),
    onSuccess: (fresh) => {
      if (!fresh || !("checks" in fresh)) return
      qc.setQueryData(domainQuery(id).queryKey, fresh)
      qc.invalidateQueries({ queryKey: ["domains"], exact: true })
      setHistory((h) => [
        ...h.slice(-4),
        {
          at: Date.now(),
          ns: fresh.currentNameservers ?? [],
          onCloudflare: nameserversOnCloudflare(fresh.currentNameservers),
        },
      ])
    },
  })
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/domains/{id}", { params: { path: { id } } })),
    onSuccess: () => {
      qc.removeQueries({ queryKey: domainQuery(id).queryKey })
      qc.invalidateQueries({ queryKey: ["domains"] })
    },
  })
  const left = useEvery(() => recheck.mutateAsync().catch(() => {}), 3 * 60_000, !recheck.isPending)
  const now = domain?.currentNameservers ?? []
  const assigned = domain?.nameservers ?? null

  return (
    <>
      <div className="callout callout-warn">
        <Icon name="clock" />
        <span>
          <b>{name} is waiting for its nameservers.</b>{" "}
          {now.length ? (
            <>
              Public DNS still shows <span className="mono">{now.join(", ")}</span>, so the domain hasn’t
              moved to Cloudflare yet.{" "}
            </>
          ) : (
            "Cloudflare hasn’t activated the zone yet. "
          )}
          Set the two nameservers Cloudflare gave you for this zone at your registrar.
        </span>
      </div>
      <KvTable>
        <Kv label="Zone">
          <span className="mono">{domain?.zoneName ?? name}</span>
        </Kv>
        <Kv label="Nameservers now">
          {now.length ? (
            <span className="mono">
              {now.map((n) => (
                <span key={n} style={{ display: "block" }}>
                  {n}
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">Not read yet</span>
          )}
        </Kv>
        <Kv label="Assigned nameservers">
          {assigned?.length ? (
            <span className="stack stack-4">
              {assigned.map((n) => (
                <span key={n} className="cluster cluster-4">
                  <span className="mono">{n}</span>
                  <CopyButton value={n} label={`Copy ${n}`} />
                </span>
              ))}
            </span>
          ) : (
            <span className="muted">
              In your Cloudflare dashboard. With a zone token they show here, with a copy button.
            </span>
          )}
        </Kv>
      </KvTable>
      <ul className="timeline" aria-label="Nameserver checks" aria-live="polite">
        {history.map((h) => (
          <TlItem key={h.at} icon={h.onCloudflare ? "check-circle" : "x-circle"} time={clock(h.at, false)}>
            {h.onCloudflare ? (
              "Checked: on Cloudflare"
            ) : (
              <>
                Checked: still <span className="mono">{h.ns[0] ?? "not on Cloudflare"}</span>
              </>
            )}
          </TlItem>
        ))}
        <TlItem
          icon={recheck.isPending ? "circle-dash" : "clock"}
          time={
            recheck.isPending ? "now" : left !== null ? clock(Date.now() + left * 1000, false) : undefined
          }
        >
          {recheck.isPending ? (
            <b>Checking now…</b>
          ) : (
            <>
              <b>
                Next check in{" "}
                {left === null ? "a moment" : left >= 60 ? `${Math.ceil(left / 60)} min` : `${left} s`}.
              </b>{" "}
              Most registrars take under an hour; some take a day. You’ll get an alert when it’s ready, so you
              can leave this page.
            </>
          )}
        </TlItem>
      </ul>
      {recheck.isError ? <ApiErrorCallout error={recheck.error} what="The check didn’t run." /> : null}
      {remove.isError ? <ApiErrorCallout error={remove.error} what="The domain wasn’t removed." /> : null}
      <div className="cluster cluster-12" style={{ paddingTop: 4 }}>
        <button
          className={`btn btn-secondary${recheck.isPending ? " is-loading" : ""}`}
          type="button"
          data-endpoint={`POST /v1/domains/${id}/recheck`}
          onClick={() => recheck.mutate()}
          disabled={recheck.isPending}
        >
          {recheck.isPending ? <span className="spinner" aria-hidden="true" /> : <Icon name="refresh" />}
          Check now
        </button>
        {s.canSetUp ? (
          <ConfirmButton
            label="Use another domain"
            confirm={`Remove ${name}`}
            hint="It has no mailboxes yet, so nothing is lost."
            busy={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        ) : null}
      </div>
    </>
  )
}
