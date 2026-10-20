/**
 * Settings → AI (design: ai.html; GAPS-ops 4.9). `GET/PUT /v1/settings/ai` is Planned · HAL-3305 and absent
 * from the live OpenAPI, so the page states the plan: the two provider choices and exactly what each feature
 * would send, with every control off and saying why. Nothing here claims a provider is in use.
 */
import { NeedsRoute, PlannedPill } from "../ops/kit.tsx"
import { SaveBar, SectionHead } from "./ui.tsx"

const FEATURES: { id: string; name: string; sends: string }[] = [
  {
    id: "spam",
    name: "Spam classifier",
    sends: "Subject, sender, the first 2 KB of the body and authentication results of inbound mail",
  },
  { id: "summary", name: "Thread summaries", sends: "The messages in a thread when you open its summary" },
  {
    id: "reply",
    name: "Suggested replies",
    sends: "The thread and your signature, when you ask for a suggestion",
  },
  {
    id: "triage",
    name: "Shared-inbox triage (assign and label)",
    sends: "Subject, sender and the first 2 KB of new mail to shared mailboxes",
  },
  {
    id: "subject",
    name: "Campaign subject ideas",
    sends: "The campaign body you’re writing, when you ask for ideas",
  },
]

const gate = (control: Parameters<typeof NeedsRoute>[0]["children"]) => (
  <NeedsRoute method="PUT" path="/v1/settings/ai" issue="HAL-3305" what="AI settings">
    {control}
  </NeedsRoute>
)

export function AiPage() {
  return (
    <>
      <SectionHead title="AI" sub="Optional help, and exactly what each feature sends where." />
      <section
        className="panel"
        data-endpoint="GET/PUT /v1/settings/ai (planned, HAL-3305)"
        data-od-id="panel-ai-provider"
        aria-labelledby="h-ai-provider"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-ai-provider">
            Provider
            <PlannedPill issue="HAL-3305" />
          </h2>
          <div className="cluster" />
        </header>
        <div className="panel-body">
          <div className="stack stack-12">
            <div className="choice">
              {gate(
                <input
                  className="check"
                  type="radio"
                  name="prov"
                  style={{ appearance: "auto", width: 24, height: 24, margin: 0 }}
                  aria-label="Workers AI"
                />,
              )}
              <span>
                <b>Workers AI</b> on your Cloudflare account
              </span>
              <span />
              <span className="c-sub">Mail never leaves Cloudflare. Billed by Cloudflare as neurons.</span>
            </div>
            <div className="choice">
              {gate(
                <input
                  className="check"
                  type="radio"
                  name="prov"
                  style={{ appearance: "auto", width: 24, height: 24, margin: 0 }}
                  aria-label="Any OpenAI-compatible endpoint"
                />,
              )}
              <span>
                <b>Any OpenAI-compatible endpoint</b>
              </span>
              <span />
              <span className="c-sub">
                Your own key and model. The data each feature sends goes to that provider.
              </span>
            </div>
            <div className="field-row">
              <div className="field">
                <label className="label" htmlFor="ai-url">
                  Base URL
                </label>
                <input className="input mono" id="ai-url" placeholder="https://api.example.com/v1" disabled />
              </div>
              <div className="field">
                <label className="label" htmlFor="ai-model">
                  Model
                </label>
                <input className="input mono" id="ai-model" placeholder="model name" disabled />
              </div>
            </div>
          </div>
        </div>
      </section>
      <section
        className="panel"
        data-endpoint="GET/PUT /v1/settings/ai (planned, HAL-3305)"
        data-od-id="panel-ai-features"
        aria-labelledby="h-ai-features"
      >
        <header className="panel-head">
          <h2 className="panel-title" id="h-ai-features">
            Features
            <PlannedPill issue="HAL-3305" />
          </h2>
          <div className="cluster" />
        </header>
        <div className="panel-body">
          <div>
            {FEATURES.map((ft) => (
              <div key={ft.id} className="toggle-row">
                <span className="tr-title">{ft.name}</span>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: the input is inside, wrapped by gate() for its disabled reason */}
                <label className="switch">{gate(<input type="checkbox" aria-label={ft.name} />)}</label>
                <span className="tr-sub">
                  <b style={{ color: "var(--my-fg)", fontWeight: 600 }}>Would send:</b> {ft.sends}
                </span>
              </div>
            ))}
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            Nothing is used to train a model. Each feature will run only when the table says, and every run
            goes in the audit log. None runs today: AI arrives with HAL-3305.
          </p>
        </div>
      </section>
      <SaveBar line="AI settings arrive with HAL-3305">
        {gate(
          <button className="btn btn-primary" type="button">
            Save
          </button>,
        )}
      </SaveBar>
    </>
  )
}
