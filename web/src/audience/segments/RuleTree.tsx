/**
 * The editable rule tree (design: segment-builder*.html, HANDOFF-audience §4 "Rule tree"): `.rg` groups with
 * an all/any switch, `.rule` rows (Rule on · Comparison · value · remove), nested groups at most 4 deep, and
 * `.rg-add`. Every row carries `data-path` (`filter.rules[1].rules[0]`); the rule a 400 or the local check
 * names is outlined with its message and path under it.
 */
import { Fragment, type ReactNode } from "react"
import { Icon } from "../../ui/icons.tsx"
import {
  ACTIVITIES,
  type Activity,
  appendTo,
  canNestAt,
  coerce,
  countLeaves,
  ENGAGEMENTS,
  type Engagement,
  type FieldOp,
  type FieldRule,
  type FieldTypeName,
  type Group,
  isGroup,
  type Leaf,
  LIMITS,
  newLeaf,
  OP_LABEL,
  opNeedsValue,
  opsFor,
  type Path,
  parseDays,
  parseSubject,
  pathString,
  type Rule,
  removeAt,
  type Scalar,
  STATUSES,
  type Status,
  setOpt,
  subjectKey,
  subjectOf,
  TOPIC_STATES,
  type TopicState,
  updateAt,
  withOp,
} from "./logic.ts"
import { ValueChips } from "./ValueChips.tsx"

export type TreeCtx = {
  topics: { id: string; name: string; archived?: boolean }[]
  campaigns: { id: string; name: string }[]
  fields: { key: string; label: string; type: FieldTypeName }[]
  /** The rule to outline, as a path string, and what's wrong with it. */
  error: { path: string; message: string } | null
}

const ERR_ID = "rule-err"

export function RuleTree({
  root,
  onChange,
  ctx,
}: {
  root: Group
  onChange: (r: Group) => void
  ctx: TreeCtx
}) {
  const set = (next: Rule) => onChange(isGroup(next) ? next : { type: "all", rules: [next] })
  return <GroupBox group={root} path={[]} root={root} set={set} ctx={ctx} />
}

function GroupBox({
  group,
  path,
  root,
  set,
  ctx,
}: {
  group: Group
  path: Path
  root: Rule
  set: (r: Rule) => void
  ctx: TreeCtx
}) {
  const isRoot = path.length === 0
  const word = group.type === "all" ? "and" : "or"
  const full = countLeaves(root) >= LIMITS.leaves
  const firstTopic = ctx.topics.find((t) => !t.archived)?.id
  const conj = (type: "all" | "any") => set(updateAt(root, path, (g) => (isGroup(g) ? { ...g, type } : g)))
  return (
    <div className="rg" data-path={pathString(path)} data-od-id={isRoot ? "rule-tree" : "rule-group"}>
      <div className="rg-head">
        {isRoot ? <span className="rg-word">Contacts who match</span> : <span>Group</span>}
        {/* biome-ignore lint/a11y/useSemanticElements: the design's .seg switch is a labelled button group */}
        <div className="seg" role="group" aria-label="Match" data-seg>
          <button type="button" aria-pressed={group.type === "all"} onClick={() => conj("all")}>
            all
          </button>
          <button type="button" aria-pressed={group.type === "any"} onClick={() => conj("any")}>
            any
          </button>
        </div>
        <span>of these</span>
        <span className="grow" />
        {isRoot ? null : (
          <button
            className="icon-btn"
            type="button"
            aria-label="Remove group"
            onClick={() => set(removeAt(root, path))}
          >
            <Icon name="x" />
          </button>
        )}
      </div>
      {group.rules.length === 0 ? (
        <p className="hint" style={{ paddingLeft: 52 }}>
          {isRoot
            ? "No rules yet, so everyone matches. Add a rule to narrow it."
            : "An empty group matches everyone."}
        </p>
      ) : null}
      {group.rules.map((r, i) => {
        const p = [...path, i]
        const ps = pathString(p)
        const c = i === 0 ? "" : word
        if (isGroup(r))
          return (
            <div
              key={ps}
              className="rule"
              style={{ gridTemplateColumns: "44px minmax(0,1fr)" }}
              data-path={ps}
            >
              <span className="conj">{c}</span>
              <GroupBox group={r} path={p} root={root} set={set} ctx={ctx} />
            </div>
          )
        const bad = ctx.error?.path === ps
        return (
          <Fragment key={ps}>
            <LeafRow rule={r} conj={c} path={p} root={root} set={set} ctx={ctx} bad={bad} />
            {bad ? (
              <div className="rule-err" id={ERR_ID} role="alert" data-od-id="rule-error">
                <Icon name="x-circle" />
                <span>
                  {ctx.error?.message} <code className="mono">{ps}</code>
                </span>
              </div>
            ) : null}
          </Fragment>
        )
      })}
      {ctx.error?.path === pathString(path) && group.rules.length ? (
        <div className="rule-err" role="alert">
          <Icon name="x-circle" />
          <span>
            {ctx.error.message} <code className="mono">{pathString(path)}</code>
          </span>
        </div>
      ) : null}
      <div className="rg-add">
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={full}
          onClick={() => set(appendTo(root, path, newLeaf({ kind: "status" })))}
        >
          <Icon name="plus" />
          Rule
        </button>
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          disabled={full || !canNestAt(path)}
          title={canNestAt(path) ? undefined : "Groups nest at most 4 deep."}
          onClick={() =>
            set(
              appendTo(root, path, {
                type: group.type === "all" ? "any" : "all",
                rules: [newLeaf({ kind: "topic" }, firstTopic ? { topicId: firstTopic } : {})],
              }),
            )
          }
        >
          <Icon name="plus" />
          Group
        </button>
        {full ? <span className="hint">50 rules is the most a segment holds.</span> : null}
      </div>
    </div>
  )
}

