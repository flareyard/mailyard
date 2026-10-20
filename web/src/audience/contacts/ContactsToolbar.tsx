/**
 * The contacts toolbar (design: contacts.html, contacts-status-menu, contacts-columns): search, one chip per
 * filter value (status and engagement chips open a multi-select that writes one comma list), Add filter, the
 * columns menu (saved in the URL as `cols=`) and Export view.
 */
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { Gated } from "../../auth/NoPermission.tsx"
import { fmtInt } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { usePopover } from "../kit/popover.ts"
import { type ContactField, fieldLabel } from "../kit/queries.ts"
import {
  BUILTIN_COLUMNS,
  type Chip,
  COLUMN_LABEL,
  type ContactsSearch,
  colsParam,
  DEFAULT_COLUMNS,
  ENGAGEMENTS,
  moveColumn,
  type SearchPatch,
  STATUSES,
  splitList,
  toggleColumn,
  withList,
  withoutChip,
} from "./logic.ts"
import { statusCountQuery } from "./queries.ts"

type Go = (next: SearchPatch, replace?: boolean) => void

export function ContactsToolbar({
  search,
  go,
  chips,
  invalid,
  columns,
  fields,
  canExport,
  exportWho,
}: {
  search: ContactsSearch
  go: Go
  chips: Chip[]
  invalid: Set<string>
  columns: string[]
  fields: ContactField[]
  canExport: boolean
  exportWho: string
}) {
  return (
    <div className="toolbar" data-od-id="contacts-toolbar">
      <SearchBox
        value={search.q ?? ""}
        onChange={(q) => go({ ...search, q: q || undefined, cursor: undefined }, true)}
      />
      <div className="fchips">
        {chips.map((c) =>
          c.multi ? (
            <MultiChip
              key={c.key}
              chip={c}
              kind={c.key as "status" | "engagement"}
              selected={splitList(search[c.key as "status" | "engagement"])}
              onSet={(vals) => go(withList(search, c.key as "status" | "engagement", vals))}
              onRemove={() => go(withoutChip(search, c))}
            />
          ) : (
            <span
              key={`${c.key}:${c.value}`}
              className={`fchip${invalid.has(`${c.key}:${c.value}`) ? " is-invalid" : ""}`}
              data-od-id={`filter-${c.key}`}
              title={c.invalid ?? c.param}
            >
              <span className="fk">{c.label}</span>
              {c.text ? <b>{c.text}</b> : null}
              <button
                type="button"
                aria-label={`Remove filter ${c.label} ${c.text}`.trim()}
                onClick={() => go(withoutChip(search, c))}
              >
                <Icon name="x" />
              </button>
            </span>
          ),
        )}
        <button
          className="fchip-add"
          type="button"
          data-od-id="add-filter"
          onClick={() => go({ ...search, sheet: "filter" }, true)}
        >
          <Icon name="plus" />
          Add filter
        </button>
      </div>
      <div className="tb-right">
        <ColumnsMenu
          columns={columns}
          fields={fields}
          onChange={(next) => go({ ...search, cols: colsParam(next) }, true)}
        />
        <Gated allowed={canExport} reason="You can’t export contacts" who={exportWho} side="right">
          <button
            className="btn btn-secondary btn-sm"
            type="button"
            data-od-id="export-view"
            data-endpoint="POST /v1/exports"
            onClick={() => go({ ...search, sheet: "export" }, true)}
          >
            <Icon name="download" />
            Export view
          </button>
        </Gated>
      </div>
    </div>
  )
}

/** Search writes `q` to the URL a beat after typing stops; `/` focuses it. */
function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [text, setText] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) {
      last.current = value
      setText(value)
    }
  }, [value])
  useEffect(() => {
    if (text === last.current) return
    const t = setTimeout(() => {
      last.current = text.trim()
      onChange(text.trim())
    }, 300)
    return () => clearTimeout(t)
  }, [text, onChange])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        ref.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  return (
    <label className="search">
      <span className="sr-only">Search contacts</span>
      <Icon name="search" />
      <input
        ref={ref}
        className="input"
        type="search"
        value={text}
        placeholder="Search by email or name"
        data-od-id="contacts-search"
        onChange={(e) => setText(e.target.value)}
      />
    </label>
  )
}

const WORD = (v: string) => v.replace(/^./, (c) => c.toUpperCase())

