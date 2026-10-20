/**
 * Attachments (`.uploads > .up-row`, compose-attachments): each file uploads to Mailyard as it's added, with
 * real progress; files past the 5 MiB message budget can only go as a link (`delivery: "link"`), and files
 * over the per-file limit are refused before uploading. The `.budget` meter shows what's inline.
 */

import { Icon } from "../../ui/icons.tsx"
import { fileSize } from "../logic.ts"
import { BUDGET, budgetPlan, canInline, type UploadRow } from "./logic.ts"

export function Uploads({
  rows,
  onRemove,
  onDelivery,
  onRetry,
}: {
  rows: readonly UploadRow[]
  onRemove: (id: string) => void
  onDelivery: (id: string, d: "inline" | "link") => void
  onRetry: (id: string) => void
}) {
  if (!rows.length) return null
  const plan = budgetPlan(rows)
  return (
    <div
      className="uploads"
      data-endpoint="POST /v1/mailboxes/{id}/uploads?filename= → { key } → draft attachments[].key"
    >
      {rows.map((r) => {
        const forcedLink = r.status !== "too-big" && (!canInline(r.size) || plan.forced.has(r.id))
        const delivery = forcedLink ? "link" : r.delivery
        return (
          <div className="up-row" key={r.id}>
            {r.status === "uploading" ? (
              <span className="spinner" role="img" aria-label="Uploading" />
            ) : r.status === "failed" || r.status === "too-big" ? (
              <Icon name="warn" label="Not attached" />
            ) : (
              <Icon name="paperclip" />
            )}
            <span className="up-name" title={r.filename}>
              {r.filename}
            </span>
            <span className="up-size">{fileSize(r.size)}</span>
            <button
              className="icon-btn"
              type="button"
              aria-label={`Remove ${r.filename}`}
              title={`Remove ${r.filename}`}
              onClick={() => onRemove(r.id)}
            >
              <Icon name="x" />
            </button>
            {r.status === "uploading" ? (
              <>
                <div
                  className="progress"
                  role="progressbar"
                  aria-valuenow={Math.round(r.progress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`Uploading ${r.filename}`}
                >
                  <span style={{ width: `${Math.round(r.progress * 100)}%` }} />
                </div>
                <span className="up-note">{Math.round(r.progress * 100)}% · uploading to Mailyard</span>
              </>
            ) : null}
            {r.status === "too-big" || r.status === "failed" ? (
              <span className="up-note is-error">
                {r.error}
                {r.status === "failed" ? (
                  <>
                    {" "}
                    <button className="link" type="button" onClick={() => onRetry(r.id)}>
                      Try again
                    </button>
                  </>
                ) : null}
              </span>
            ) : null}
            {r.status === "done" && r.carried ? (
              <span className="up-note">From the original message</span>
            ) : null}
            {r.status === "done" && forcedLink ? (
              <span className="up-note">
                {canInline(r.size)
                  ? `Doesn’t fit next to the other files in the ${fileSize(BUDGET)} message budget, so it goes as a download link.`
                  : `Past the ${fileSize(BUDGET)} message budget, so it goes as a download link (delivery: link).`}
              </span>
            ) : null}
            {r.status === "done" ? (
              <span className="up-deliv">
                {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control */}
                <span
                  className="seg"
                  role="group"
                  aria-label={`Send ${r.filename} as`}
                  data-endpoint="draft attachments[].delivery"
                >
                  <button
                    type="button"
                    aria-pressed={delivery === "inline"}
                    {...(forcedLink ? { "aria-disabled": true, title: "Over the 5 MiB message budget" } : {})}
                    onClick={() => !forcedLink && onDelivery(r.id, "inline")}
                  >
                    Inline
                  </button>
                  <button
                    type="button"
                    aria-pressed={delivery === "link"}
                    onClick={() => onDelivery(r.id, "link")}
                  >
                    Link
                  </button>
                </span>
              </span>
            ) : null}
          </div>
        )
      })}
      <div className="budget">
        <div className="budget-line">
          <span>
            Attached <b>{fileSize(plan.inlineBytes)}</b> of the {fileSize(BUDGET)} message budget
          </span>
          <span>
            {plan.links
              ? `${plan.links} ${plan.links === 1 ? "file" : "files"} sent as a link`
              : "All inline"}
          </span>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's .meter bar */}
        <div
          className={`meter${plan.tone === "warn" ? " is-warn" : ""}`}
          role="meter"
          aria-valuemin={0}
          aria-valuemax={BUDGET}
          aria-valuenow={plan.inlineBytes}
          aria-label="Message size budget"
        >
          <span style={{ width: `${Math.round(plan.share * 100)}%` }} />
        </div>
      </div>
    </div>
  )
}
