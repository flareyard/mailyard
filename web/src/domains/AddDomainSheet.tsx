/**
 * Add a domain (design: domain-add, domain-add-zone-token). `GET /v1/domains/candidates` says whether a zone
 * token is connected: without one you type the domain; with one you pick a zone from the account, zones already
 * in the workspace are shown as added, and a zone whose mail goes elsewhere (`existingMx`) defaults to sending
 * only, so adding it never takes that mail. Then `POST /v1/domains`, and on to the new domain's records.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { type FormEvent, useId, useState } from "react"
import { ApiError, api, unwrap } from "../api/client.ts"
import { Sheet } from "../ops/Overlay.tsx"
import { toast } from "../ops/toast.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelSkeleton, RequestId } from "../ui/Panel.tsx"
import { type Candidate, cleanDomain, defaultReceiving } from "./logic.ts"
import { candidatesQuery, domainQuery, domainsQuery } from "./queries.ts"
import { StatePill, TokenNote } from "./ui.tsx"

export function AddDomainSheet({ onClose }: { onClose: () => void }) {
  const id = useId()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const candidates = useQuery(candidatesQuery)
  const connected = candidates.data?.connected === true
  const zones = candidates.data?.candidates ?? []
  const [picked, setPicked] = useState<Candidate | null>(null)
  const [typed, setTyped] = useState("")
  const [receiving, setReceiving] = useState(true)
  const [sending, setSending] = useState(true)
  const [touchedReceiving, setTouchedReceiving] = useState(false)
  const [invalid, setInvalid] = useState(false)

  const pick = (c: Candidate) => {
    setPicked(c)
    setTyped("")
    setInvalid(false)
    if (!touchedReceiving) setReceiving(defaultReceiving(c))
  }

  const create = useMutation({
    mutationFn: (body: { name: string; receiving: boolean; sending: boolean; zoneId?: string }) =>
      unwrap(api.POST("/v1/domains", { body })),
    onSuccess: (d) => {
      qc.setQueryData(domainQuery(d.id).queryKey, d)
      void qc.invalidateQueries({ queryKey: domainsQuery.queryKey })
      toast({
        title: `${d.name} added`,
        sub: "Add the records shown; Mailyard checks them against public DNS.",
      })
      onClose()
      navigate({ to: "/domains/$id", params: { id: d.id } })
    },
  })

  const name = typed ? cleanDomain(typed) : (picked?.name ?? null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name) {
      setInvalid(true)
      return
    }
    create.mutate({
      name,
      receiving,
      sending,
      ...(picked && !typed ? { zoneId: picked.zoneId } : {}),
    })
  }

  const err = create.error instanceof ApiError ? create.error : null
  const hint = picked && !typed && picked.existingMx.length > 0 && !receiving

  return (
    <Sheet
      title="Add a domain"
      sub="GET /v1/domains/candidates · POST /v1/domains"
      wide
      onClose={onClose}
      odId="add-domain-sheet"
      endpoint="GET /v1/domains/candidates · POST /v1/domains"
      foot={
        <>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn btn-primary${create.isPending ? " is-loading" : ""}`}
            type="submit"
            form={`${id}-form`}
            disabled={create.isPending}
          >
            {create.isPending ? <span className="spinner" /> : <Icon name="plus" />}
            {create.isPending ? "Adding…" : "Add domain"}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} className="stack stack-16" onSubmit={submit} noValidate>
        {candidates.isPending ? (
          <PanelSkeleton rows={3} />
        ) : connected && zones.length ? (
          <fieldset className="stack stack-8" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 8 }}>
              Zones on your Cloudflare account
            </legend>
            {zones.map((c) => (
              <ZoneChoice
                key={c.zoneId}
                c={c}
                group={`${id}-cand`}
                selected={!typed && picked?.zoneId === c.zoneId}
                onPick={() => pick(c)}
              />
            ))}
          </fieldset>
        ) : null}
        <div className="field">
          <label className="label" htmlFor={`${id}-typed`}>
            {connected && zones.length ? (
              <>
                Or type one <span className="opt">· optional</span>
              </>
            ) : (
              "Type your domain"
            )}
          </label>
          <input
            className="input mono"
            id={`${id}-typed`}
            placeholder="example.com"
            autoComplete="off"
            inputMode="url"
            value={typed}
            aria-invalid={invalid || undefined}
            aria-describedby={`${id}-typed-hint`}
            data-autofocus={connected && zones.length ? undefined : ""}
            onChange={(e) => {
              setTyped(e.target.value)
              setInvalid(false)
              if (e.target.value && !touchedReceiving) setReceiving(true)
            }}
          />
          {invalid ? (
            <span className="field-error" id={`${id}-typed-hint`} role="alert">
              {typed
                ? "That isn’t a domain name. Type it like coursified.app."
                : "Pick a zone or type a domain."}
            </span>
          ) : (
            <span className="hint" id={`${id}-typed-hint`}>
              The domain you’ll send and receive mail from, like <span className="mono">coursified.app</span>.
              Mailyard shows the records to add and checks them against public DNS.
            </span>
          )}
        </div>
        {candidates.isSuccess && !connected ? (
          <TokenNote
            odId="candidates-token-note"
            lead="Connect a zone token to pick a domain from your Cloudflare account instead of typing it."
          />
        ) : null}
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>
            Use it for
          </legend>
          <label className="switch">
            <input
              type="checkbox"
              checked={receiving}
              onChange={(e) => {
                setReceiving(e.target.checked)
                setTouchedReceiving(true)
              }}
            />
            Receiving mail (routing)
          </label>
          <label className="switch">
            <input type="checkbox" checked={sending} onChange={(e) => setSending(e.target.checked)} />
            Sending mail
          </label>
          {hint ? (
            <span className="hint">
              Receiving is off because <span className="mono">{picked.name}</span> already gets mail
              elsewhere. Turn it on only when you’re moving that mail here.
            </span>
          ) : null}
        </fieldset>
        {err ? (
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>
              <b>{err.status === 409 ? "That domain is already here." : "Mailyard didn’t add it."}</b>{" "}
              {err.message} {err.requestId ? <RequestId id={err.requestId} /> : null}
            </span>
          </div>
        ) : create.error ? (
          <div className="callout callout-error" role="alert">
            <Icon name="x-circle" />
            <span>Mailyard couldn’t be reached. Nothing was added; try again.</span>
          </div>
        ) : null}
      </form>
    </Sheet>
  )
}

export function ZoneChoice({
  c,
  group,
  selected,
  onPick,
}: {
  c: Candidate
  group: string
  selected: boolean
  onPick: () => void
}) {
  const added = c.inWorkspace
  return (
    <label className={`choice cand${added ? " is-disabled" : ""}${selected ? " is-selected" : ""}`}>
      <input
        className="check dm-radio"
        type="radio"
        name={group}
        disabled={added}
        checked={selected}
        onChange={onPick}
      />
      <span className="c-name mono">{c.name}</span>
      {added ? (
        <StatePill state={{ tone: "neutral", label: "Already added" }} />
      ) : (
        <StatePill
          state={
            c.zoneStatus === "active"
              ? { tone: "pass", label: "Active zone" }
              : { tone: "warn", label: c.zoneStatus === "pending" ? "Pending nameservers" : c.zoneStatus }
          }
        />
      )}
      <span className="c-sub">
        {c.registrar ?? "Registrar unknown"}
        {c.nameservers.length ? (
          <>
            {" · "}
            <span className="mono">{c.nameservers.join(", ")}</span>
          </>
        ) : null}
      </span>
      {c.workspaceDomains.length ? (
        <span className="c-sub">
          In this workspace: <span className="mono">{c.workspaceDomains.join(", ")}</span>
        </span>
      ) : null}
      {!added && c.existingMx.length ? (
        <span className="c-warn" role="note">
          <Icon name="warn" className="icon-12" />
          <span>
            <b>This domain already receives mail elsewhere</b> (
            <span className="mono">{c.existingMx.join(", ")}</span>
            ). Turning on routing replaces those MX records, so that mail would come to Mailyard instead. Add
            it for sending only to leave them alone.
          </span>
        </span>
      ) : null}
    </label>
  )
}
