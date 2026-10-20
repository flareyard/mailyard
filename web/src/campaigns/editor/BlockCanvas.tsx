/**
 * The block canvas (design: campaign-content.html → Body; `.blocks > .palette-col + .paper > .paper-inner >
 * .eblock`). Blocks render with the email's own `em-*` styles; the selected one shows its tools (move up and
 * down, duplicate, delete) and its fields underneath. Blocks come in from the palette by click or drag, and move
 * by drag, the tool buttons or Alt+↑/↓. A 400 naming `bodyBlocks.blocks[i]…` or `bodyBlocks.footer…` marks that
 * block with the API's message, as is (HAL-3433).
 */
import { type DragEvent, Fragment, type ReactNode, useState } from "react"
import { Icon, type IconName } from "../../ui/icons.tsx"
import {
  BLOCK_LABEL,
  duplicateBlock,
  insertBlock,
  moveBlock,
  newBlock,
  PALETTE,
  removeBlock,
  updateBlock,
} from "../blocks.ts"
import { BUILT_IN_KEYS, parsePlaceholders } from "../logic.ts"
import type { Block, BlocksDoc, BlockType } from "../queries.ts"

const ICON: Partial<Record<BlockType, IconName>> = {
  heading: "pencil",
  subheading: "pencil",
  paragraph: "list",
  note: "info",
  warn: "warn",
  button: "arrow-right",
  buttons: "arrow-right",
  list: "list",
  steps: "list",
  stats: "analytics",
  meta: "list",
  receipt: "dollar",
  progress: "pulse",
  question: "info",
  feedback: "reply",
  file: "file",
  otp: "key",
  html: "code",
}

const DRAG_NEW = "application/x-mailyard-block-new"
const DRAG_MOVE = "application/x-mailyard-block-move"

/** Text with its `{{ placeholders }}` marked, and those that would go out as typed marked missing. */
export function Merged({ text, fieldKeys }: { text: string; fieldKeys: readonly string[] | null }) {
  const parts = parsePlaceholders(text)
  if (!parts.length) return <>{text}</>
  const out: ReactNode[] = []
  let at = 0
  for (const p of parts) {
    if (p.start > at) out.push(text.slice(at, p.start))
    const unknown =
      p.unparsed ||
      (!p.helper &&
        fieldKeys !== null &&
        !BUILT_IN_KEYS.has(p.key) &&
        !p.key.startsWith("trigger.") &&
        !fieldKeys.includes(p.key.replace(/^(contact\.)?fields\./, "")))
    out.push(
      <span
        key={p.start}
        className={`merge${unknown ? " is-missing" : ""}`}
        {...(unknown ? { title: "Would go out as typed" } : {})}
      >
        {p.raw}
      </span>,
    )
    at = p.end
  }
  if (at < text.length) out.push(text.slice(at))
  return <>{out}</>
}

