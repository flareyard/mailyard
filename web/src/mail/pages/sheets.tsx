/**
 * The sheets the mailbox layout opens from `?sheet=`: edit labels (labels-manage.html), smart folders
 * (smart-folders.html) and a rule from a message (rule-from-message.html).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState } from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { num } from "../../lib/format.ts"
import { Icon } from "../../ui/icons.tsx"
import { useMail } from "../context.tsx"
import { mailKeys } from "../queries.ts"
import { toast } from "../toasts.tsx"
import type { FoldersBody, Label, LabelColor } from "../types.ts"
import { RuleSheet } from "./RuleSheet.tsx"
import { SampleMarker, Sheet } from "./shared.tsx"

export const LABEL_COLORS: { value: LabelColor | null; name: string }[] = [
  { value: "blue", name: "Blue" },
  { value: "navy", name: "Navy" },
  { value: "sky", name: "Sky" },
  { value: "teal", name: "Teal" },
  { value: "pine", name: "Pine" },
  { value: "slate", name: "Slate" },
  { value: null, name: "No colour" },
]

const errText = (e: unknown) => (e instanceof ApiError ? e.message : "Mailyard couldn’t be reached.")

/** Saves a text field after a pause in typing, and on blur. */
function useDebouncedSave(value: string, original: string, save: (v: string) => void, ms = 700) {
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    if (value === original || !value.trim()) return
    const t = setTimeout(() => saveRef.current(value.trim()), ms)
    return () => clearTimeout(t)
  }, [value, original, ms])
}

export function LabelsSheet({ onClose }: { onClose: () => void }) {
  const { mailboxId, local, labels, folders, access } = useMail()
  const qc = useQueryClient()
  const fkey = mailKeys.folders(mailboxId)
  const setLabels = (fn: (l: Label[]) => Label[]) =>
    qc.setQueryData<FoldersBody>(fkey, (old) => (old ? { ...old, labels: fn(old.labels) } : old))
  const [name, setName] = useState("")
  const [color, setColor] = useState<LabelColor | null>("blue")
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/labels", {
          params: { path: { id: mailboxId } },
          body: { name: name.trim(), color },
        }),
      ) as Promise<Label>,
    onSuccess: (l) => {
      setLabels((all) => [...all, l])
      setName("")
    },
    onError: (e) => toast({ title: "The label wasn’t created", sub: errText(e), tone: "error" }),
  })
  return (
    <Sheet
      title={`Labels in ${local}`}
      hint={
        <>
          Rename in place; changes save as you go. Each label is one of six colours or none:{" "}
          <span className="mono">blue, navy, sky, teal, pine, slate</span>. There are no custom or hex
          colours; labels made with other colours were moved to the nearest of these six. Green, amber and red
          stay reserved for pass, warning and fail.
        </>
      }
      onClose={onClose}
      endpoint="GET /v1/mailboxes/{id}/labels · POST · PATCH /labels/{labelId} {name, color} · DELETE"
      foot={
        <>
          <span style={{ marginRight: "auto" }}>
            <SampleMarker />
          </span>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {!folders ? (
        <div className="stack stack-8" aria-hidden="true">
          <span className="sk sk-text" />
          <span className="sk sk-text" />
        </div>
      ) : (
        <ul className="list">
          {labels.length === 0 ? (
            <li>
              <p className="t-small muted">
                No labels yet. Create one below; rules and the Label picker use them.
              </p>
            </li>
          ) : null}
          {labels.map((l) => (
            <LabelRow key={l.id} label={l} canEdit={access.write} onChange={setLabels} />
          ))}
        </ul>
      )}
      <form
        className="stack stack-8"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && access.write) create.mutate()
        }}
      >
        <b className="t-label">New label</b>
        <div
          className="list-row"
          style={{ flexWrap: "wrap", gap: "8px 12px", margin: 0, padding: 0, borderBottom: 0 }}
        >
          <i className={`label-dot${color ? ` lc-${color}` : ""}`} aria-hidden="true" />
          <input
            className="input lbl-name"
            style={{ flex: "1 1 140px", width: "auto" }}
            placeholder="Name"
            aria-label="New label name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <ColourPicker name="c-new" value={color} onChange={setColor} />
          <Gated allowed={access.write} reason={access.writeReason} who={access.writeWho} side="up">
            <button
              className="btn btn-secondary btn-sm"
              type="submit"
              disabled={create.isPending || !name.trim()}
            >
              Create
            </button>
          </Gated>
        </div>
      </form>
    </Sheet>
  )
}

