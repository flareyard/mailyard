/**
 * Import a domain from another registrar (design: import-candidates, -zone-token; import-* for the later
 * steps). The import itself (`POST /v1/domains/import` and its Workflow, HAL-3312) isn't in the live API, so
 * Start import stays visible and disabled with the reason, and the later steps aren't drawn with invented data.
 * What works today is shown: the domain you'd import, checked as a name, and the account's zones from
 * `GET /v1/domains/candidates`, which don't need importing at all (Add a domain picks them up).
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { useId, useState } from "react"
import { NeedsRoute, PlannedPill, useRoute } from "../ops/kit.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelSkeleton } from "../ui/Panel.tsx"
import { ZoneChoice } from "./AddDomainSheet.tsx"
import { type Candidate, cleanDomain } from "./logic.ts"
import { candidatesQuery } from "./queries.ts"
import { DomainsHead, TokenNote } from "./ui.tsx"
import "./domains.css"

const STEPS = ["Detected", "Records", "DNSSEC off", "Nameservers", "Waiting", "Active"]

export function ImportPage() {
  const id = useId()
  const candidates = useQuery(candidatesQuery)
  const live = useRoute("POST", "/v1/domains/import")
  const connected = candidates.data?.connected === true
  const zones = candidates.data?.candidates ?? []
  const [typed, setTyped] = useState("")
  const [picked, setPicked] = useState<Candidate | null>(null)
  const name = typed ? cleanDomain(typed) : null

  return (
    <>
      <DomainsHead
        title={
          <>
            Import
            {name ? (
              <>
                {" "}
                <span className="mono dm-title-mono">{name}</span>
              </>
            ) : (
              " a domain"
            )}
          </>
        }
        sub="Bring a domain from another registrar, keeping its website and mail working throughout."
      />
      <ol className="wiz" aria-label="Import steps" data-od-id="import-steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === 0 ? "is-current" : ""} aria-current={i === 0 ? "step" : undefined}>
            <span className="wiz-bar" />
            <span className="wiz-label">
              {i + 1}. {s}
            </span>
          </li>
        ))}
      </ol>
      <div className="split-2">
        <div className="stack">
          <section
            className="panel"
            data-endpoint="GET /v1/domains/candidates · POST /v1/domains/import (planned, HAL-3312)"
            data-od-id="panel-candidates"
            aria-labelledby="h-candidates"
          >
            <header className="panel-head">
              <h2 className="panel-title" id="h-candidates">
                Which domain?
              </h2>
              <div className="cluster">{live ? null : <PlannedPill issue="HAL-3312" />}</div>
            </header>
            <div className="panel-body">
              <div className="stack stack-12">
                {candidates.isPending ? <PanelSkeleton rows={3} /> : null}
                {connected && zones.length ? (
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
                        onPick={() => {
                          setPicked(c)
                          setTyped("")
                        }}
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
                    aria-invalid={typed && !name ? true : undefined}
                    aria-describedby={`${id}-hint`}
                    onChange={(e) => {
                      setTyped(e.target.value)
                      setPicked(null)
                    }}
                  />
                  {typed && !name ? (
                    <span className="field-error" id={`${id}-hint`}>
                      That isn’t a domain name. Type it like learnwithhal.com.
                    </span>
                  ) : (
                    <span className="hint" id={`${id}-hint`}>
                      The domain you’ll import, like <span className="mono">learnwithhal.com</span>. Mailyard
                      finds its registrar, nameservers and DNSSEC, then collects every record before anything
                      moves.
                    </span>
                  )}
                </div>
                {connected && zones.length ? (
                  <p className="hint">
                    Zones already on this Cloudflare account don’t need importing.{" "}
                    {picked && !picked.inWorkspace ? (
                      <Link to="/domains" search={{ add: 1 }}>
                        Add <span className="mono">{picked.name}</span> instead
                      </Link>
                    ) : (
                      <Link to="/domains" search={{ add: 1 }}>
                        Add one instead
                      </Link>
                    )}
                    .
                  </p>
                ) : null}
                {candidates.isSuccess && !connected ? (
                  <TokenNote
                    odId="candidates-token-note"
                    lead="Connect a zone token to pick a domain from your Cloudflare account instead of typing it."
                  />
                ) : null}
                <div>
                  <NeedsRoute
                    method="POST"
                    path="/v1/domains/import"
                    issue="HAL-3312"
                    what="Importing a domain"
                  >
                    <button
                      className="btn btn-primary"
                      type="button"
                      data-endpoint="POST /v1/domains/import { name } (planned, HAL-3312)"
                    >
                      <Icon name="upload" />
                      Start import
                    </button>
                  </NeedsRoute>
                </div>
              </div>
            </div>
          </section>
        </div>
        <div className="stack">
          <section className="panel" data-endpoint="static" data-od-id="panel-how" aria-labelledby="h-how">
            <header className="panel-head">
              <h2 className="panel-title" id="h-how">
                What the import does
              </h2>
            </header>
            <div className="panel-body">
              <ol className="dm-steps">
                <li>Finds the registrar, nameservers and DNSSEC.</li>
                <li>
                  Collects every record from three sources: Cloudflare’s scan, the registrar’s export and our
                  own probe.
                </li>
                <li>You review them, then we turn DNSSEC off and switch nameservers.</li>
                <li>
                  We watch until the zone is active, check the website and mail still resolve the same, and
                  turn DNSSEC back on.
                </li>
              </ol>
              <p className="hint" style={{ marginTop: 8 }}>
                It runs as a Workflow, so it survives restarts and emails you when it’s done.
                {live
                  ? null
                  : " This Mailyard can’t import yet; move the nameservers yourself and add the domain once Cloudflare has the zone."}
              </p>
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
