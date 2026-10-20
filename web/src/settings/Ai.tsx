/**
 * Settings → AI (design: ai.html; HAL-3305). Reads and saves `GET/PUT /v1/settings/assistant`: which helpers
 * are on, the daily calls each mailbox may make per helper, the provider and model in use, and today's
 * calls and tokens. The provider itself is a deploy setting (MAILYARD_ASSISTANT, set from Flareyard or
 * wrangler), so this page shows it and says where to change it. What each helper sends is stated from the
 * backend's own prompts (src/domain/assistant.ts), not described from the design.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Gated } from "../auth/NoPermission.tsx"
import { useMe } from "../auth/session.ts"
import { num } from "../lib/format.ts"
import { BuiltPill } from "../ops/kit.tsx"
import { toast } from "../ops/toast.tsx"
import { PanelError, PanelSkeleton } from "../ui/Panel.tsx"
import { ApiRefusal } from "./mailboxes/CreateMailbox.tsx"
import { SaveBar, SectionHead } from "./ui.tsx"

type Assistant = Awaited<ReturnType<typeof getAssistant>>
type Toggle = "summaries" | "drafts" | "categories" | "segments"
type Form = Record<Toggle, boolean> & { cap: string }

const getAssistant = () => unwrap(api.GET("/v1/settings/assistant"))
export const assistantQuery = { queryKey: ["settings", "assistant"] as const, queryFn: getAssistant }

const FEATURES: {
  id: Toggle
  usage: "summary" | "draft" | "category" | "segment"
  name: string
  sends: string
}[] = [
  {
    id: "summaries",
    usage: "summary",
    name: "Thread summaries",
    sends:
      "The last 12 messages of the thread you ask about: sender, date, subject and up to 1,500 characters of each body.",
  },
  {
    id: "drafts",
    usage: "draft",
    name: "Reply drafts",
    sends:
      "The same thread when you ask for a draft. The draft is saved for you to edit; it is never sent on its own.",
  },
  {
    id: "categories",
    usage: "category",
    name: "Inbox categories",
    sends:
      "For each new inbound message: sender, subject, whether it has List-Unsubscribe, and up to 1,500 characters of the body.",
  },
  {
    id: "segments",
    usage: "segment",
    name: "Segments from a sentence",
    sends:
      "The sentence you type, with the names and types of your custom fields and topics. No contacts are sent.",
  },
]

const PROVIDER: Record<Assistant["provider"], { name: string; where: string }> = {
  off: { name: "Off", where: "No model is configured, so every helper stays off." },
  "workers-ai": { name: "Workers AI", where: "On your Cloudflare account: mail doesn't leave Cloudflare." },
  openai: {
    name: "An OpenAI-compatible endpoint",
    where: "Your own endpoint and key: what each helper sends goes to that provider.",
  },
  fixed: { name: "Fixed answers (testing)", where: "Canned answers for tests: nothing leaves Mailyard." },
}

const formOf = (a: Assistant): Form => ({
  summaries: a.summaries,
  drafts: a.drafts,
  categories: a.categories,
  segments: a.segments,
  cap: String(num(a.dailyCallsPerMailbox) ?? 200),
})

const capProblem = (cap: string) => {
  const n = Number(cap)
  return /^\d+$/.test(cap.trim()) && n >= 0 && n <= 100_000 ? null : "A whole number from 0 to 100,000."
}

export function AiPage() {
  const q = useQuery(assistantQuery)
  return (
    <>
      <SectionHead title="AI" sub="Optional helpers, and exactly what each one sends where." />
      {q.isPending ? (
        <div className="panel">
          <div className="panel-body">
            <PanelSkeleton rows={4} />
          </div>
        </div>
      ) : q.isError ? (
        <div className="panel is-error">
          <div className="panel-body">
            <PanelError error={q.error} onRetry={() => q.refetch()} what="AI settings didn’t load" />
          </div>
        </div>
      ) : (
        <AiForm a={q.data} />
      )}
    </>
  )
}

function AiForm({ a }: { a: Assistant }) {
  const me = useMe()
  const qc = useQueryClient()
  const canWrite = Boolean(me.data?.permissions.includes("settings.write"))
  const initial = useMemo(() => formOf(a), [a])
  const [form, setForm] = useState<Form>(initial)
  useEffect(() => setForm(initial), [initial])
  const dirty = (Object.keys(initial) as (keyof Form)[]).some((k) => form[k] !== initial[k])
  const problem = capProblem(form.cap)
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        api.PUT("/v1/settings/assistant", {
          body: {
            summaries: form.summaries,
            drafts: form.drafts,
            categories: form.categories,
            segments: form.segments,
            dailyCallsPerMailbox: Number(form.cap),
          },
        }),
      ),
    onSuccess: (r) => {
      qc.setQueryData(assistantQuery.queryKey, r)
      toast({ title: "AI settings saved" })
    },
  })
  const provider = PROVIDER[a.provider]
  const used = (f: (typeof FEATURES)[number]["usage"]) => a.today.byFeature.find((u) => u.feature === f)
  const cap = num(a.dailyCallsPerMailbox) ?? 0
  const who = "Owners and admins, or a key with the admin scope, can."
  return (
    <>
      <section
        className="panel"
        data-endpoint="GET /v1/settings/assistant (built, HAL-3305)"
        data-od-id="panel-ai-provider"
        aria-labelledby="h-ai-provider"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-ai-provider">
            Provider
            <BuiltPill issue="HAL-3305" />
          </h2>
          <span className={`pill ${a.available ? "pill-pass" : "pill-neutral"}`}>
            <span className="dot" />
            {a.available ? "Ready" : "Not configured"}
          </span>
        </header>
        <div className="panel-body stack stack-8">
          <p>
            <b>{provider.name}</b>
            {a.model ? (
              <>
                {" "}
                · <span className="mono">{a.model}</span>
              </>
            ) : null}
          </p>
          <p className="hint">{provider.where}</p>
          <p className="hint">
            The provider is a deploy setting: change it on this app’s page in Flareyard (Settings → “Model for
            summaries, reply drafts, categories and segments”), or with{" "}
            <span className="mono">MAILYARD_ASSISTANT</span> when you deploy it yourself.
          </p>
        </div>
      </section>
      <section
        className="panel"
        data-endpoint="PUT /v1/settings/assistant (built, HAL-3305)"
        data-od-id="panel-ai-features"
        aria-labelledby="h-ai-features"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-ai-features">
            Helpers
          </h2>
          <span className="t-small muted">Today ({a.today.day}, UTC)</span>
        </header>
        <div className="panel-body">
          <div>
            {FEATURES.map((ft) => {
              const u = used(ft.usage)
              const calls = num(u?.calls) ?? 0
              return (
                <div key={ft.id} className="toggle-row">
                  <span className="tr-title">{ft.name}</span>
                  <label className="switch">
                    <Gated allowed={canWrite} reason={`You can’t change ${ft.name.toLowerCase()}`} who={who}>
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={form[ft.id]}
                        aria-label={ft.name}
                        checked={form[ft.id]}
                        onChange={(e) => setForm({ ...form, [ft.id]: e.target.checked })}
                      />
                    </Gated>
                  </label>
                  <span className="tr-sub">
                    <b style={{ color: "var(--my-fg)", fontWeight: 600 }}>Sends:</b> {ft.sends}{" "}
                    {calls > 0
                      ? `${calls.toLocaleString()} call${calls === 1 ? "" : "s"} today, ${(
                          (num(u?.inputTokens) ?? 0) + (num(u?.outputTokens) ?? 0)
                        ).toLocaleString()} tokens.`
                      : "No calls today."}
                  </span>
                </div>
              )
            })}
          </div>
          <div className="field" style={{ marginTop: 14, maxWidth: 320 }}>
            <label className="label" htmlFor="ai-cap">
              Calls per mailbox per helper, each day
            </label>
            <Gated allowed={canWrite} reason="You can’t change the daily limit" who={who}>
              <input
                className="input mono"
                id="ai-cap"
                inputMode="numeric"
                value={form.cap}
                aria-invalid={problem ? true : undefined}
                aria-describedby="ai-cap-help"
                onChange={(e) => setForm({ ...form, cap: e.target.value })}
              />
            </Gated>
            <span className="hint" id="ai-cap-help">
              {problem ??
                `Segments count against the workspace instead. Now ${cap.toLocaleString()} a day; 0 stops every call.`}
            </span>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Every helper is off until turned on here, and only runs when a provider is configured. A model
            only suggests: a summary beside the thread, a draft for you to edit, a label, a rule tree the
            segment code checks. It never sends mail.
          </p>
        </div>
      </section>
      {save.isError ? <ApiRefusal error={save.error} /> : null}
      <SaveBar
        line={dirty ? "Unsaved changes to AI settings" : "Saved"}
        {...(dirty ? {} : { tone: "muted" as const })}
      >
        {dirty ? (
          <button className="btn btn-secondary" type="button" onClick={() => setForm(initial)}>
            Discard
          </button>
        ) : null}
        <Gated allowed={canWrite} reason="You can’t change AI settings" who={who}>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!dirty || Boolean(problem) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </Gated>
      </SaveBar>
    </>
  )
}
