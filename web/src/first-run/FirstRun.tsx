/**
 * The first run (HANDOFF §1 step 7, §2): `/` is this checklist until the four required steps pass (domain added,
 * mail on, first mailbox, test sent), then the Overview. Steps 5 and 6 are optional and can be skipped. Every
 * status is derived from live data; only "skipped" and the hand-over are remembered, per browser.
 */
import { Link, useNavigate, useRouter } from "@tanstack/react-router"
import { type MouseEvent, type ReactNode, useEffect } from "react"
import { useCapabilities } from "../auth/capabilities.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { fixturesEnabled } from "../fixtures/mode.ts"
import type { OverviewSearch } from "../routes/_app/index.tsx"
import { usePageTitle } from "../shell/title.tsx"
import { Icon } from "../ui/icons.tsx"
import { PanelSkeleton } from "../ui/Panel.tsx"
import "./first-run.css"
import { doneCount, isStepId, type Step, type StepId, showChecklist, stepSub } from "./logic.ts"
import { type Setup, SetupProvider, useSetup, useSetupData, type View } from "./setup.tsx"
import { CsvStep } from "./steps/CsvStep.tsx"
import { DomainStep } from "./steps/DomainStep.tsx"
import { EnableStep } from "./steps/EnableStep.tsx"
import { ImapStep } from "./steps/ImapStep.tsx"
import { MailboxStep } from "./steps/MailboxStep.tsx"
import { TestStep } from "./steps/TestStep.tsx"

/** `/`: the checklist while setup isn't done (or `?setup=1`), the Overview after. */
export function FirstRunGate({
  forced,
  step,
  overview,
}: {
  forced: boolean
  step: string | undefined
  overview: ReactNode
}) {
  const setup = useSetupData()
  const { memory, remember, ready, requiredDone } = setup
  const checklist =
    ready &&
    !setup.failed &&
    showChecklist({
      requiredDone,
      started: Boolean(memory.started),
      handedOver: Boolean(memory.handedOver),
      forced,
    })

  // A setup seen unfinished in this browser stays open until its hand-over, so the optional steps get a turn.
  useEffect(() => {
    if (ready && !setup.failed && !requiredDone && !memory.started) remember((m) => ({ ...m, started: true }))
  }, [ready, setup.failed, requiredDone, memory.started, remember])

  if (!ready) return <GateSkeleton />
  // If setup's own reads fail, the Overview (with its own error states) is more use than a blocked page.
  if (!checklist) return <>{overview}</>
  const view: View = step === "complete" ? "complete" : isStepId(step) ? step : (setup.current ?? "complete")
  return (
    <SetupProvider setup={setup} view={view}>
      <SetupTitle />
      <FirstRun />
    </SetupProvider>
  )
}

/** While the checklist is `/`, the top bar says "Set up", as the design does, not the route's "Overview". */
function SetupTitle() {
  usePageTitle("Set up")
  return null
}

function GateSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading setup…
      </span>
      <div className="page-head">
        <div>
          <span className="sk sk-title" style={{ width: 220 }} />
        </div>
      </div>
      <div className="setup">
        <div className="steps">
          <PanelSkeleton rows={6} />
        </div>
        <section className="panel step-panel">
          <div className="panel-body">
            <PanelSkeleton rows={4} />
          </div>
        </section>
      </div>
    </div>
  )
}

function FirstRun() {
  const s = useSetup()
  const allDone = doneCount(s.steps) === 6
  return (
    <>
      <div className="page-head" data-od-id="page-head">
        <div>
          <h1 data-od-id="page-title">Set up Mailyard</h1>
          <p className="sub">
            {s.view === "complete" && allDone
              ? "All six steps are done."
              : s.view === "complete" && s.requiredDone
                ? "The required steps are done."
                : "Six steps, two of them optional. When they’re done, this page becomes your Overview."}
          </p>
        </div>
        <div className="cluster cluster-12">
          {fixturesEnabled() ? (
            <span className="pill pill-sample sample-marker" data-od-id="sample-data-marker">
              <Icon name="info" />
              Sample data
              <span className="sr-only">: Every name and figure on this screen is fixture data.</span>
            </span>
          ) : null}
        </div>
      </div>
      <div className="setup">
        <Stepper steps={s.steps} view={s.view} current={s.current} />
        <ActiveStep view={s.view} />
      </div>
    </>
  )
}

