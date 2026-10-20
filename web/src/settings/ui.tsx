/** Pieces the Settings pages share: the section head above each page's panels, and the sticky save bar. */
import type { ReactNode } from "react"

export function SectionHead({
  title,
  sub,
  actions,
}: {
  title: ReactNode
  sub?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="spread" style={{ alignItems: "flex-end" }}>
      <div style={{ minWidth: 0 }}>
        <h2 className="t-h2">{title}</h2>
        {sub ? (
          <p className="muted" style={{ marginTop: 4 }}>
            {sub}
          </p>
        ) : null}
      </div>
      <div className="cluster">{actions}</div>
    </div>
  )
}

/** One per page, sticky; it says what's unsaved, or why it can't save. */
export function SaveBar({
  line,
  tone,
  children,
}: {
  line: ReactNode
  tone?: "error" | "muted"
  children: ReactNode
}) {
  return (
    <div className="save-bar" data-od-id="save-bar">
      <span
        className={`t-small${tone === "error" ? "" : " muted"}`}
        style={tone === "error" ? { color: "var(--red-900)" } : undefined}
        role="status"
      >
        {line}
      </span>
      <span className="cluster">{children}</span>
    </div>
  )
}

/** A page's error, the API's message in words with the request id (the designed `.error-block`). */
export function Initials({ name }: { name: string }) {
  const s = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("")
  return (
    <span className="avatar" aria-hidden="true">
      {s || "?"}
    </span>
  )
}
