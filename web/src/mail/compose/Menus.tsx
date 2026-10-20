/**
 * The composer's pickers (`.menu.mail-menu`, bottom sheets on phone): From (`#from-menu`, GET /v1/identities)
 * and Schedule send (`#schedule-menu`: presets, a UTC date and time, and the undo window).
 */
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react"
import { dateInput, timeInput, utcFromInputs, utcStamp } from "../logic.ts"
import type { Identity, Mailbox } from "../types.ts"
import { defaultCustom, identityRelation, schedulePresets, signatureSource } from "./logic.ts"

/** Closes on a click outside or Escape; focus goes back to the trigger. */
export function useMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.stopPropagation()
      setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    window.addEventListener("keydown", onEsc, true)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      window.removeEventListener("keydown", onEsc, true)
    }
  }, [open])
  return { open, setOpen, ref }
}

export function Menu({
  id,
  label,
  style,
  children,
}: {
  id: string
  label: string
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <div className="menu mail-menu" id={id} role="menu" aria-label={label} style={style}>
      {children}
    </div>
  )
}

export function FromMenu({
  id,
  identities,
  anyAddressOn,
  mailboxes,
  value,
  onPick,
}: {
  id: string
  identities: readonly Identity[]
  anyAddressOn: readonly string[]
  mailboxes: readonly Mailbox[] | undefined
  value: string
  onPick: (address: string) => void
}) {
  return (
    <Menu id={id} label="Send as" style={{ left: 60, top: "calc(100% + 4px)", width: 340 }}>
      <div className="menu-label">Send as · identities you may use</div>
      {identities.map((i) => (
        <button
          key={i.address}
          className="menu-item"
          type="button"
          role="menuitemradio"
          aria-checked={i.address === value}
          style={{ minHeight: 48 }}
          onClick={() => onPick(i.address)}
        >
          <span className="grow">
            <span>{i.displayName || i.address}</span>
            <span className="ws-host" style={{ display: "block" }}>
              {i.address} · {identityRelation(i, identities, mailboxes)} ·{" "}
              {signatureSource(i, identities, mailboxes).words}
            </span>
          </span>
        </button>
      ))}
      {anyAddressOn.length ? <OtherAddress domains={anyAddressOn} onPick={onPick} /> : null}
    </Menu>
  )
}

export function ScheduleMenu({
  id,
  undoSeconds,
  onUndoSeconds,
  onSchedule,
  queueAt,
  now = Date.now(),
}: {
  id: string
  undoSeconds: 0 | 10
  onUndoSeconds: (v: 0 | 10) => void
  onSchedule: (at: number) => void
  /** Offered first when the quota is used: send at the reset. */
  queueAt?: number
  now?: number
}) {
  const initial = defaultCustom(now)
  const [date, setDate] = useState(dateInput(initial))
  const [time, setTime] = useState(timeInput(initial))
  const custom = utcFromInputs(date, time)
  const past = custom !== null && custom <= now
  return (
    <Menu id={id} label="Schedule send" style={{ left: 12, bottom: "calc(100% + 6px)" }}>
      <div className="menu-label">Schedule send</div>
      {queueAt ? (
        <button className="menu-item" type="button" role="menuitem" onClick={() => onSchedule(queueAt)}>
          <span className="grow">At the quota reset</span>
          <span className="when">{utcStamp(queueAt)}</span>
        </button>
      ) : null}
      {schedulePresets(now).map((p) => (
        <button
          key={p.label}
          className="menu-item"
          type="button"
          role="menuitem"
          onClick={() => onSchedule(p.at)}
        >
          <span className="grow">{p.label}</span>
          <span className="when">{utcStamp(p.at)}</span>
        </button>
      ))}
      <div className="menu-sep" />
      <div className="menu-label">Pick a date and time (UTC)</div>
      <div className="menu-form">
        <input
          className="input"
          type="date"
          value={date}
          aria-label="Date"
          onChange={(e) => setDate(e.target.value)}
        />
        <input
          className="input"
          type="time"
          value={time}
          aria-label="Time, UTC"
          onChange={(e) => setTime(e.target.value)}
        />
        <button
          className="btn btn-primary btn-sm"
          type="button"
          disabled={custom === null || past}
          onClick={() => custom !== null && onSchedule(custom)}
        >
          {custom === null
            ? "Pick a date and time"
            : past
              ? "That time has passed"
              : `Schedule for ${utcStamp(custom)}`}
        </button>
      </div>
      <div className="menu-note">It waits in Scheduled and counts against that day’s quota when it goes.</div>
      <div className="menu-sep" />
      <div className="menu-label">Undo window when you press Send</div>
      <div style={{ padding: "2px 10px 10px" }}>
        {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg control */}
        <div className="seg" role="group" aria-label="Undo window">
          <button type="button" aria-pressed={undoSeconds === 10} onClick={() => onUndoSeconds(10)}>
            10 s
          </button>
          <button type="button" aria-pressed={undoSeconds === 0} onClick={() => onUndoSeconds(0)}>
            Off, send at once
          </button>
        </div>
      </div>
    </Menu>
  )
}

/** Owners and admins may send from any address on a sending domain (`anyAddressOn`). */
function OtherAddress({
  domains,
  onPick,
}: {
  domains: readonly string[]
  onPick: (address: string) => void
}) {
  const [local, setLocal] = useState("")
  const [domain, setDomain] = useState(domains[0] ?? "")
  const ok = /^[a-z0-9._+-]+$/i.test(local)
  return (
    <>
      <div className="menu-sep" />
      <div className="menu-note">
        You can also send from any address on{" "}
        {domains.map((d, n) => (
          <span key={d}>
            {n ? ", " : ""}
            <span className="mono">{d}</span>
          </span>
        ))}
        .
      </div>
      <form
        className="menu-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) onPick(`${local}@${domain}`)
        }}
      >
        <input
          className="input"
          aria-label="Address before the @"
          placeholder="name"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
        />
        {domains.length > 1 ? (
          <select
            className="select"
            aria-label="Domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          >
            {domains.map((d) => (
              <option key={d} value={d}>
                @{d}
              </option>
            ))}
          </select>
        ) : (
          <span className="mono t-small" style={{ alignSelf: "center" }}>
            @{domain}
          </span>
        )}
        <button className="btn btn-secondary btn-sm" type="submit" disabled={!ok}>
          {ok ? `Send as ${local}@${domain}` : "Type the part before the @"}
        </button>
      </form>
    </>
  )
}