function Stepper({ steps, view, current }: { steps: Step[]; view: View; current: StepId | null }) {
  const done = doneCount(steps)
  return (
    <ol className="steps" aria-label="Setup steps" data-od-id="setup-steps">
      <li className="setup-progress">
        <div className="spread">
          <span className="t-h4">{done} of 6 done</span>
          <span className="t-small muted">2 are optional</span>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={6}
          aria-valuenow={done}
          aria-label="Setup progress"
        >
          <span style={{ width: `${Math.round((done / 6) * 100)}%` }} />
        </div>
      </li>
      {steps.map((st) => {
        const cls =
          st.status === "done"
            ? "is-done"
            : st.status === "running"
              ? "is-running"
              : st.status === "fail"
                ? "is-fail"
                : ""
        return (
          <li key={st.id}>
            <StepLink
              className={`step ${cls}`}
              step={st.id}
              current={view === st.id}
              data-od-id={`step-${st.id}`}
            >
              <span className="step-num">
                {st.status === "done" ? (
                  <Icon name="check" label="Done" />
                ) : st.status === "fail" ? (
                  <Icon name="x" label="Needs a fix" />
                ) : (
                  st.n
                )}
              </span>
              <span className="step-title">
                {st.title}
                {st.optional ? <span className="step-opt"> · optional</span> : null}
              </span>
              <span className="step-sub">
                {stepSub(st, (view === "complete" ? current : view) === st.id)}
              </span>
            </StepLink>
          </li>
        )
      })}
    </ol>
  )
}

function ActiveStep({ view }: { view: View }) {
  switch (view) {
    case "domain":
      return <DomainStep />
    case "enable":
      return <EnableStep />
    case "mailbox":
      return <MailboxStep />
    case "test":
      return <TestStep />
    case "imap":
      return <ImapStep />
    case "csv":
      return <CsvStep />
    default:
      return <Complete />
  }
}

/** The hand-over (design: first-run/complete.html): what was set up, then the Overview. */
function Complete() {
  const s = useSetup()
  const caps = useCapabilities()
  const invitesLive = caps.has("POST", "/v1/invites")
  const firstMissing = s.steps.find((x) => !x.optional && x.status !== "done")
  return (
    <section className="panel step-panel" data-od-id="setup-complete" aria-labelledby="sp-title">
      <div className="panel-body">
        <div>
          <span className="t-small muted">Setup</span>
          <h2 id="sp-title" tabIndex={-1} style={{ marginTop: 4 }}>
            {firstMissing ? "Almost there" : "You’re set up"}
          </h2>
          <p className="lede">
            {firstMissing
              ? `${firstMissing.title} is still to do. The Overview takes over once the four required steps pass.`
              : "This checklist now steps aside: from here, Overview shows health, what needs you, and what’s going out. Its panels fill as mail moves; rates appear after 100 sends."}
          </p>
        </div>
        <ul className="list">
          {s.steps.map((st) => (
            <li key={st.id} className="list-row">
              <Icon
                name={
                  st.status === "done" ? "check-circle" : st.status === "fail" ? "x-circle" : "circle-dash"
                }
                className={
                  st.status === "done" ? "status-pass" : st.status === "fail" ? "status-fail" : "status-idle"
                }
              />
              <span className="grow">
                <span className="row-title">{st.title}</span>
                <span className="row-sub">{stepSub(st, false)}</span>
              </span>
              {st.status !== "done" ? (
                <Link className="link-quiet" from="/" to="/" search={(prev) => ({ ...prev, step: st.id })}>
                  {st.status === "skipped" ? "Do it now" : "Open"}
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="cluster cluster-12">
          {firstMissing ? (
            <button className="btn btn-primary" type="button" onClick={() => s.goTo(firstMissing.id)}>
              Next: {firstMissing.title.toLowerCase()}
              <Icon name="arrow-right" />
            </button>
          ) : (
            <Link
              className="btn btn-primary"
              from="/"
              to="/"
              search={(prev) => ({ ...(prev.range ? { range: prev.range } : {}) })}
              onClick={() => s.remember((m) => ({ ...m, handedOver: true, started: true }))}
            >
              Go to Overview
              <Icon name="arrow-right" />
            </Link>
          )}
          {invitesLive ? (
            <Link className="btn btn-secondary" to="/settings">
              <Icon name="user-plus" />
              Invite your team
            </Link>
          ) : (
            <>
              <Gated
                allowed={false}
                reason="Invites aren’t live yet"
                who="Members and invites arrive with HAL-3361."
              >
                <button className="btn btn-secondary" type="button">
                  <Icon name="user-plus" />
                  Invite your team
                </button>
              </Gated>
              <span className="pill pill-proposal" data-od-id="proposed-marker">
                Planned · HAL-3361
                <span className="sr-only">
                  . Members and invites are planned (HAL-3361); the role matrix needs founder sign-off.
                </span>
              </span>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

export type { Setup }

/**
 * A stepper item. Router `Link` forces `aria-current="page"` on active links, but a stepper's current item is
 * `aria-current="step"` (and the design CSS keys on it), so this is a plain anchor with a router-built href.
 */
function StepLink({
  step,
  current,
  className,
  children,
  ...rest
}: {
  step: View
  current: boolean
  className: string
  children: ReactNode
  "data-od-id"?: string
}) {
  const router = useRouter()
  const navigate = useNavigate()
  const href = router.buildLocation({
    to: "/",
    search: (prev) => ({ ...(prev as OverviewSearch), step }),
  }).href
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate({ from: "/", to: "/", search: (prev) => ({ ...prev, step }) })
  }
  return (
    <a
      className={className}
      href={href}
      onClick={onClick}
      {...(current ? { "aria-current": "step" as const } : {})}
      {...rest}
    >
      {children}
    </a>
  )
}
