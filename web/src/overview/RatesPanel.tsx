/**
 * Rates against Cloudflare's thresholds. The rates follow the range (/v1/stats/delivery); the lines come from
 * the account's own policy (/v1/reputation), and the level is computed here (HANDOFF §5).
 */
import { useQuery } from "@tanstack/react-query"
import { fmtInt, num } from "../lib/format.ts"
import { Icon } from "../ui/icons.tsx"
import { Panel } from "../ui/Panel.tsx"
import {
  classifyRate,
  DEFAULT_POLICY,
  fmtRate,
  LEVEL_PILL,
  type Line,
  MINIMUM_SENDS,
  type Policy,
  RANGE_LABEL,
  type Range,
  thresholdGeometry,
  type Wire,
} from "./logic.ts"
import { deliveryQuery, type Ok, reputationQuery } from "./queries.ts"
import { AppLink, combineQueries, PanelFoot, StaleMeta, useOffline } from "./shared.tsx"

type Data = { delivery: Ok<"/v1/stats/delivery">; reputation: Ok<"/v1/reputation"> | undefined }

export function RatesPanel({ range }: { range: Range }) {
  const offline = useOffline()
  const delivery = useQuery(deliveryQuery(range))
  const reputation = useQuery(reputationQuery)
  // The lines can fall back to Cloudflare's published policy, so only the rates themselves are required.
  const query = combineQueries<Data>([delivery], [reputation], () => ({
    delivery: delivery.data as Data["delivery"],
    reputation: reputation.data,
  }))
  return (
    <Panel
      id="rates"
      title="Rates against Cloudflare’s thresholds"
      to="/domains/reputation"
      linkLabel="Reputation"
      span={5}
      endpoint={`GET /v1/stats/delivery?range=${range} · GET /v1/reputation (policy)`}
      meta={<StaleMeta offline={offline} updatedAt={query.dataUpdatedAt} label={RANGE_LABEL[range]} />}
      query={query}
      skeleton={<RatesSkeleton />}
    >
      {({ delivery: d, reputation: rep }) => {
        const policy: Policy = rep?.policy ?? DEFAULT_POLICY
        const minimum = num(d.rates.minimumSends) ?? MINIMUM_SENDS
        const common = { sent: d.totals.sent, minimum, insufficient: d.rates.insufficientData }
        return (
          <>
            {rep?.source === "not-connected" ? (
              <div className="callout callout-info ov-mb-12">
                <Icon name="info" />
                <span>
                  <b>Judged on our own rates.</b> Cloudflare reputation isn’t connected, so these levels are
                  Mailyard’s counts against the policy lines, not Cloudflare’s verdict.
                </span>
              </div>
            ) : null}
            <div>
              <Threshold
                name="Bounce rate"
                anchor="bounce"
                rate={d.rates.bounceRate}
                line={policy.customer_bounce}
                {...common}
              />
              <Threshold
                name="Complaint rate · of delivered"
                anchor="complaint"
                rate={d.rates.complaintRate}
                line={policy.complaint}
                {...common}
              />
              <Threshold
                name="Spam rejection rate"
                anchor="spam"
                rate={d.rates.rejectionRate}
                line={policy.spam_rejection}
                {...common}
              />
            </div>
            <PanelFoot>
              <span>
                Lines are{" "}
                {!rep
                  ? "Cloudflare’s published policy, because this account’s reputation didn’t load"
                  : rep.policySource === "account"
                    ? "this account’s own Cloudflare policy"
                    : "Cloudflare’s policy as measured on 16 Oct 2026, because this account’s own policy isn’t readable"}
                {rep ? (
                  <>
                    {" "}
                    (policySource: <code className="mono">{rep.policySource}</code>; minimum{" "}
                    {fmtInt(policy.customer_bounce.minimum_denominator)} sends)
                  </>
                ) : null}
                . Complaints are counted against deliveries.
              </span>
            </PanelFoot>
          </>
        )
      }}
    </Panel>
  )
}

function Threshold({
  name,
  anchor,
  rate,
  line,
  sent,
  minimum,
  insufficient,
}: {
  name: string
  anchor: string
  rate: Wire
  line: Line
  sent: Wire
  minimum: number
  insufficient: boolean
}) {
  const level = classifyRate(rate, line, { sent, minimum, insufficient })
  const g = thresholdGeometry(rate, line.warning_at, line.at_risk_at)
  const warn = fmtRate(line.warning_at)
  const risk = fmtRate(line.at_risk_at)
  const pill = LEVEL_PILL[level]
  const scale = (
    <div className="thresh-scale" aria-hidden="true">
      <span style={{ left: `${g.warnAt.toFixed(1)}%` }}>Warning {warn}</span>
      <span className="risk" style={{ left: `${g.riskAt.toFixed(1)}%` }}>
        At risk {risk}
      </span>
    </div>
  )
  const lines = (
    <>
      <i className="thresh-line" style={{ left: `${g.warnAt.toFixed(1)}%` }} />
      <i className="thresh-line risk" style={{ left: `${g.riskAt.toFixed(1)}%` }} />
    </>
  )
  if (level === "insufficient-data") {
    return (
      <AppLink className="thresh is-insufficient ov-plain-link" href={`/domains/reputation#${anchor}`}>
        <div className="thresh-head">
          <span className="thresh-name">{name}</span>
          <span className="pill pill-neutral">Not enough data yet</span>
        </div>
        <div
          className="thresh-track"
          role="img"
          aria-label={`${name}: not enough data yet, ${fmtInt(sent)} of ${minimum} sends`}
        >
          {lines}
        </div>
        {scale}
        <div className="thresh-note">
          {fmtInt(sent)} of {minimum} sends. Cloudflare doesn’t rate an account under {minimum}, so neither do
          we.
        </div>
      </AppLink>
    )
  }
  return (
    <AppLink className={`thresh is-${level} ov-plain-link`} href={`/domains/reputation#${anchor}`}>
      <div className="thresh-head">
        <span className="thresh-name">{name}</span>
        <span className="cluster">
          <span className="thresh-value">{fmtRate(rate)}</span>
          <span className={`pill ${pill.cls}`}>
            <span className="dot" />
            {pill.label}
          </span>
        </span>
      </div>
      <div
        className="thresh-track"
        role="img"
        aria-label={`${name} ${fmtRate(rate)}; warning at ${warn}, at risk at ${risk}`}
      >
        <span className="thresh-fill" style={{ width: `${g.fill.toFixed(2)}%` }} />
        {lines}
      </div>
      {scale}
    </AppLink>
  )
}

function RatesSkeleton() {
  return (
    <div className="stack stack-24" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="stack stack-8">
          <span className="sk sk-title" />
          <span className="sk sk-bar" style={{ height: 12 }} />
        </div>
      ))}
    </div>
  )
}