/** One block as the email shows it. */
export function BlockView({ b, fieldKeys }: { b: Block; fieldKeys: readonly string[] | null }) {
  const M = (t: string) => <Merged text={t} fieldKeys={fieldKeys} />
  switch (b.type) {
    case "heading":
      return <p className="em-h">{M(b.text)}</p>
    case "subheading":
      return (
        <p className="em-p">
          <b>{M(b.text)}</b>
        </p>
      )
    case "paragraph":
      return <p className="em-p">{M(b.text)}</p>
    case "note":
      return <p className="em-p em-note">{M(b.text)}</p>
    case "warn":
      return <p className="em-p em-note cmp-em-warn">{M(b.text)}</p>
    case "button":
      return (
        <span
          className={`em-btn${b.style === "ghost" ? " cmp-em-ghost" : b.style === "danger" ? " cmp-em-danger" : ""}`}
        >
          {M(b.label)}
        </span>
      )
    case "buttons":
      return (
        <div className="cluster" style={{ gap: 8 }}>
          {b.items.map((i, k) => (
            <span
              key={`btn-${String(k)}`}
              className={`em-btn${i.style === "ghost" ? " cmp-em-ghost" : i.style === "danger" ? " cmp-em-danger" : ""}`}
            >
              {M(i.label)}
            </span>
          ))}
        </div>
      )
    case "stats":
      return (
        <div className="em-cols">
          {b.items.map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered items
            <div key={k} className="em-card">
              <b className="cmp-em-stat">{M(i.value)}</b>
              <span>{M(i.label)}</span>
            </div>
          ))}
        </div>
      )
    case "list":
      return (
        <div className="em-cols">
          {b.items.map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered items
            <div key={k} className="em-card">
              <b>{M(i.title)}</b>
              {i.sub ? <span>{M(i.sub)}</span> : null}
            </div>
          ))}
        </div>
      )
    case "steps":
      return (
        <ol className="em-p cmp-em-steps">
          {b.items.map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered items
            <li key={k}>
              <b>{M(i.title)}</b>
              {i.sub ? <span className="em-pre"> · {M(i.sub)}</span> : null}
            </li>
          ))}
        </ol>
      )
    case "meta":
      return (
        <dl className="cmp-em-meta">
          {b.items.map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered items
            <Fragment key={k}>
              <dt className="em-pre">{M(i.label)}</dt>
              <dd className="em-p">{M(i.value)}</dd>
            </Fragment>
          ))}
        </dl>
      )
    case "receipt":
      return (
        <dl className="cmp-em-meta">
          {b.lines.map((i, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered lines
            <Fragment key={k}>
              <dt className="em-p">{M(i.label)}</dt>
              <dd className="em-p">{M(i.value)}</dd>
            </Fragment>
          ))}
          <dt className="em-p">
            <b>{M(b.total.label)}</b>
          </dt>
          <dd className="em-p">
            <b>{M(b.total.value)}</b>
          </dd>
        </dl>
      )
    case "otp":
      return <p className="em-h mono cmp-em-otp">{b.code}</p>
    case "progress":
      return (
        <ol className="cmp-em-progress">
          {b.stages.map((s, k) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: ordered stages
            <li key={k} className={k < Number(b.done) ? "is-done" : ""}>
              {M(s)}
            </li>
          ))}
        </ol>
      )
    case "feedback":
    case "question":
      return (
        <div className="stack stack-8">
          <span className="em-pre">{M(b.label)}</span>
          <p className="em-p">
            <b>{M(b.type === "feedback" ? b.question : b.stem)}</b>
          </p>
          <div className="cluster" style={{ gap: 8 }}>
            {b.answers.map((a, k) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered answers
              <span key={k} className="em-btn cmp-em-ghost">
                {M(a.label)}
              </span>
            ))}
          </div>
        </div>
      )
    case "file":
      return (
        <div className="em-card">
          <span className="em-pre">{b.tag}</span>
          <b>{M(b.name)}</b>
          <span>{M(b.sub)}</span>
        </div>
      )
    case "html":
      return <pre className="em-pre cmp-em-html">{b.html}</pre>
  }
}

// ---------------------------------------------------------------------------------------------
// Field editors, driven by a small description of each block type
// ---------------------------------------------------------------------------------------------

type F =
  | { key: string; label: string; kind: "text" | "textarea" | "url" | "number" }
  | { key: string; label: string; kind: "select"; options: readonly string[] }
  | {
      key: string
      label: string
      kind: "items"
      item: readonly F[]
      add: Record<string, string>
      min?: number
    }
  | { key: string; label: string; kind: "strings"; add: string }
  | { key: string; label: string; kind: "object"; fields: readonly F[] }

const STYLE: F = { key: "style", label: "Style", kind: "select", options: ["primary", "ghost", "danger"] }
const TEXT = (label = "Text"): F => ({ key: "text", label, kind: "textarea" })

