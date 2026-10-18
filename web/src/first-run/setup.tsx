/**
 * Reads everything the checklist decides from (domains, the setup domain's checks, mailboxes, the test send,
 * the message log, both imports) and derives the steps. The gate and every step share it through context.
 */
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { roleAllows } from "../auth/NoPermission.tsx"
import { type Me, useMe } from "../auth/session.ts"
import { mailboxesQuery } from "../shell/AppFrame.tsx"
import {
  currentStep,
  deriveSteps,
  latest,
  pickDomain,
  pickMailbox,
  requiredDone,
  type SetupMemory,
  type Step,
  type StepId,
} from "./logic.ts"
import { useSetupMemory } from "./memory.ts"
import {
  type ContactImport,
  contactImportsQuery,
  type Domain,
  type DomainSummary,
  deliveredQuery,
  domainQuery,
  domainsQuery,
  type MailboxSummary,
  type MailImport,
  mailImportsQuery,
  type TestSend,
  testMessagesQuery,
  testSendQuery,
} from "./queries.ts"
import { useNow } from "./ui.tsx"

export type View = StepId | "complete"

export type Setup = {
  me: Me | undefined
  /** Settled enough to decide: domains and mailboxes answered (or failed). */
  ready: boolean
  /** The reads the gate can't decide without failed. */
  failed: boolean
  domain: (Domain | DomainSummary) | undefined
  detail: Domain | undefined
  mailboxes: MailboxSummary[]
  mailbox: MailboxSummary | undefined
  lastTest: TestSend | undefined
  mailImport: MailImport | undefined
  contactImport: ContactImport | undefined
  steps: Step[]
  requiredDone: boolean
  current: StepId | null
  memory: SetupMemory
  remember: (fn: (m: SetupMemory) => SetupMemory) => void
  /** Owners and admins set up; until roles exist, a key with the admin scope or the admin key. */
  canSetUp: boolean
  now: number
}

export function useSetupData(): Setup {
  const me = useMe()
  const [memory, remember] = useSetupMemory(me.data?.workspace.id)
  const now = useNow(30_000)

  const domains = useQuery(domainsQuery)
  const picked = pickDomain(domains.data)
  const detail = useQuery({ ...domainQuery(picked?.id ?? "-"), enabled: Boolean(picked) })
  const mailboxes = useQuery(mailboxesQuery)
  const mailboxList = useMemo(
    () => (Array.isArray(mailboxes.data?.mailboxes) ? mailboxes.data.mailboxes : []),
    [mailboxes.data],
  )
  const mailbox = pickMailbox(mailboxList, picked?.id)
  const lastTest = useQuery({
    ...testSendQuery(memory.lastTestId ?? "-"),
    enabled: Boolean(memory.lastTestId),
    retry: false,
  })
  const testMessages = useQuery(testMessagesQuery)
  const delivered = useQuery(deliveredQuery)
  const mailImports = useQuery({ ...mailImportsQuery(mailbox?.id ?? "-"), enabled: Boolean(mailbox) })
  const contactImports = useQuery(contactImportsQuery)

  // A fixture or an older deploy can answer with another shape; only a real domain detail counts.
  const domainDetail =
    detail.data && typeof detail.data === "object" && "checks" in detail.data ? detail.data : undefined
  const domain = domainDetail ?? picked
  const test = lastTest.data && "status" in lastTest.data ? lastTest.data : undefined
  const mailImport = latest(mailImports.data?.filter((i) => i.status !== "cancelled"))
  const contactImport = latest(contactImports.data?.filter((i) => i.status !== "cancelled"))
  const routing =
    memory.mailboxRouting && memory.mailboxRouting.mailboxId === mailbox?.id
      ? memory.mailboxRouting.routing
      : undefined

  const steps = deriveSteps({
    domain,
    turnedOnAt: memory.turnedOnAt,
    now,
    mailbox,
    mailboxRouting: routing,
    lastTest: test,
    testMessages: testMessages.data ?? [],
    delivered: delivered.data ?? [],
    mailImport,
    contactImport,
    skipped: memory.skipped ?? {},
  })

  const settled = (q: { isPending: boolean; fetchStatus: string }) => !q.isPending || q.fetchStatus === "idle"
  const ready =
    settled(domains) &&
    settled(mailboxes) &&
    (!picked || settled(detail)) &&
    (!memory.lastTestId || settled(lastTest)) &&
    settled(testMessages) &&
    settled(delivered)

  return {
    me: me.data,
    ready,
    failed: domains.isError || mailboxes.isError,
    domain,
    detail: domainDetail,
    mailboxes: mailboxList,
    mailbox,
    lastTest: test,
    mailImport,
    contactImport,
    steps,
    requiredDone: requiredDone(steps),
    current: currentStep(steps),
    memory,
    remember,
    canSetUp: roleAllows(me.data, ["owner", "admin"], "admin"),
    now,
  }
}

/**
 * What a step is doing right now that the API doesn't know yet: a create in flight ("running"), or a refusal
 * the person has to act on ("fail", like a 404 on add-domain or a routing-rule conflict). It colours the stepper
 * as the designs do and clears when the step settles.
 */
export type Mark = "running" | "fail"
type Ctx = Setup & { view: View; goTo: (v: View) => void; mark: (id: StepId, m: Mark | null) => void }
const SetupContext = createContext<Ctx | null>(null)

export function SetupProvider({ setup, view, children }: { setup: Setup; view: View; children: ReactNode }) {
  const navigate = useNavigate()
  const [marks, setMarks] = useState<Partial<Record<StepId, Mark>>>({})
  const mark = useCallback((id: StepId, m: Mark | null) => {
    setMarks((cur) => {
      if ((cur[id] ?? null) === m) return cur
      const next = { ...cur }
      if (m) next[id] = m
      else delete next[id]
      return next
    })
  }, [])
  const goTo = useCallback(
    (v: View) => {
      navigate({ to: "/", search: (prev) => ({ ...prev, step: v }) })
    },
    [navigate],
  )
  // A mark only colours a step that isn't done: once the API says done, done wins.
  const steps = setup.steps.map((st) => {
    const m = marks[st.id]
    return m && st.status !== "done" ? { ...st, status: m } : st
  })
  return (
    <SetupContext.Provider value={{ ...setup, steps, view, goTo, mark }}>{children}</SetupContext.Provider>
  )
}

export function useSetup(): Ctx {
  const c = useContext(SetupContext)
  if (!c) throw new Error("useSetup outside SetupProvider")
  return c
}

/** The step after this one: the next one not done, or the hand-over. */
export function nextAfter(steps: readonly Step[], id: StepId): View {
  const i = steps.findIndex((s) => s.id === id)
  const rest = steps.slice(i + 1).find((s) => s.status !== "done" && s.status !== "skipped")
  if (rest) return rest.id
  const earlier = steps.find((s) => !s.optional && s.status !== "done")
  return earlier?.id ?? "complete"
}

/** Who may set up, for the second line of a refusal. */
export const SETUP_WHO =
  "Owners and admins set up Mailyard. Until roles arrive (HAL-3361), that’s a key with the admin scope or the admin key."

/** Marks `id` with `m` while `when` holds, and clears it after. */
export function useMark(id: StepId, m: Mark, when: boolean) {
  const { mark } = useSetup()
  useEffect(() => {
    if (!when) return
    mark(id, m)
    return () => mark(id, null)
  }, [id, m, when, mark])
}