function LeafRow({
  rule,
  conj,
  path,
  root,
  set,
  ctx,
  bad,
}: {
  rule: Leaf
  conj: string
  path: Path
  root: Rule
  set: (r: Rule) => void
  ctx: TreeCtx
  bad: boolean
}) {
  const put = (next: Leaf) => set(updateAt(root, path, () => next))
  const field = rule.type === "field" ? ctx.fields.find((f) => f.key === rule.field) : undefined
  const ftype: FieldTypeName | undefined =
    field?.type ??
    (rule.type === "field" && (rule.field === "email" || rule.field === "name") ? "string" : undefined)
  const describe = bad ? { "aria-invalid": true as const, "aria-describedby": ERR_ID } : {}
  const subjects: { value: string; label: string }[] = [
    { value: "status", label: "Status" },
    { value: "topic", label: "Topic" },
    { value: "engagement", label: "Engagement" },
    { value: "event", label: "Event" },
    { value: "campaign", label: "Email activity" },
    { value: "field:email", label: "Email address" },
    { value: "field:name", label: "Name" },
    ...ctx.fields.map((f) => ({
      value: `field:${f.key}`,
      label: f.label === f.key ? `Field: ${f.key}` : `Field: ${f.label} (${f.key})`,
    })),
    { value: "created", label: "Created" },
  ]
  const current = subjectKey(subjectOf(rule))
  if (!subjects.some((s) => s.value === current) && rule.type === "field")
    subjects.splice(5, 0, { value: current, label: `Field: ${rule.field}` })
  const onSubject = (v: string) => {
    const s = parseSubject(v)
    const ft = s.kind === "field" ? ctx.fields.find((f) => f.key === s.field)?.type : undefined
    const firstTopic = ctx.topics.find((t) => !t.archived)?.id
    put(newLeaf(s, { ...(firstTopic ? { topicId: firstTopic } : {}), ...(ft ? { fieldType: ft } : {}) }))
  }
  return (
    <div className={`rule${bad ? " is-error" : ""}`} data-path={pathString(path)} {...describe}>
      <span className="conj">{conj}</span>
      <select
        className={`select${bad ? " is-bad" : ""}`}
        aria-label="Rule on"
        value={current}
        onChange={(e) => onSubject(e.target.value)}
      >
        {subjects.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <Comparison rule={rule} put={put} fieldType={ftype} />
      <span className="val">
        <Value rule={rule} put={put} ctx={ctx} fieldType={ftype} bad={bad} />
      </span>
      <button
        className="icon-btn"
        type="button"
        aria-label="Remove rule"
        data-tip="Remove rule"
        onClick={() => set(removeAt(root, path))}
      >
        <Icon name="trash" />
      </button>
    </div>
  )
}

function Comparison({
  rule,
  put,
  fieldType,
}: {
  rule: Leaf
  put: (r: Leaf) => void
  fieldType: FieldTypeName | undefined
}) {
  const sel = (value: string, options: [string, string][], onChange: (v: string) => void) => (
    <select
      className="select"
      aria-label="Comparison"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  )
  switch (rule.type) {
    case "status":
    case "engagement":
      return sel("in", [["in", "is any of"]], () => {})
    case "topic":
      return sel(
        rule.is === false ? "isnt" : "is",
        [
          ["is", "is"],
          ["isnt", "isn’t"],
        ],
        (v) => put(v === "isnt" ? { ...rule, is: false } : setOpt(rule, "is", undefined)),
      )
    case "event":
    case "campaign":
      return sel(
        rule.did === false ? "didnt" : "did",
        [
          ["did", "did"],
          ["didnt", "didn’t"],
        ],
        (v) => put(v === "didnt" ? { ...rule, did: false } : setOpt(rule, "did", undefined)),
      )
    case "created": {
      const mode = rule.withinDays && rule.olderThanDays ? "between" : rule.olderThanDays ? "older" : "within"
      return sel(
        mode,
        [
          ["within", "in the last"],
          ["older", "more than"],
          ["between", "between"],
        ],
        (v) =>
          put(
            v === "within"
              ? { type: "created", withinDays: rule.withinDays ?? rule.olderThanDays ?? 30 }
              : v === "older"
                ? { type: "created", olderThanDays: rule.olderThanDays ?? rule.withinDays ?? 90 }
                : {
                    type: "created",
                    olderThanDays: rule.olderThanDays ?? 30,
                    withinDays: rule.withinDays ?? 90,
                  },
          ),
      )
    }
    case "field": {
      const ops = opsFor(fieldType)
      if (!ops.includes(rule.op)) ops.unshift(rule.op)
      return sel(
        rule.op,
        ops.map((o) => [o, OP_LABEL[o]]),
        (v) => put(withOp(rule, v as FieldOp)),
      )
    }
  }
}

function Days({
  value,
  onChange,
  before = "in the last",
  after = "days",
  emptyWord,
}: {
  value: number | undefined
  onChange: (n: number | undefined) => void
  before?: ReactNode
  after?: ReactNode
  emptyWord?: string
}) {
  return (
    <span className="rule-word">
      {before}{" "}
      <input
        className="input input-num"
        value={value ?? ""}
        aria-label="Days"
        inputMode="numeric"
        placeholder={emptyWord ?? "—"}
        onChange={(e) => onChange(parseDays(e.target.value))}
      />{" "}
      {after}
    </span>
  )
}

function Value({
  rule,
  put,
  ctx,
  fieldType,
  bad,
}: {
  rule: Leaf
  put: (r: Leaf) => void
  ctx: TreeCtx
  fieldType: FieldTypeName | undefined
  bad: boolean
}) {
  switch (rule.type) {
    case "status":
      return (
        <>
          <ValueChips
            label="status"
            values={rule.in}
            choices={STATUSES}
            placeholder="Add"
            invalid={bad}
            onChange={(v) => put({ ...rule, in: v as Status[] })}
          />
          {rule.in.length === 0 ? <span className="vchip-empty">Pick at least one</span> : null}
        </>
      )
    case "engagement":
      return (
        <>
          <ValueChips
            label="engagement"
            values={rule.in}
            choices={ENGAGEMENTS}
            placeholder="Add"
            invalid={bad}
            onChange={(v) => put({ ...rule, in: v as Engagement[] })}
          />
          {rule.in.length === 0 ? <span className="vchip-empty">Pick at least one</span> : null}
        </>
      )
    case "topic":
      return (
        <>
          <select
            className="select"
            aria-label="Topic"
            value={rule.topicId}
            onChange={(e) => put({ ...rule, topicId: e.target.value })}
          >
            {rule.topicId ? null : <option value="">Pick a topic</option>}
            {ctx.topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.archived ? " (archived)" : ""}
              </option>
            ))}
            {rule.topicId && !ctx.topics.some((t) => t.id === rule.topicId) ? (
              <option value={rule.topicId}>{rule.topicId}</option>
            ) : null}
          </select>
          <select
            className="select"
            aria-label="State"
            value={rule.state ?? "subscribed"}
            onChange={(e) => put({ ...rule, state: e.target.value as TopicState })}
          >
            {TOPIC_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </>
      )
    case "event":
      return (
        <>
          <input
            className="input mono"
            value={rule.name}
            aria-label="Event name"
            placeholder="lesson_completed"
            maxLength={100}
            onChange={(e) => put({ ...rule, name: e.target.value })}
          />
          <span className="rule-word">
            at least{" "}
            <input
              className="input input-num"
              value={rule.atLeast ?? ""}
              aria-label="Times"
              inputMode="numeric"
              placeholder="1"
              onChange={(e) => {
                const n = Number(e.target.value)
                put(setOpt(rule, "atLeast", Number.isInteger(n) && n >= 1 && n <= 1000 ? n : undefined))
              }}
            />{" "}
            times
          </span>
          <Days
            value={rule.withinDays}
            emptyWord="ever"
            onChange={(n) => put(setOpt(rule, "withinDays", n))}
          />
        </>
      )
    case "campaign":
      return (
        <>
          <select
            className="select"
            aria-label="Activity"
            value={rule.activity}
            onChange={(e) => {
              const activity = e.target.value as Activity
              put(
                activity === "received"
                  ? setOpt({ ...rule, activity }, "includeMachine", undefined)
                  : { ...rule, activity },
              )
            }}
          >
            {ACTIVITIES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <select
            className="select"
            aria-label="Campaign"
            value={rule.campaignId ?? ""}
            onChange={(e) => put(setOpt(rule, "campaignId", e.target.value || undefined))}
          >
            <option value="">Any campaign</option>
            {ctx.campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {rule.campaignId && !ctx.campaigns.some((c) => c.id === rule.campaignId) ? (
              <option value={rule.campaignId}>{rule.campaignId}</option>
            ) : null}
          </select>
          {rule.withinDays === undefined ? (
            <span className="rule-word">
              ever ·{" "}
              <button
                className="link"
                type="button"
                onClick={() => put({ ...rule, withinDays: 30 })}
                style={{ background: "none", border: 0, padding: 0, cursor: "pointer" }}
              >
                limit
              </button>
            </span>
          ) : (
            <Days
              value={rule.withinDays}
              emptyWord="ever"
              onChange={(n) => put(setOpt(rule, "withinDays", n))}
            />
          )}
          {rule.activity !== "received" ? (
            <label className="rule-word check" style={{ flex: "0 0 auto" }}>
              <input
                type="checkbox"
                checked={rule.includeMachine === true}
                onChange={(e) => put(setOpt(rule, "includeMachine", e.target.checked ? true : undefined))}
              />
              machine {rule.activity === "opened" ? "opens" : "clicks"} count
            </label>
          ) : null}
        </>
      )
    case "created":
      return (
        <>
          {rule.olderThanDays !== undefined && rule.withinDays !== undefined ? (
            <>
              <Days
                value={rule.olderThanDays}
                before=""
                after="and"
                onChange={(n) => put(setOpt(rule, "olderThanDays", n))}
              />
              <Days
                value={rule.withinDays}
                before=""
                after="days ago"
                onChange={(n) => put(setOpt(rule, "withinDays", n))}
              />
            </>
          ) : rule.olderThanDays !== undefined ? (
            <Days
              value={rule.olderThanDays}
              before=""
              after="days ago"
              onChange={(n) => put(setOpt(rule, "olderThanDays", n))}
            />
          ) : (
            <Days
              value={rule.withinDays}
              before=""
              after="days"
              onChange={(n) => put(setOpt(rule, "withinDays", n))}
            />
          )}
        </>
      )
    case "field":
      return <FieldValue rule={rule} put={put} fieldType={fieldType} bad={bad} />
  }
}

function FieldValue({
  rule,
  put,
  fieldType,
  bad,
}: {
  rule: FieldRule
  put: (r: Leaf) => void
  fieldType: FieldTypeName | undefined
  bad: boolean
}) {
  if (!opNeedsValue(rule.op)) return <span className="rule-word">no value needed</span>
  if (rule.op === "in") {
    const values = (Array.isArray(rule.value) ? rule.value : []) as Scalar[]
    return (
      <>
        <ValueChips
          label="Values"
          values={values}
          {...(fieldType ? { fieldType } : {})}
          invalid={bad}
          onChange={(v) => put({ ...rule, value: v })}
        />
        <span className="hint vchip-note">
          {values.length} of 1–50 values{fieldType === "number" ? "" : " · text matches ignore case"}
        </span>
      </>
    )
  }
  const v = Array.isArray(rule.value) ? "" : rule.value
  if (fieldType === "boolean")
    return (
      <select
        className="select"
        aria-label="Value"
        value={v === true ? "true" : v === false ? "false" : ""}
        onChange={(e) => put({ ...rule, value: e.target.value === "true" })}
      >
        <option value="true">yes</option>
        <option value="false">no</option>
      </select>
    )
  return (
    <input
      className={`input${fieldType === "number" ? " num" : ""}`}
      type={fieldType === "date" ? "date" : "text"}
      inputMode={fieldType === "number" ? "decimal" : undefined}
      aria-label="Value"
      value={v === undefined ? "" : String(v)}
      onChange={(e) => put({ ...rule, value: coerce(e.target.value, fieldType) })}
    />
  )
}
