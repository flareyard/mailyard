/**
 * The filter sheet (design: contacts-add-filter.html). Each section writes one query parameter, shown as it
 * will appear in the link: status and engagement as one comma list, `field=key:op[:value]`,
 * `event=[!]name[:days]`, `segmentId=` and `topicId=`. Filters combine: a contact has to match all of them.
 */
import { useId, useState } from "react"
import { Icon } from "../../ui/icons.tsx"
import type { ContactField, Segment, Topic } from "../kit/queries.ts"
import { fieldLabel } from "../kit/queries.ts"
import { Sheet } from "../kit/ui.tsx"
import {
  type ContactsSearch,
  ENGAGEMENTS,
  FIELD_OPS,
  type FieldOp,
  needsValue,
  OP_WORDS,
  type SearchPatch,
  STATUSES,
  splitList,
  withAdded,
  withList,
  writeEventFilter,
  writeFieldFilter,
} from "./logic.ts"

const WORD = (v: string) => v.replace(/^./, (c) => c.toUpperCase())
const NUMERIC: readonly FieldOp[] = ["gt", "gte", "lt", "lte"]

export function FilterSheet({
  search,
  fields,
  segments,
  topics,
  onApply,
  onClose,
}: {
  search: ContactsSearch
  fields: ContactField[]
  segments: Segment[]
  topics: Topic[]
  onApply: (next: SearchPatch) => void
  onClose: () => void
}) {
  const ids = useId()
  const [status, setStatus] = useState<string[]>(splitList(search.status))
  const [engagement, setEngagement] = useState<string[]>(splitList(search.engagement))
  const [fKey, setFKey] = useState("")
  const [fOp, setFOp] = useState<FieldOp>("eq")
  const [fValue, setFValue] = useState("")
  const [eDid, setEDid] = useState(true)
  const [eName, setEName] = useState("")
  const [eDays, setEDays] = useState("")
  const [segmentId, setSegmentId] = useState(search.segmentId ?? "")
  const [topicId, setTopicId] = useState(search.topicId ?? "")

  const fieldType = fields.find((f) => f.key === fKey)?.type
  const fieldFilter =
    fKey && (!needsValue(fOp) || fValue.trim() !== "")
      ? writeFieldFilter({ key: fKey, op: fOp, ...(needsValue(fOp) ? { value: fValue.trim() } : {}) })
      : null
  const days = eDays.trim() === "" ? undefined : Number(eDays)
  const daysError =
    days !== undefined && (!Number.isInteger(days) || days < 1 || days > 3650) ? "Days are 1 to 3650." : null
  const eventName = eName.trim()
  const nameError = eventName && /[\s:]/.test(eventName) ? "An event name has no spaces or colons." : null
  const eventFilter =
    eventName && !daysError && !nameError
      ? writeEventFilter({ name: eventName, did: eDid, ...(days !== undefined ? { days } : {}) })
      : null

  const apply = () => {
    let next: ContactsSearch = withList(withList(search, "status", status), "engagement", engagement)
    if (fieldFilter) next = withAdded(next, "field", fieldFilter)
    if (eventFilter) next = withAdded(next, "event", eventFilter)
    const patch: SearchPatch = {
      ...next,
      segmentId: segmentId || undefined,
      topicId: topicId || undefined,
      sheet: undefined,
      cursor: undefined,
    }
    onApply(patch)
  }

  const multi = (
    label: string,
    key: "status" | "engagement",
    values: readonly string[],
    sel: string[],
    set: (v: string[]) => void,
  ) => (
    <fieldset
      className="stack stack-8"
      style={{ border: 0, margin: 0, padding: 0 }}
      data-od-id={`${key}-filter`}
    >
      <legend className="label" style={{ marginBottom: 8 }}>
        {label}
      </legend>
      <div className="cluster cluster-16">
        {values.map((v) => (
          <label key={v} className="check">
            <input
              type="checkbox"
              checked={sel.includes(v)}
              onChange={(e) => set(e.target.checked ? [...sel, v] : sel.filter((x) => x !== v))}
            />
            <span>{WORD(v)}</span>
          </label>
        ))}
      </div>
      {sel.length ? (
        <div className="urlline">
          <Icon name="link" />
          <span>Adds</span>
          <code className="mono">
            {key}={values.filter((v) => sel.includes(v)).join(",")}
          </code>
        </div>
      ) : null}
    </fieldset>
  )

  return (
    <Sheet
      title="Add a filter"
      sub="Each filter is one parameter in the link. Filters combine: a contact has to match all of them."
      onClose={onClose}
      wide
      odId="filter-sheet"
      endpoint="GET /v1/contacts?q=&status=&topicId=&engagement=&segmentId=&field=&event=&sort=&cursor=&limit="
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            type="button"
            data-od-id="apply-filter"
            onClick={apply}
            disabled={Boolean(daysError || nameError)}
          >
            Add filter
          </button>
        </>
      }
    >
      <div className="fgrid">
        {multi("Status is any of", "status", STATUSES, status, setStatus)}
        {multi("Engagement is any of", "engagement", ENGAGEMENTS, engagement, setEngagement)}
      </div>
      <p className="hint">
        Tick several to match any of them; the link carries them as one comma list. Different filters still
        combine: a contact has to match all of them.
      </p>
      <div className="divider" />
      <fieldset
        className="stack stack-12"
        style={{ border: 0, margin: 0, padding: 0 }}
        data-od-id="field-filter"
      >
        <legend className="label" style={{ marginBottom: 8 }}>
          A field <span className="opt">email, name or a custom field, by its label</span>
        </legend>
        <div className="fgrid fgrid-3">
          <div className="field">
            <label className="label" htmlFor={`${ids}-fk`}>
              Field
            </label>
            <select
              className="select"
              id={`${ids}-fk`}
              value={fKey}
              onChange={(e) => setFKey(e.target.value)}
            >
              <option value="">Choose a field</option>
              <option value="email">Email · email</option>
              <option value="name">Name · name</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label === f.key ? f.key : `${fieldLabel(f, f.key)} · ${f.key}`}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor={`${ids}-fo`}>
              Is
            </label>
            <select
              className="select"
              id={`${ids}-fo`}
              value={fOp}
              onChange={(e) => setFOp(e.target.value as FieldOp)}
            >
              {FIELD_OPS.map((o) => (
                <option key={o} value={o}>
                  {OP_WORDS[o]} · {o}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor={`${ids}-fv`}>
              Value
            </label>
            <input
              className="input"
              id={`${ids}-fv`}
              value={needsValue(fOp) ? fValue : ""}
              disabled={!needsValue(fOp)}
              placeholder={needsValue(fOp) ? (fieldType === "date" ? "2026-10-01" : "") : "No value"}
              inputMode={NUMERIC.includes(fOp) || fieldType === "number" ? "decimal" : undefined}
              onChange={(e) => setFValue(e.target.value)}
            />
          </div>
        </div>
        {fieldFilter ? (
          <div className="urlline">
            <Icon name="link" />
            <span>Adds</span>
            <code className="mono">field={fieldFilter}</code>
          </div>
        ) : null}
        <p className="hint">
          “More than”, “at least”, “less than” and “at most” compare numbers when the value is a number. “Is
          set” and “is empty” take no value.
        </p>
      </fieldset>
      <div className="divider" />
      <fieldset
        className="stack stack-12"
        style={{ border: 0, margin: 0, padding: 0 }}
        data-od-id="event-filter"
      >
        <legend className="label" style={{ marginBottom: 8 }}>
          An event your app sent with <code className="mono">POST /v1/track</code>
        </legend>
        <div className="fgrid fgrid-3">
          <div className="field">
            <label className="label" htmlFor={`${ids}-ed`}>
              They
            </label>
            <select
              className="select"
              id={`${ids}-ed`}
              value={eDid ? "did" : "didnt"}
              onChange={(e) => setEDid(e.target.value === "did")}
            >
              <option value="did">did</option>
              <option value="didnt">didn’t</option>
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor={`${ids}-en`}>
              Event
            </label>
            <input
              className="input mono"
              id={`${ids}-en`}
              value={eName}
              placeholder="lesson_completed"
              onChange={(e) => setEName(e.target.value)}
              {...(nameError ? { "aria-invalid": true } : {})}
            />
            {nameError ? <span className="field-error">{nameError}</span> : null}
          </div>
          <div className="field">
            <label className="label" htmlFor={`${ids}-ew`}>
              In the last
            </label>
            <div className="input-group">
              <input
                className="input"
                id={`${ids}-ew`}
                value={eDays}
                inputMode="numeric"
                placeholder="ever"
                onChange={(e) => setEDays(e.target.value)}
                {...(daysError ? { "aria-invalid": true } : {})}
              />
              <span className="addon">days</span>
            </div>
            {daysError ? <span className="field-error">{daysError}</span> : null}
          </div>
        </div>
        {eventFilter ? (
          <div className="urlline">
            <Icon name="link" />
            <span>Adds</span>
            <code className="mono">event={eventFilter}</code>
          </div>
        ) : null}
        <p className="hint">
          Leave the days empty for “ever”. Days run from 1 to 3,650. “Didn’t” adds a{" "}
          <code className="mono">!</code>: <code className="mono">event=!lesson_completed:30</code>.
        </p>
      </fieldset>
      <div className="divider" />
      <div className="fgrid">
        <div className="field">
          <label className="label" htmlFor={`${ids}-sf`}>
            Or a saved segment
          </label>
          <select
            className="select"
            id={`${ids}-sf`}
            value={segmentId}
            onChange={(e) => setSegmentId(e.target.value)}
          >
            <option value="">Any segment</option>
            {segments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <span className="hint">
            Adds <code className="mono">segmentId=</code>. Its rules apply as they are now.
          </span>
        </div>
        <div className="field">
          <label className="label" htmlFor={`${ids}-tf`}>
            Or a topic
          </label>
          <select
            className="select"
            id={`${ids}-tf`}
            value={topicId}
            onChange={(e) => setTopicId(e.target.value)}
          >
            <option value="">Any topic</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.archived ? " · archived" : ""}
              </option>
            ))}
          </select>
          <span className="hint">
            Adds <code className="mono">topicId=</code>.
          </span>
        </div>
      </div>
    </Sheet>
  )
}