const FIELDS: Record<BlockType, readonly F[]> = {
  heading: [TEXT()],
  subheading: [TEXT()],
  paragraph: [TEXT()],
  note: [TEXT()],
  warn: [TEXT()],
  button: [{ key: "label", label: "Label", kind: "text" }, { key: "url", label: "Link", kind: "url" }, STYLE],
  buttons: [
    {
      key: "items",
      label: "Buttons",
      kind: "items",
      item: [
        { key: "label", label: "Label", kind: "text" },
        { key: "url", label: "Link", kind: "url" },
        STYLE,
      ],
      add: { label: "Another", url: "https://", style: "ghost" },
    },
  ],
  stats: [
    {
      key: "items",
      label: "Figures",
      kind: "items",
      item: [
        { key: "label", label: "Label", kind: "text" },
        { key: "value", label: "Value", kind: "text" },
      ],
      add: { label: "Label", value: "0" },
    },
  ],
  list: [
    {
      key: "items",
      label: "Items",
      kind: "items",
      item: [
        { key: "title", label: "Title", kind: "text" },
        { key: "sub", label: "Line", kind: "text" },
        { key: "url", label: "Link", kind: "url" },
      ],
      add: { title: "Another item" },
    },
  ],
  steps: [
    {
      key: "items",
      label: "Steps",
      kind: "items",
      item: [
        { key: "title", label: "Title", kind: "text" },
        { key: "sub", label: "Line", kind: "text" },
      ],
      add: { title: "Next step" },
    },
  ],
  meta: [
    {
      key: "items",
      label: "Details",
      kind: "items",
      item: [
        { key: "label", label: "Label", kind: "text" },
        { key: "value", label: "Value", kind: "text" },
      ],
      add: { label: "Label", value: "Value" },
    },
  ],
  receipt: [
    {
      key: "lines",
      label: "Lines",
      kind: "items",
      item: [
        { key: "label", label: "Label", kind: "text" },
        { key: "value", label: "Value", kind: "text" },
      ],
      add: { label: "Item", value: "$0.00" },
    },
    {
      key: "total",
      label: "Total",
      kind: "object",
      fields: [
        { key: "label", label: "Label", kind: "text" },
        { key: "value", label: "Value", kind: "text" },
      ],
    },
  ],
  otp: [{ key: "code", label: "Code", kind: "text" }],
  progress: [
    { key: "stages", label: "Stages", kind: "strings", add: "Next stage" },
    { key: "done", label: "Stages done", kind: "number" },
  ],
  feedback: [
    { key: "label", label: "Label", kind: "text" },
    { key: "question", label: "Question", kind: "textarea" },
    {
      key: "answers",
      label: "Answers",
      kind: "items",
      item: [
        { key: "label", label: "Answer", kind: "text" },
        { key: "url", label: "Link", kind: "url" },
      ],
      add: { label: "Another answer", url: "https://" },
    },
  ],
  question: [
    { key: "label", label: "Label", kind: "text" },
    { key: "stem", label: "Question", kind: "textarea" },
    {
      key: "answers",
      label: "Answers",
      kind: "items",
      item: [
        { key: "label", label: "Answer", kind: "text" },
        { key: "url", label: "Link", kind: "url" },
      ],
      add: { label: "Another answer", url: "https://" },
    },
  ],
  file: [
    { key: "tag", label: "Tag", kind: "text" },
    { key: "name", label: "Name", kind: "text" },
    { key: "sub", label: "Line", kind: "text" },
  ],
  html: [
    { key: "html", label: "HTML", kind: "textarea" },
    { key: "text", label: "Plain-text version (optional)", kind: "textarea" },
  ],
}

type Obj = Record<string, unknown>

