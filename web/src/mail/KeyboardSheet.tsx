/** The ? sheet (keyboard.html): every Mail shortcut, the same list the tooltips name. */
import { useEffect, useRef } from "react"
import { Icon } from "../ui/icons.tsx"
import { SHORTCUTS } from "./logic.ts"

function Keys({ keys }: { keys: string }) {
  return (
    <span className="kbd-group">
      {keys
        .split(/\s+/)
        .filter((k) => k !== "·")
        .map((k, i) =>
          k === "then" ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional key caps
            <span key={i} className="t-small muted" style={{ padding: "0 2px" }}>
              then
            </span>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional key caps
            <span key={i} className="kbd">
              {k}
            </span>
          ),
        )}
    </span>
  )
}

export function KeyboardSheet({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    close.current?.focus()
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", esc, true)
    return () => window.removeEventListener("keydown", esc, true)
  }, [onClose])
  const half = Math.ceil(SHORTCUTS.length / 2)
  const cols = [SHORTCUTS.slice(0, half), SHORTCUTS.slice(half)]
  return (
    <div className="sheet-wrap" role="dialog" aria-modal="true" aria-labelledby="mk-title">
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet sheet-wide" style={{ position: "relative", zIndex: 1 }}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <div>
            <h2 className="t-h2" id="mk-title">
              Mail shortcuts
            </h2>
            <p className="hint" style={{ marginTop: 4 }}>
              Single keys work anywhere in a mailbox except while you type. S snoozes and A assigns, so Star
              is ⇧ S and Reply all is ⇧ R.
            </p>
          </div>
          <button
            ref={close}
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close · esc"
          >
            <Icon name="x" />
          </button>
        </div>
        <div className="sheet-body">
          <div className="grid-12 mail-keys-grid">
            {cols.map((col, ci) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two fixed columns
              <div key={ci} className="span-6">
                <table className="table">
                  <tbody>
                    {col.map((s) => (
                      <tr key={s.keys + s.label}>
                        <td>{s.label}</td>
                        <td className="r">
                          <Keys keys={s.keys} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
