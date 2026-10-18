/**
 * The preview frame (design: `.preview-stage > .device(.is-phone|.is-dark-email) > .device-bar + iframe`): the
 * rendered email in a sandboxed iframe with no scripts, remote images held back until allowed.
 */
import { useState } from "react"
import { Icon } from "../../ui/icons.tsx"
import { previewDoc } from "../logic.ts"

export type Device = "desktop" | "phone" | "dark"
/** The frames a page can draw; the toggle offers the first three, the phone page also draws a dark phone. */
export type Frame = Device | "phone-dark"

export function DeviceFrame({
  html,
  subject,
  from,
  device = "desktop",
  title,
  height = 460,
}: {
  html: string
  subject: string
  from: string
  device?: Frame
  title: string
  height?: number
}) {
  const [images, setImages] = useState(false)
  const remote = /<img\b[^>]*src=["']https?:/i.test(html)
  return (
    <div className="stack stack-8">
      <div className="preview-stage">
        <div
          className={`device${device.startsWith("phone") ? " is-phone" : ""}${device.endsWith("dark") ? " is-dark-email" : ""}`}
        >
          <div className="device-bar">
            <b>{subject}</b>
            <span>{from}</span>
          </div>
          <iframe
            title={title}
            sandbox=""
            tabIndex={-1}
            srcDoc={previewDoc(html, { dark: device.endsWith("dark"), allowImages: images })}
            style={{ height }}
          />
        </div>
      </div>
      {remote ? (
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          aria-pressed={images}
          onClick={() => setImages((v) => !v)}
        >
          <Icon name="eye" />
          {images ? "Hide remote images" : "Show remote images"}
        </button>
      ) : null}
    </div>
  )
}

export function DeviceToggle({ value, onChange }: { value: Device; onChange: (d: Device) => void }) {
  const opts: { key: Device; label: string }[] = [
    { key: "desktop", label: "Desktop" },
    { key: "phone", label: "Phone" },
    { key: "dark", label: "Dark mode" },
  ]
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design's segmented control; a fieldset would need a legend it doesn't show
    <div className="seg" role="group" aria-label="Preview as">
      {opts.map((o) => (
        <button key={o.key} type="button" aria-pressed={value === o.key} onClick={() => onChange(o.key)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}
