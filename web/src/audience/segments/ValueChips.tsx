/**
 * The value-chip input (`.vchips > .vchip + input.vchip-input`) for `in` lists and status or engagement
 * choices. Enter, comma or Tab adds what's typed; Backspace in an empty box removes the last chip. With
 * `choices`, only those values are accepted and the box suggests them.
 */
import { type KeyboardEvent, useId, useState } from "react"
import { Icon } from "../../ui/icons.tsx"
import { addValue, type FieldTypeName, LIMITS, type Scalar } from "./logic.ts"

export function ValueChips({
  values,
  onChange,
  label,
  choices,
  fieldType,
  placeholder = "Add a value",
  invalid,
  describedBy,
  disabled,
}: {
  values: readonly Scalar[]
  onChange: (v: Scalar[]) => void
  label: string
  choices?: readonly string[]
  fieldType?: FieldTypeName
  placeholder?: string
  invalid?: boolean
  describedBy?: string | undefined
  disabled?: boolean
}) {
  const [draft, setDraft] = useState("")
  const listId = useId()
  const commit = () => {
    const raw = draft.trim()
    if (!raw) return false
    if (choices) {
      const picked = raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => choices.includes(s))
      if (!picked.length) return false
      onChange(addValue(values, picked.join(","), fieldType))
    } else onChange(addValue(values, raw, fieldType))
    setDraft("")
    return true
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault()
      commit()
    } else if (e.key === "Tab" && draft.trim()) {
      if (commit()) e.preventDefault()
    } else if (e.key === "Backspace" && draft === "" && values.length) {
      onChange(values.slice(0, -1))
    }
  }
  const remaining = choices?.filter((c) => !values.includes(c))
  const full = values.length >= LIMITS.inValues
  return (
    // biome-ignore lint/a11y/useSemanticElements: the design's chip box is a labelled group, not a fieldset
    <span className="vchips" role="group" aria-label={label}>
      {values.map((v) => (
        <span key={String(v)} className="vchip">
          {String(v)}
          {disabled ? null : (
            <button
              type="button"
              aria-label={`Remove ${String(v)}`}
              onClick={() => onChange(values.filter((x) => x !== v))}
            >
              <Icon name="x" />
            </button>
          )}
        </span>
      ))}
      {disabled ? null : (
        <input
          className="vchip-input"
          value={draft}
          placeholder={
            full ? "50 values at most" : remaining && !remaining.length ? "All picked" : placeholder
          }
          aria-label={placeholder}
          disabled={full || (remaining !== undefined && !remaining.length)}
          list={choices ? listId : undefined}
          onChange={(e) => {
            const v = e.target.value
            // Picking a suggestion from the list adds it straight away.
            if (choices?.includes(v.trim().toLowerCase())) {
              onChange(addValue(values, v.trim().toLowerCase(), fieldType))
              setDraft("")
            } else setDraft(v)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit()}
          {...(invalid ? { "aria-invalid": true } : {})}
          {...(describedBy ? { "aria-describedby": describedBy } : {})}
        />
      )}
      {choices ? (
        <datalist id={listId}>
          {remaining?.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      ) : null}
    </span>
  )
}