function FieldsEditor({
  fields,
  value,
  onChange,
  idBase,
}: {
  fields: readonly F[]
  value: Obj
  onChange: (v: Obj) => void
  idBase: string
}) {
  const set = (k: string, v: unknown) => {
    const next: Obj = { ...value }
    if (v === "" && k !== "text" && k !== "html" && k !== "label" && k !== "url") delete next[k]
    else next[k] = v
    onChange(next)
  }
  return (
    <div className="stack stack-8">
      {fields.map((f) => {
        const id = `${idBase}-${f.key}`
        const v = value[f.key]
        if (f.kind === "items") {
          const items = (Array.isArray(v) ? v : []) as Obj[]
          return (
            <fieldset key={f.key} className="stack stack-8 cmp-fieldset">
              <legend className="label">{f.label}</legend>
              {items.map((it, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered items, edited in place
                <div key={i} className="cmp-item">
                  <FieldsEditor
                    fields={f.item}
                    value={it}
                    idBase={`${id}-${i}`}
                    onChange={(nv) =>
                      set(
                        f.key,
                        items.map((x, k) => (k === i ? nv : x)),
                      )
                    }
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    disabled={items.length <= (f.min ?? 1)}
                    onClick={() =>
                      set(
                        f.key,
                        items.filter((_, k) => k !== i),
                      )
                    }
                  >
                    <Icon name="trash" />
                    Remove
                  </button>
                </div>
              ))}
              <div>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => set(f.key, [...items, { ...f.add }])}
                >
                  <Icon name="plus" />
                  Add
                </button>
              </div>
            </fieldset>
          )
        }
        if (f.kind === "strings") {
          const items = (Array.isArray(v) ? v : []) as string[]
          return (
            <fieldset key={f.key} className="stack stack-8 cmp-fieldset">
              <legend className="label">{f.label}</legend>
              {items.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: ordered strings
                <div key={i} className="input-group">
                  <input
                    className="input"
                    aria-label={`${f.label} ${i + 1}`}
                    value={s}
                    onChange={(e) =>
                      set(
                        f.key,
                        items.map((x, k) => (k === i ? e.target.value : x)),
                      )
                    }
                  />
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    aria-label={`Remove ${f.label.toLowerCase()} ${i + 1}`}
                    disabled={items.length <= 1}
                    onClick={() =>
                      set(
                        f.key,
                        items.filter((_, k) => k !== i),
                      )
                    }
                  >
                    <Icon name="x" />
                  </button>
                </div>
              ))}
              <div>
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  onClick={() => set(f.key, [...items, f.add])}
                >
                  <Icon name="plus" />
                  Add
                </button>
              </div>
            </fieldset>
          )
        }
        if (f.kind === "object") {
          return (
            <fieldset key={f.key} className="stack stack-8 cmp-fieldset">
              <legend className="label">{f.label}</legend>
              <FieldsEditor
                fields={f.fields}
                value={(v ?? {}) as Obj}
                idBase={id}
                onChange={(nv) => set(f.key, nv)}
              />
            </fieldset>
          )
        }
        return (
          <div key={f.key} className="field">
            <label className="label" htmlFor={id}>
              {f.label}
            </label>
            {f.kind === "textarea" ? (
              <textarea
                className={`textarea${f.key === "html" ? " mono" : ""}`}
                id={id}
                rows={f.key === "html" ? 6 : 3}
                value={typeof v === "string" ? v : ""}
                onChange={(e) => set(f.key, e.target.value)}
              />
            ) : f.kind === "select" ? (
              <select
                className="select"
                id={id}
                value={typeof v === "string" ? v : f.options[0]}
                onChange={(e) => set(f.key, e.target.value)}
              >
                {f.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className={`input${f.kind === "url" ? " mono" : ""}`}
                id={id}
                type={f.kind === "number" ? "number" : f.kind === "url" ? "url" : "text"}
                inputMode={f.kind === "number" ? "numeric" : undefined}
                value={v === undefined || v === null ? "" : String(v)}
                onChange={(e) =>
                  set(f.key, f.kind === "number" ? Number(e.target.value) || 0 : e.target.value)
                }
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------------------------

export type BlockError = { index: number | "footer"; message: string; path: string }

export function BlockCanvas({
  doc,
  onChange,
  editable,
  fieldKeys,
  postalAddress,
  error,
}: {
  doc: BlocksDoc
  onChange: (doc: BlocksDoc) => void
  editable: boolean
  fieldKeys: readonly string[] | null
  postalAddress: string | null | undefined
  error: BlockError | null
}) {
  const [selected, setSelected] = useState<number | "footer" | null>(error ? error.index : null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const blocks = doc.blocks
  const setBlocks = (next: Block[]) => onChange({ ...doc, blocks: next })

  const add = (type: BlockType, at?: number) => {
    const where = at ?? (typeof selected === "number" ? selected + 1 : blocks.length)
    setBlocks(insertBlock(blocks, where, newBlock(type)))
    setSelected(where)
  }

  const onDrop = (e: DragEvent, at: number) => {
    e.preventDefault()
    setDropAt(null)
    const t = e.dataTransfer.getData(DRAG_NEW) as BlockType
    if (t) return add(t, at)
    const from = e.dataTransfer.getData(DRAG_MOVE)
    if (from !== "") {
      const i = Number(from)
      const b = blocks[i]
      if (!b || Number.isNaN(i)) return
      const without = removeBlock(blocks, i)
      const to = at > i ? at - 1 : at
      setBlocks(insertBlock(without, to, b))
      setSelected(to)
    }
  }
  const allowDrop = (e: DragEvent, at: number) => {
    if (!editable) return
    const types = [...e.dataTransfer.types]
    if (types.includes(DRAG_NEW) || types.includes(DRAG_MOVE)) {
      e.preventDefault()
      setDropAt(at)
    }
  }

  return (
    <div className="blocks">
      {editable ? (
        <div className="palette-col edit-only" data-od-id="block-palette">
          <span className="bp-label">Drag in a block, or click to add</span>
          {PALETTE.map((g) => (
            <Fragment key={g.label}>
              <span className="bp-label">{g.label}</span>
              {g.items.map((it) => (
                <button
                  key={it.type}
                  className="bp-item"
                  type="button"
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_NEW, it.type)
                    e.dataTransfer.effectAllowed = "copy"
                  }}
                  onClick={() => add(it.type)}
                >
                  <Icon name={ICON[it.type] ?? "plus"} />
                  {it.label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      ) : null}
      <div className="paper" data-od-id="block-canvas" id="block-canvas" tabIndex={-1}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragged blocks; every block can be added by click too */}
        <div
          className="paper-inner"
          onDragOver={(e) => allowDrop(e, blocks.length)}
          onDragLeave={() => setDropAt(null)}
          onDrop={(e) => onDrop(e, dropAt ?? blocks.length)}
        >
          {doc.preheader ? (
            <div className="eblock">
              <p className="em-pre">
                <Merged text={doc.preheader} fieldKeys={fieldKeys} />
              </p>
            </div>
          ) : null}
          {doc.label ? (
            <div className="eblock">
              <p className="em-pre">
                <b>
                  <Merged text={doc.label} fieldKeys={fieldKeys} />
                </b>
              </p>
            </div>
          ) : null}
          {blocks.map((b, i) => {
            const isSel = selected === i
            const err = error && error.index === i ? error : null
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: a block's place is its identity (bodyBlocks.blocks[i])
              <Fragment key={i}>
                {dropAt === i ? <div className="cmp-drop" aria-hidden="true" /> : null}
                {/* biome-ignore lint/a11y/useSemanticElements: the block holds buttons and inputs, so it can't itself be a button */}
                <div
                  className={`eblock${isSel ? " is-selected" : ""}${err ? " is-error" : ""}`}
                  data-block={i}
                  data-path={`bodyBlocks.blocks[${i}]`}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  aria-label={`${BLOCK_LABEL[b.type] ?? b.type} block ${i + 1}`}
                  draggable={editable}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_MOVE, String(i))
                    e.dataTransfer.effectAllowed = "move"
                  }}
                  onDragOver={(e) => {
                    e.stopPropagation()
                    allowDrop(e, i)
                  }}
                  onDrop={(e) => {
                    e.stopPropagation()
                    onDrop(e, i)
                  }}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest(".cmp-block-form, .eb-tools")) return
                    setSelected(isSel ? null : i)
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      setSelected(isSel ? null : i)
                    }
                    if (editable && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
                      e.preventDefault()
                      const by = e.key === "ArrowUp" ? -1 : 1
                      setBlocks(moveBlock(blocks, i, by))
                      setSelected(Math.max(0, Math.min(blocks.length - 1, i + by)))
                    }
                    if (e.key === "Escape") setSelected(null)
                  }}
                >
                  <span className="eb-tag">{BLOCK_LABEL[b.type] ?? b.type}</span>
                  {editable ? (
                    <span className="eb-tools">
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={i === 0}
                        onClick={() => {
                          setBlocks(moveBlock(blocks, i, -1))
                          setSelected(i - 1)
                        }}
                      >
                        <Icon name="chevron-down" className="cmp-flip" />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        disabled={i === blocks.length - 1}
                        onClick={() => {
                          setBlocks(moveBlock(blocks, i, 1))
                          setSelected(i + 1)
                        }}
                      >
                        <Icon name="chevron-down" />
                      </button>
                      <button
                        type="button"
                        aria-label="Duplicate block"
                        onClick={() => {
                          setBlocks(duplicateBlock(blocks, i))
                          setSelected(i + 1)
                        }}
                      >
                        <Icon name="copy" />
                      </button>
                      <button
                        type="button"
                        aria-label="Delete block"
                        onClick={() => {
                          setBlocks(removeBlock(blocks, i))
                          setSelected(null)
                        }}
                      >
                        <Icon name="trash" />
                      </button>
                    </span>
                  ) : null}
                  <BlockView b={b} fieldKeys={fieldKeys} />
                  {err ? (
                    <div className="eb-err" role="alert" data-od-id="field-error">
                      <Icon name="x-circle" />
                      <span>
                        {err.message} <code className="mono">{err.path}</code>
                      </span>
                    </div>
                  ) : null}
                  {isSel && editable ? (
                    <div className="cmp-block-form edit-only">
                      <FieldsEditor
                        fields={FIELDS[b.type] ?? []}
                        value={b as unknown as Obj}
                        idBase={`blk-${i}`}
                        onChange={(v) => setBlocks(updateBlock(blocks, i, v as unknown as Block))}
                      />
                    </div>
                  ) : null}
                </div>
              </Fragment>
            )
          })}
          {dropAt === blocks.length ? <div className="cmp-drop" aria-hidden="true" /> : null}
          {blocks.length === 0 ? (
            <p className="hint" style={{ padding: "16px 32px" }}>
              No blocks yet. Click one in the palette, or drag it here.
            </p>
          ) : null}
          {/* biome-ignore lint/a11y/useSemanticElements: the footer holds a form when selected */}
          <div
            className={`footer-lock${error?.index === "footer" ? " is-error" : ""}${postalAddress ? "" : " is-missing"}`}
            data-od-id="unsubscribe-footer"
            data-path="bodyBlocks.footer"
            data-endpoint="bodyBlocks.footer · GET /v1/settings/compliance"
            role="button"
            tabIndex={0}
            aria-pressed={selected === "footer"}
            aria-label="Footer"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest(".cmp-block-form")) return
              setSelected(selected === "footer" ? null : "footer")
            }}
            onKeyDown={(e) => {
              if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault()
                setSelected(selected === "footer" ? null : "footer")
              }
            }}
          >
            <span className="fl-tag">
              <Icon name="lock" />
              Footer · required
            </span>
            <span>
              <Merged text={doc.footer.reason} fieldKeys={fieldKeys} />
            </span>
            {error?.index === "footer" ? (
              <div className="eb-err" role="alert" data-od-id="field-error">
                <Icon name="x-circle" />
                <span>
                  {error.message} <code className="mono">{error.path}</code>
                </span>
              </div>
            ) : null}
            <p style={{ margin: 0 }}>
              {(doc.footer.links?.length
                ? doc.footer.links
                : [
                    { label: "Manage your topics", url: "" },
                    { label: "Unsubscribe", url: "" },
                  ]
              ).map((l, i) => (
                <span key={`${l.label}${l.url}`}>
                  {i ? " · " : ""}
                  <span className="cmp-link-like">{l.label}</span>
                </span>
              ))}
            </p>
            <span className="fl-addr">{postalAddress || "No postal address set"}</span>
            {selected === "footer" && editable ? (
              <div className="cmp-block-form edit-only" style={{ textAlign: "left" }}>
                <FieldsEditor
                  fields={[
                    { key: "reason", label: "Why they get it", kind: "textarea" },
                    {
                      key: "links",
                      label: "Extra links",
                      kind: "items",
                      item: [
                        { key: "label", label: "Label", kind: "text" },
                        { key: "url", label: "Link", kind: "url" },
                      ],
                      add: { label: "Our site", url: "https://" },
                      min: 0,
                    },
                  ]}
                  value={doc.footer as unknown as Obj}
                  idBase="footer"
                  onChange={(v) => onChange({ ...doc, footer: v as BlocksDoc["footer"] })}
                />
              </div>
            ) : null}
            <span className="hint">
              The document’s <code className="mono">footer</code> gives the reason and its links; the postal
              address comes from Settings. It can’t be removed: every campaign carries a way out.
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
