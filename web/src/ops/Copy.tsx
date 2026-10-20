/**
 * Copy buttons and once-only secrets (design: `.copy-chip`, `.secret > .secret-value > code + .copy-chip`,
 * `.secret-note`, `.masked`). A secret is shown once, at creation or rotation; after that only its prefix.
 */
import { type ReactNode, useState } from "react"
import { Icon } from "../ui/icons.tsx"

export function CopyChip({ value, label = "Copy", what }: { value: string; label?: string; what?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="copy-chip"
      type="button"
      aria-label={what ? `Copy ${what}` : undefined}
      onClick={async () => {
        try {
          await navigator.clipboard?.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {
          setDone(false)
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} />
      <span className="copy-label">{done ? "Copied" : label}</span>
    </button>
  )
}

export function Secret({
  value,
  label = "Your new secret key",
  note,
  what = "key",
}: {
  value: string
  label?: ReactNode
  note?: ReactNode
  what?: string
}) {
  return (
    <div className="secret" data-od-id="secret-once">
      <span className="label">{label}</span>
      <div className="secret-value">
        <code>{value}</code>
        <CopyChip value={value} what={what} />
      </div>
      <p className="secret-note">
        <Icon name="warn" />
        <span>
          {note ?? (
            <>
              <b>This is the only time you’ll see it.</b> Mailyard keeps a hash, not the {what}. Put it in
              your app’s secrets now; if you lose it, revoke it and create another.
            </>
          )}
        </span>
      </p>
    </div>
  )
}

/** A code block with a title and Copy (design: `.code > .code-head + pre > code`). */
export function CodeBlock({ title, code, wrap }: { title?: ReactNode; code: string; wrap?: boolean }) {
  return (
    <div className="code" data-wrap={wrap ? "" : undefined}>
      <div className="code-head">
        <span className="code-title">{title}</span>
        <CopyChip value={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** Tabbed snippets (design: `.code[data-code-tabs]`). */
export function CodeTabs({
  tabs,
  label,
}: {
  tabs: { id: string; label: string; code: string }[]
  label: string
}) {
  const [on, setOn] = useState(tabs[0]?.id ?? "")
  const cur = tabs.find((t) => t.id === on) ?? tabs[0]
  if (!cur) return null
  return (
    <div className="code" data-code-tabs="">
      <div className="code-head">
        <div className="code-tabs" role="tablist" aria-label={label}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={t.id === cur.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={t.id === cur.id ? 0 : -1}
              onClick={() => setOn(t.id)}
              onKeyDown={(e) => {
                const i = tabs.findIndex((x) => x.id === cur.id)
                const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
                if (!d) return
                e.preventDefault()
                const next = tabs[(i + d + tabs.length) % tabs.length]
                if (next) {
                  setOn(next.id)
                  document.getElementById(`tab-${next.id}`)?.focus()
                }
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CopyChip value={cur.code} />
      </div>
      <div role="tabpanel" id={`panel-${cur.id}`} aria-labelledby={`tab-${cur.id}`}>
        <pre>
          <code>{cur.code}</code>
        </pre>
      </div>
    </div>
  )
}