function ColourPicker({
  name,
  value,
  onChange,
  disabled,
}: {
  name: string
  value: LabelColor | null
  onChange: (c: LabelColor | null) => void
  disabled?: boolean
}) {
  return (
    <div className="lbl-colours" role="radiogroup" aria-label="Colour">
      {LABEL_COLORS.map((c) => (
        <label key={c.name} className="check" title={c.name}>
          <input
            type="radio"
            name={name}
            checked={value === c.value}
            aria-label={c.name}
            disabled={disabled}
            onChange={() => onChange(c.value)}
          />
          <i className={`label-dot${c.value ? ` lc-${c.value}` : ""}`} aria-hidden="true" />
        </label>
      ))}
    </div>
  )
}

function LabelRow({
  label: l,
  canEdit,
  onChange,
}: {
  label: Label
  canEdit: boolean
  onChange: (fn: (l: Label[]) => Label[]) => void
}) {
  const { mailboxId, access } = useMail()
  const [name, setName] = useState(l.name)
  const [confirm, setConfirm] = useState(false)
  const update = useMutation({
    mutationFn: (body: { name?: string; color?: LabelColor | null }) =>
      unwrap(
        api.PATCH("/v1/mailboxes/{id}/labels/{labelId}", {
          params: { path: { id: mailboxId, labelId: l.id } },
          body,
        }),
      ) as Promise<Label>,
    onMutate: (body) => onChange((all) => all.map((x) => (x.id === l.id ? { ...x, ...body } : x))),
    onSuccess: (saved) => onChange((all) => all.map((x) => (x.id === saved.id ? saved : x))),
    onError: (e) => {
      onChange((all) => all.map((x) => (x.id === l.id ? l : x)))
      toast({ title: `“${l.name}” didn’t change`, sub: errText(e), tone: "error" })
    },
  })
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/v1/mailboxes/{id}/labels/{labelId}", {
          params: { path: { id: mailboxId, labelId: l.id } },
        }),
      ),
    onSuccess: () => {
      onChange((all) => all.filter((x) => x.id !== l.id))
      toast({
        title: `Deleted label “${l.name}”`,
        sub: "Threads keep everything else; only the label is gone.",
      })
    },
    onError: (e) => toast({ title: `“${l.name}” wasn’t deleted`, sub: errText(e), tone: "error" }),
  })
  useDebouncedSave(name, l.name, (v) => canEdit && update.mutate({ name: v }))
  const threads = num(l.threads) ?? 0
  return (
    <li className="list-row" style={{ flexWrap: "wrap", gap: "8px 12px" }}>
      <i className={`label-dot${l.color ? ` lc-${l.color}` : ""}`} aria-hidden="true" />
      <input
        className="input lbl-name"
        style={{ flex: "1 1 140px", width: "auto" }}
        value={name}
        readOnly={!canEdit}
        aria-label={`Name of label ${l.name}`}
        onChange={(e) => setName(e.target.value)}
        onBlur={() =>
          canEdit && name.trim() && name.trim() !== l.name && update.mutate({ name: name.trim() })
        }
      />
      <ColourPicker
        name={`c-${l.id}`}
        value={l.color}
        disabled={!canEdit}
        onChange={(color) => update.mutate({ color })}
      />
      <span className="t-small muted num" style={{ minWidth: 84 }}>
        {threads.toLocaleString("en")} {threads === 1 ? "thread" : "threads"}
      </span>
      <Gated allowed={canEdit} reason={access.writeReason} who={access.writeWho} side="right">
        {confirm ? (
          <button
            className="btn btn-danger btn-sm"
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            Delete for good
          </button>
        ) : (
          <button
            className="icon-btn"
            type="button"
            aria-label={`Delete label ${l.name}`}
            title={`Delete label ${l.name}`}
            onClick={() => setConfirm(true)}
          >
            <Icon name="trash" />
          </button>
        )}
      </Gated>
    </li>
  )
}

/* ───────────── Smart folders ───────────── */

type SF = FoldersBody["smartFolders"][number]

