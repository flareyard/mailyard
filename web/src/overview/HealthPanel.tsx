/**
 * Health strip: one row per domain (zone, routing, sending, SPF, DKIM, DMARC, return path, delivery events),
 * the Mailyard service row from /v1/health, and the account line (reputation with when Cloudflare evaluated it,
 * and today's quota).
 */
import { useQueries, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { fmtInt, num, toDate } from "../lib/format.ts"
import { Panel } from "../ui/Panel.tsx"
import {
  ago,
  type ChipStatus,
  hhmm,
  LEVEL_PILL,
  type Level,
  quotaPill,
  SERVICE_CHIP,
  SERVICE_LABEL,
  worstCheck,
  worstLevel,
} from "./logic.ts"
import {
  domainQuery,
  domainsQuery,
  healthQuery,
  type Ok,
  reputationQuery,
  sendingEventsQuery,
  usageQuery,
} from "./queries.ts"
import { AppLink, CheckChip, combineQueries, optional, StaleMeta, useOffline } from "./shared.tsx"

type DomainSummary = Ok<"/v1/domains">["domains"][number]
type DomainDetail = Ok<"/v1/domains/{id}">
type Coverage = Ok<"/v1/sending/events">["domains"][number]
type Health = Ok<"/v1/health">
type Reputation = Ok<"/v1/reputation">
type Usage = Ok<"/v1/usage">
type DetailState = { data: DomainDetail | undefined; pending: boolean; error: boolean }

type Data = {
  domains: DomainSummary[]
  details: Map<string, DetailState>
  health: Health
  coverage: Coverage[] | undefined
  reputation: Reputation | undefined
  usage: Usage | undefined
}

export function HealthPanel() {
  const offline = useOffline()
  const domains = useQuery(domainsQuery)
  const health = useQuery(healthQuery)
  const events = useQuery(sendingEventsQuery)
  const reputation = useQuery(reputationQuery)
  const usage = useQuery(usageQuery)
  const list = domains.data?.domains ?? []
  const details = useQueries({ queries: list.map((d) => domainQuery(d.id)) })

  const query = combineQueries<Data>([domains, health], [events, reputation, usage, ...details], () => ({
    domains: list,
    details: new Map(
      list.map((d, i) => [
        d.id,
        {
          data: details[i]?.data,
          pending: details[i]?.isPending ?? true,
          error: details[i]?.isError ?? false,
        },
      ]),
    ),
    health: health.data as Health,
    coverage: events.data?.domains,
    reputation: reputation.data,
    usage: usage.data,
  }))
  const count = list.length

  return (
    <Panel
      id="health"
      title="Health"
      to="/domains"
      linkLabel="Domains"
      span={12}
      endpoint="GET /v1/domains · GET /v1/domains/{id} · GET /v1/health · GET /v1/sending/events · GET /v1/reputation · GET /v1/usage"
      meta={
        offline ? (
          <StaleMeta offline updatedAt={query.dataUpdatedAt} label="" />
        ) : domains.data ? (
          `${count} ${count === 1 ? "domain" : "domains"}`
        ) : undefined
      }
      query={query}
      skeleton={<HealthSkeleton />}
    >
      {(d) => (
        <>
          <div className="health">
            {d.domains.length ? (
              d.domains.map((dom) => (
                <DomainRow
                  key={dom.id}
                  summary={dom}
                  detail={d.details.get(dom.id)}
                  coverage={d.coverage?.find((c) => c.domainId === dom.id || c.domain === dom.name)}
                />
              ))
            ) : (
              <div className="health-row">
                <div className="health-domain">
                  <span className="t-label strong">No domains yet</span>
                </div>
                <p className="t-small muted">
                  Mail sends and arrives through a domain on your Cloudflare account.{" "}
                  <AppLink href="/domains">Add a domain</AppLink> and its checks show here.
                </p>
              </div>
            )}
            <ServiceRow health={d.health} />
          </div>
          <AccountLine reputation={d.reputation} usage={d.usage} />
        </>
      )}
    </Panel>
  )
}

function HealthSkeleton() {
  const chips = (
    <div className="cluster">
      {Array.from({ length: 7 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <span key={i} className="sk sk-chip" />
      ))}
    </div>
  )
  return (
    <div className="stack stack-16" aria-hidden="true">
      <div className="health-row" style={{ paddingTop: 0 }}>
        <span className="sk sk-text" style={{ width: "70%" }} />
        {chips}
      </div>
      <div className="health-row">
        <span className="sk sk-text" style={{ width: "80%" }} />
        {chips}
      </div>
    </div>
  )
}

const changedNote = (at: number | string | null | undefined) => {
  const d = toDate(at ?? null)
  return d ? `changed ${ago(d)}` : undefined
}

function DomainRow({
  summary,
  detail,
  coverage,
}: {
  summary: DomainSummary
  detail: DetailState | undefined
  coverage: Coverage | undefined
}) {
  const dom = detail?.data
  const zs = dom?.zoneStatus ?? summary.zoneStatus
  const receiving = dom?.receiving ?? summary.receiving
  const sending = dom?.sending ?? summary.sending
  const checks = dom?.checks ?? []
  const byId = (id: string) => checks.find((c) => c.id === id)
  const chip = (label: string, id: string) => {
    const c = byId(id)
    return c ? (
      <CheckChip label={label} status={c.status} {...optional("note", changedNote(c.changedAt))} />
    ) : (
      <CheckChip label={label} status="off" sub="not set up" />
    )
  }
  const items: { key: string; node: ReactNode }[] = [
    {
      key: "zone",
      node: zs ? (
        <CheckChip
          label="Zone"
          status={zs === "active" ? "pass" : "warn"}
          {...optional("sub", zs === "active" ? undefined : zs)}
        />
      ) : (
        <CheckChip
          label="Zone"
          status="off"
          sub="unknown without a zone token"
          tip="Zone status is unknown until Mailyard can read the zone"
        />
      ),
    },
    {
      key: "routing",
      node: (
        <CheckChip
          label="Routing"
          status={receiving ? "pass" : "off"}
          {...optional("sub", receiving ? undefined : "off")}
        />
      ),
    },
    {
      key: "sending",
      node: (
        <CheckChip
          label="Sending"
          status={sending ? "pass" : "off"}
          {...optional("sub", sending ? undefined : "off")}
        />
      ),
    },
  ]
  if (dom) {
    items.push(
      { key: "spf", node: chip("SPF", "spf") },
      { key: "dkim", node: chip("DKIM", "dkim") },
      { key: "dmarc", node: chip("DMARC", "dmarc") },
    )
    const rp = ["bounce-mx", "bounce-spf", "bounce-dkim"]
      .map((id) => byId(id)?.status)
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
    items.push({
      key: "return-path",
      node: (
        <CheckChip
          label="Return path"
          status={rp.length ? worstCheck(rp) : "off"}
          {...optional("sub", rp.length ? undefined : "not set up")}
        />
      ),
    })
  } else if (detail?.error) {
    items.push({
      key: "records",
      node: (
        <CheckChip
          label="DNS records"
          status="error"
          sub="couldn’t be read"
          tip="This domain’s record checks didn’t load. They retry when you come back to the tab."
        />
      ),
    })
  } else {
    for (const k of ["spf", "dkim", "dmarc", "rp"])
      items.push({ key: k, node: <span className="sk sk-chip" aria-hidden="true" /> })
  }
  if (sending && coverage) {
    const status: ChipStatus = coverage.status === "ok" ? "pass" : coverage.status === "warn" ? "fail" : "off"
    const sub =
      coverage.status === "unknown" ? "unknown" : coverage.status === "warn" ? "none arriving" : undefined
    items.push({
      key: "events",
      node: (
        <span title={coverage.detail}>
          <CheckChip label="Delivery events" status={status} {...optional("sub", sub)} />
        </span>
      ),
    })
  }
  const recent = checks.filter((c) => c.changedAt && (c.status === "fail" || c.status === "warn"))
  const rechecking = checks.some((c) => c.status === "checking")
  const coverageNote =
    coverage && sending && (coverage.status === "warn" || coverage.detail.includes(" again."))
  const checked = toDate(summary.lastCheckedAt ?? dom?.lastCheckedAt ?? null)
  return (
    <div className="health-row">
      <div className="health-domain">
        <AppLink href={`/domains/${encodeURIComponent(summary.id)}`}>{summary.name}</AppLink>
        <span className="t-small muted">{checked ? `Checked ${ago(checked)}` : "Not checked yet"}</span>
      </div>
      <div className="stack stack-8">
        <ul className="health-checks ov-list-reset" aria-label={`Checks for ${summary.name}`}>
          {items.map((x) => (
            <li key={x.key}>{x.node}</li>
          ))}
        </ul>
        {recent.map((c) => (
          <p key={c.id} className={`t-small ${c.status === "fail" ? "ov-text-fail" : "ov-text-warn"}`}>
            {c.id.toUpperCase()} {changedNote(c.changedAt)}: {c.detail}
          </p>
        ))}
        {rechecking ? (
          <p className="t-small muted" role="status">
            Rechecking every record now; the chips update as each one answers.
          </p>
        ) : null}
        {coverageNote ? (
          <p
            className={`t-small ${coverage.status === "warn" ? "ov-text-fail" : "ov-text-pass"}`}
            data-endpoint="GET /v1/sending/events"
          >
            {coverage.detail}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function ServiceRow({ health }: { health: Health }) {
  const checked = toDate(health.checkedAt)
  const loud = health.checks.filter((c) => c.status === "warn" || c.status === "fail")
  return (
    <div className="health-row" data-endpoint="GET /v1/health">
      <div className="health-domain">
        <span className="t-label strong">Mailyard</span>
        <span className="t-small muted">{checked ? `Checked ${ago(checked)}` : ""}</span>
      </div>
      <div className="stack stack-8">
        <ul className="health-checks ov-list-reset" aria-label="Service checks">
          {health.checks.map((c) => (
            <li key={c.name} title={c.detail}>
              <CheckChip
                label={SERVICE_LABEL[c.name] ?? c.name}
                status={SERVICE_CHIP[c.status] ?? "off"}
                {...optional("sub", c.status === "unknown" ? "unknown" : undefined)}
              />
            </li>
          ))}
        </ul>
        {loud.map((c) => (
          <p key={c.name} className={`t-small ${c.status === "fail" ? "ov-text-fail" : "ov-text-warn"}`}>
            {SERVICE_LABEL[c.name] ?? c.name}: {c.detail}
          </p>
        ))}
      </div>
    </div>
  )
}

const REP_PILL: Record<string, { cls: string; label: string }> = {
  healthy: { cls: "pill-pass", label: "Healthy" },
  warning: { cls: "pill-warn", label: "Warning" },
  at_risk: { cls: "pill-fail", label: "At risk" },
  suspended: { cls: "pill-fail", label: "Suspended" },
}

function AccountLine({
  reputation,
  usage,
}: {
  reputation: Reputation | undefined
  usage: Usage | undefined
}) {
  return (
    <div className="health-account ov-health-account" data-endpoint="GET /v1/reputation · GET /v1/usage">
      <span className="ha">
        Reputation <ReputationBits reputation={reputation} />
      </span>
      <span className="ha">
        Quota today <QuotaBits usage={usage} />
      </span>
    </div>
  )
}

function ReputationBits({ reputation: rep }: { reputation: Reputation | undefined }) {
  if (!rep) return <span className="muted t-small">couldn’t be read just now</span>
  if (rep.source === "not-connected") {
    const lv: Level = worstLevel(Object.values(rep.levels))
    return (
      <>
        <span className="pill pill-neutral">Cloudflare not connected</span>
        <span className={`pill ${LEVEL_PILL[lv].cls}`}>
          <span className="dot" />
          {LEVEL_PILL[lv].label}
        </span>
        <span className="muted t-small">judged on our own rates</span>
      </>
    )
  }
  const pill = (rep.status && REP_PILL[rep.status]) || { cls: "pill-neutral", label: "Not rated yet" }
  const ev = toDate(rep.evaluatedAt)
  return (
    <>
      <span className={`pill ${pill.cls}`}>
        <span className="dot" />
        {pill.label}
      </span>
      <span className="muted t-small">
        {ev
          ? `from Cloudflare, evaluated ${hhmm(ev)} UTC · ${ago(ev)}`
          : "from Cloudflare, not evaluated yet"}
      </span>
    </>
  )
}

function QuotaBits({ usage }: { usage: Usage | undefined }) {
  if (!usage) return <span className="muted t-small">couldn’t be read just now</span>
  const t = usage.today
  const sent = num(t.sent) ?? 0
  const quota = num(t.quota)
  if (quota === null || t.source !== "cloudflare") {
    const why = t.source === "not-connected" ? "Cloudflare not connected" : "Cloudflare didn’t answer"
    return (
      <>
        <span className="pill pill-neutral">
          <span className="num">{fmtInt(sent)} sent</span>
        </span>
        <span className="muted t-small">quota unknown · {why}</span>
      </>
    )
  }
  const resets = toDate(t.resetsAt)
  return (
    <>
      <span className={`pill ${quotaPill(sent, quota, t.overQuota)}`}>
        <span className="dot" />
        <span className="num">
          {fmtInt(sent)} / {fmtInt(quota)}
        </span>
      </span>
      {resets ? <span className="muted t-small">resets {hhmm(resets)} UTC</span> : null}
    </>
  )
}