function MultiChip({
  chip,
  kind,
  selected,
  onSet,
  onRemove,
}: {
  chip: Chip
  kind: "status" | "engagement"
  selected: string[]
  onSet: (vals: string[]) => void
  onRemove: () => void
}) {
  const pop = usePopover<HTMLSpanElement>()
  const id = useId()
  const options = kind === "status" ? STATUSES : ENGAGEMENTS
  return (
    <span className="fchip-anchor" ref={pop.anchor}>
      <span className="fchip is-multi" data-od-id={`filter-${kind}`} title={chip.param}>
        <button
          ref={pop.trigger}
          className="fchip-open"
          type="button"
          aria-haspopup="menu"
          aria-expanded={pop.open}
          aria-controls={id}
          onClick={pop.toggle}
        >
          <span className="fk">{chip.label}</span>
          <b>{chip.text}</b>
          <Icon name="chevron-down" />
        </button>
        <button type="button" aria-label={`Remove filter ${chip.label} ${chip.text}`} onClick={onRemove}>
          <Icon name="x" />
        </button>
      </span>
      {pop.open ? (
        <div
          className="menu chip-menu"
          id={id}
          role="menu"
          aria-label={`${WORD(kind)} is any of`}
          data-od-id={`multi-${kind}`}
        >
          <div className="menu-label">{WORD(kind)} is any of</div>
          {options.map((v) => (
            <label key={v} className="menu-item">
              <span className="check">
                <input
                  type="checkbox"
                  checked={selected.includes(v)}
                  onChange={(e) =>
                    onSet(e.target.checked ? [...selected, v] : selected.filter((x) => x !== v))
                  }
                />
              </span>
              <span className="grow">{WORD(v)}</span>
              {kind === "status" ? <StatusCount status={v} /> : null}
            </label>
          ))}
          <div className="menu-sep" />
          <div className="menu-foot">
            <code className="mono">
              {kind}={selected.join(",")}
            </code>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                pop.setOpen(false)
                onRemove()
              }}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}

function StatusCount({ status }: { status: string }) {
  const n = useQuery(statusCountQuery(status)).data
  return <span className="kind">{n === undefined || n === null ? "" : fmtInt(n)}</span>
}

function ColumnsMenu({
  columns,
  fields,
  onChange,
}: {
  columns: string[]
  fields: ContactField[]
  onChange: (next: string[]) => void
}) {
  const pop = usePopover<HTMLSpanElement>()
  const id = useId()
  const row = (colId: string, label: ReactNode, kind?: string) => {
    const on = columns.includes(colId)
    return (
      <div key={colId} className="menu-item" style={{ gap: 6 }}>
        <label
          className="cluster grow"
          style={{ ["--gap" as string]: "8px", flexWrap: "nowrap", minWidth: 0, cursor: "pointer" }}
        >
          <span className="check">
            <input
              type="checkbox"
              checked={on}
              onChange={(e) => onChange(toggleColumn(columns, colId, e.target.checked))}
            />
          </span>
          <span className="grow" style={{ minWidth: 0 }}>
            {label}
          </span>
        </label>
        {kind ? <span className="kind">{kind}</span> : null}
        {on ? (
          <span className="cluster" style={{ ["--gap" as string]: "0" }}>
            <button
              className="icon-btn"
              type="button"
              aria-label={`Move ${typeof label === "string" ? label : colId} left`}
              disabled={columns.indexOf(colId) === 0}
              onClick={() => onChange(moveColumn(columns, colId, -1))}
            >
              <Icon name="chevron-left" />
            </button>
            <button
              className="icon-btn"
              type="button"
              aria-label={`Move ${typeof label === "string" ? label : colId} right`}
              disabled={columns.indexOf(colId) === columns.length - 1}
              onClick={() => onChange(moveColumn(columns, colId, 1))}
            >
              <Icon name="chevron-right" />
            </button>
          </span>
        ) : null}
      </div>
    )
  }
  return (
    <span ref={pop.anchor} style={{ position: "relative", display: "inline-flex" }}>
      <button
        ref={pop.trigger}
        className="btn btn-ghost btn-sm"
        type="button"
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={id}
        data-od-id="columns-button"
        onClick={pop.toggle}
      >
        <Icon name="sliders" />
        Columns
      </button>
      {pop.open ? (
        <div
          className="menu"
          id={id}
          role="menu"
          aria-label="Columns"
          data-od-id="columns-menu"
          data-endpoint="GET /v1/contact-fields"
          style={{
            right: 0,
            top: "calc(100% + 6px)",
            width: "min(320px, calc(100vw - 32px))",
            maxHeight: "70vh",
            overflowY: "auto",
          }}
        >
          <div className="menu-label">Columns · arrows reorder</div>
          <label className="menu-item">
            <span className="check">
              <input type="checkbox" checked disabled aria-label="Contact (always shown)" />
            </span>
            <span className="grow">Contact</span>
            <Icon name="lock" />
          </label>
          {BUILTIN_COLUMNS.map((c) => row(c, COLUMN_LABEL[c]))}
          <div className="menu-sep" />
          <div className="menu-label">
            Custom fields ·{" "}
            <Link className="link" to="/audience/fields">
              name them
            </Link>
          </div>
          {fields.length ? (
            fields.map((f) =>
              row(
                `f.${f.key}`,
                f.label === f.key ? (
                  f.key
                ) : (
                  <>
                    {fieldLabel(f, f.key)} <span className="mono-sub">{f.key}</span>
                  </>
                ),
                f.type,
              ),
            )
          ) : (
            <div className="menu-item muted">No custom fields yet</div>
          )}
          <div className="menu-sep" />
          <div className="menu-foot">
            <span className="kind">Saved in the URL as cols=</span>
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => onChange([...DEFAULT_COLUMNS])}
            >
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}