export function SmartFoldersSheet({ save, onClose }: { save?: string; onClose: () => void }) {
  const { mailboxId, local, folders, access } = useMail()
  const qc = useQueryClient()
  const fkey = mailKeys.folders(mailboxId)
  const setList = (fn: (l: SF[]) => SF[]) =>
    qc.setQueryData<FoldersBody>(fkey, (old) => (old ? { ...old, smartFolders: fn(old.smartFolders) } : old))
  const [name, setName] = useState("")
  const [q, setQ] = useState(save ?? "")
  const create = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/v1/mailboxes/{id}/smart-folders", {
          params: { path: { id: mailboxId } },
          body: { name: name.trim(), q: q.trim() },
        }),
      ) as Promise<SF>,
    onSuccess: (sf) => {
      setList((all) => [...all, sf])
      setName("")
      setQ("")
      toast({ title: `Saved “${sf.name}”`, sub: "It’s in the folder pane under Smart folders." })
    },
    onError: (e) => toast({ title: "The smart folder wasn’t saved", sub: errText(e), tone: "error" }),
  })
  const list = folders?.smartFolders ?? []
  return (
    <Sheet
      title={`Smart folders in ${local}`}
      hint="A smart folder is a saved search: a name and the words and operators to run. It shows no count, because it runs fresh each time you open it."
      onClose={onClose}
      endpoint="GET/POST /v1/mailboxes/{id}/smart-folders · PATCH/DELETE …/smart-folders/{folderId} (built)"
      foot={
        <>
          <span style={{ marginRight: "auto" }}>
            <SampleMarker />
          </span>
          <button className="btn btn-secondary" type="button" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <form
        className="stack stack-8"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && q.trim() && access.write) create.mutate()
        }}
      >
        <b className="t-label">{save ? "Save this search" : "New smart folder"}</b>
        <div className="cluster" style={{ flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 160px", width: "auto" }}
            placeholder="Name"
            aria-label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input mono"
            style={{ flex: "2 1 260px", width: "auto" }}
            placeholder="from: subject: is:unread after:2026-10-01 …"
            aria-label="Search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <Gated allowed={access.write} reason={access.writeReason} who={access.writeWho} side="up">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={create.isPending || !name.trim() || !q.trim()}
            >
              Save
            </button>
          </Gated>
        </div>
        <p className="hint">
          Saved exactly as typed. Operators search doesn’t support yet are kept, and ignored until they are.
        </p>
      </form>
      <div className="divider" />
      <b className="t-label">Saved</b>
      {list.length === 0 ? (
        <p className="t-small muted">
          Nothing saved yet. Search in a mailbox, then save it here to keep it one click away.
        </p>
      ) : (
        <ul className="list">
          {list.map((sf) => (
            <SmartFolderRow key={sf.id} sf={sf} canEdit={access.write} onChange={setList} />
          ))}
        </ul>
      )}
      {list.length ? (
        <p className="hint">Rename or change the search in place; changes save as you go.</p>
      ) : null}
    </Sheet>
  )
}

function SmartFolderRow({
  sf,
  canEdit,
  onChange,
}: {
  sf: SF
  canEdit: boolean
  onChange: (fn: (l: SF[]) => SF[]) => void
}) {
  const { mailboxId, access } = useMail()
  const [name, setName] = useState(sf.name)
  const [q, setQ] = useState(sf.q)
  const update = useMutation({
    mutationFn: (body: { name: string; q: string }) =>
      unwrap(
        api.PATCH("/v1/mailboxes/{id}/smart-folders/{folderId}", {
          params: { path: { id: mailboxId, folderId: sf.id } },
          body,
        }),
      ) as Promise<SF>,
    onSuccess: (saved) => onChange((all) => all.map((x) => (x.id === saved.id ? saved : x))),
    onError: (e) => toast({ title: `“${sf.name}” didn’t change`, sub: errText(e), tone: "error" }),
  })
  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        api.DELETE("/v1/mailboxes/{id}/smart-folders/{folderId}", {
          params: { path: { id: mailboxId, folderId: sf.id } },
        }),
      ),
    onSuccess: () => {
      onChange((all) => all.filter((x) => x.id !== sf.id))
      toast({ title: `Deleted “${sf.name}”` })
    },
    onError: (e) => toast({ title: `“${sf.name}” wasn’t deleted`, sub: errText(e), tone: "error" }),
  })
  const key = `${name}\u0000${q}`
  useDebouncedSave(
    key,
    `${sf.name}\u0000${sf.q}`,
    () => canEdit && name.trim() && q.trim() && update.mutate({ name: name.trim(), q: q.trim() }),
  )
  return (
    <li className="list-row" style={{ flexWrap: "wrap", gap: "8px 12px" }}>
      <input
        className="input"
        style={{ flex: "1 1 160px", width: "auto" }}
        value={name}
        readOnly={!canEdit}
        aria-label={`Name of ${sf.name}`}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className="input mono"
        style={{ flex: "2 1 220px", width: "auto" }}
        value={q}
        readOnly={!canEdit}
        aria-label={`Search for ${sf.name}`}
        onChange={(e) => setQ(e.target.value)}
      />
      <Gated allowed={canEdit} reason={access.writeReason} who={access.writeWho} side="right">
        <button
          className="icon-btn"
          type="button"
          aria-label={`Delete ${sf.name}`}
          title={`Delete ${sf.name}`}
          onClick={() => remove.mutate()}
        >
          <Icon name="trash" />
        </button>
      </Gated>
    </li>
  )
}

/* ───────────── A rule from a message ───────────── */

export function RuleFromMessageSheet({ messageId, onClose }: { messageId: string; onClose: () => void }) {
  return <RuleSheet messageId={messageId} onClose={onClose} />
}
