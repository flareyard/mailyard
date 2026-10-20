/**
 * A recipient row (To, Cc or Bcc): chips (`.chip`, `.chip.is-invalid` with the reason), an input that turns
 * what you type or paste into chips, and suggestions from the mailbox's correspondents
 * (`GET …/correspondents?q=`, `.menu.suggest`) chosen with ↑ ↓ ↵.
 */
import { useQuery } from "@tanstack/react-query"
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react"
import { num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { initials, rowTime } from "../logic.ts"
import { correspondentsQuery } from "../queries.ts"
import { addRecipients, addressProblem, parseRecipients, type Rcpt } from "./logic.ts"

/** Shows at most this many chips before collapsing the rest into “+ N more” (compose-recipients). */
const SHOWN = 8

export function RecipientRow({
  label,
  kind,
  mailboxId,
  local,
  value,
  onChange,
  marked,
  markedWhy,
  actions,
  autoFocus,
}: {
  label: string
  kind: "to" | "cc" | "bcc"
  mailboxId: string
  local: string
  value: Rcpt[]
  onChange: (next: Rcpt[]) => void
  /** Addresses a refusal named (suppressed, not on the allow-list). */
  marked?: ReadonlySet<string>
  markedWhy?: string
  actions?: ReactNode
  autoFocus?: boolean
}) {
  const [text, setText] = useState("")
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [debounced, setDebounced] = useState("")
  const listId = useId()
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 160)
    return () => clearTimeout(t)
  }, [text])
  const q = useQuery({ ...correspondentsQuery(mailboxId, debounced), enabled: debounced.length >= 1 })
  const taken = new Set(value.map((r) => r.address.toLowerCase()))
  const suggestions = (q.data?.correspondents ?? [])
    .filter((c) => !taken.has(c.address.toLowerCase()))
    .slice(0, 5)
  const showSuggest = open && debounced.length >= 1 && suggestions.length > 0

  const commit = (raw: string) => {
    const parsed = parseRecipients(raw)
    if (parsed.length) onChange(addRecipients(value, parsed))
    setText("")
    setActive(0)
  }
  const pick = (i: number) => {
    const c = suggestions[i]
    if (!c) return
    onChange(addRecipients(value, [{ name: c.name ?? null, address: c.address }]))
    setText("")
    setActive(0)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (showSuggest && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault()
      const n = suggestions.length
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n))
      return
    }
    if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      if (showSuggest && e.key !== "," && e.key !== ";") {
        e.preventDefault()
        pick(active)
        return
      }
      if (text.trim()) {
        e.preventDefault()
        commit(text)
      }
      return
    }
    if (e.key === "Escape" && showSuggest) {
      e.stopPropagation()
      setOpen(false)
      return
    }
    if (e.key === "Backspace" && !text && value.length) onChange(value.slice(0, -1))
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text")
    if (/[,;\n]|\s\S+@/.test(pasted)) {
      e.preventDefault()
      commit(`${text} ${pasted}`)
    }
  }
  const visible = expanded ? value : value.slice(0, SHOWN)
  const hidden = value.length - visible.length

  return (
    <div className="compose-row">
      <span className="lbl" id={`${listId}-lbl`}>
        {label}
      </span>
      <span className="rcpts">
        {visible.map((r) => {
          const problem = addressProblem(r.address)
          const isMarked = marked?.has(r.address.toLowerCase())
          const bad = problem !== null || isMarked
          return (
            <span
              key={r.address}
              className={`chip${bad ? " is-invalid" : ""}`}
              title={
                problem
                  ? `${r.address} isn’t an email address: ${problem}`
                  : isMarked
                    ? `${r.address} · ${markedWhy ?? "refused"}`
                    : undefined
              }
            >
              {r.name && !bad ? (
                <>
                  <span className="chip-name">{r.name}</span> <span className="chip-n">·</span> {r.address}
                </>
              ) : (
                r.address
              )}
              {isMarked && markedWhy ? <span className="chip-n"> · {markedWhy}</span> : null}
              <button
                type="button"
                aria-label={`Remove ${r.address}`}
                onClick={() => onChange(value.filter((x) => x !== r))}
              >
                <Icon name="x" />
              </button>
            </span>
          )
        })}
        {hidden > 0 ? (
          <button
            type="button"
            className="chip is-group"
            onClick={() => setExpanded(true)}
            aria-label={`Show ${hidden} more recipients`}
          >
            + {hidden} more
          </button>
        ) : null}
        <input
          aria-label={`Add ${kind === "to" ? "to" : kind} recipient`}
          aria-labelledby={undefined}
          aria-autocomplete="list"
          aria-expanded={showSuggest}
          aria-controls={showSuggest ? listId : undefined}
          aria-activedescendant={showSuggest ? `${listId}-${active}` : undefined}
          role="combobox"
          value={text}
          // biome-ignore lint/a11y/noAutofocus: the first empty recipient row takes focus when the window opens
          autoFocus={autoFocus}
          onChange={(e) => {
            setText(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            setTimeout(() => setOpen(false), 120)
            if (text.trim()) commit(text)
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </span>
      {actions ? <span className="row-acts">{actions}</span> : null}
      {showSuggest ? (
        <div
          className="menu suggest"
          role="listbox"
          id={listId}
          aria-label="Suggestions"
          data-endpoint="GET /v1/mailboxes/{id}/correspondents?q="
        >
          <div className="menu-label">People {local} has written with</div>
          {suggestions.map((c, i) => (
            <button
              key={c.address}
              id={`${listId}-${i}`}
              className="menu-item"
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(i)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="who" aria-hidden="true">
                {initials(c.name, c.address)}
              </span>
              <span className="s-meta">
                <span className="s-name">{c.name || c.address}</span>
                <span className="s-addr">{c.name ? c.address : "no name on record"}</span>
              </span>
              <span className="s-src" title="Messages received from and sent to them, and the last contact">
                {num(c.received) ?? 0} in · {num(c.sent) ?? 0} out · {rowTime(c.lastAt)}
              </span>
            </button>
          ))}
          <div className="menu-note">
            <span className="kbd-group">
              <span className="kbd">↑</span>
              <span className="kbd">↓</span>
            </span>{" "}
            choose · <span className="kbd">↵</span> add · paste a list to add many
          </div>
        </div>
      ) : null}
    </div>
  )
}
