/**
 * The graph canvas (HANDOFF-audience §4 "Canvas", "Node", "Edge"; §7 keyboard). Plain HTML and CSS: nested
 * flex columns from `layoutGraph`, nodes as buttons so Tab reaches every step and Enter opens it. `+`, `−`
 * and `0` zoom and fit, arrow keys pan the canvas's own scroll box, Esc closes the inspector. On a tablet the
 * canvas pans by touch inside its box and targets grow to 44 px; on a phone the read-only `Outline` replaces it.
 */
import { type KeyboardEvent, type ReactNode, type RefObject, useCallback } from "react"
import { Icon, type IconName } from "../ui/icons.tsx"
import {
  type Counts,
  countChips,
  describeNode,
  type FlowItem,
  type GNode,
  type Issue,
  type Layout,
  type Names,
  type NodeType,
  type Overlay,
  outlineTitle,
  type Port,
} from "./logic.ts"

export const NODE_ICON: Record<NodeType, IconName> = {
  trigger: "zap",
  wait: "clock",
  wait_until: "calendar",
  wait_event: "bell",
  branch: "updown",
  send: "envelope",
  update: "pencil",
  topic: "tag",
  webhook: "webhook",
  exit: "logout",
}

export const ZOOM_MIN = 0.5
export const ZOOM_MAX = 1.5
export const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10

type CanvasProps = {
  layout: Layout
  names: Names
  selected: string | null
  onSelect: (id: string | null) => void
  issues: Map<string, Issue[]>
  counts: Counts
  overlay: Overlay | null
  editable: boolean
  redacted: boolean
  onInsert: (from: string, port: Port | undefined) => void
  zoom: number
  onZoom: (z: number | "fit") => void
  canvasRef: RefObject<HTMLElement | null>
  innerRef: RefObject<HTMLDivElement | null>
  legend?: ReactNode
}

export function Canvas(p: CanvasProps) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const t = e.target as HTMLElement
      if (t.closest("input, textarea, select")) return
      if (e.key === "+" || e.key === "=") {
        e.preventDefault()
        p.onZoom(clampZoom(p.zoom + 0.1))
      } else if (e.key === "-" || e.key === "−" || e.key === "_") {
        e.preventDefault()
        p.onZoom(clampZoom(p.zoom - 0.1))
      } else if (e.key === "0") {
        e.preventDefault()
        p.onZoom("fit")
      } else if (e.key === "Escape") {
        if (p.selected) {
          e.preventDefault()
          p.onSelect(null)
        }
      } else if (e.key.startsWith("Arrow") && t === p.canvasRef.current) {
        e.preventDefault()
        const d = 48
        p.canvasRef.current?.scrollBy({
          left: e.key === "ArrowLeft" ? -d : e.key === "ArrowRight" ? d : 0,
          top: e.key === "ArrowUp" ? -d : e.key === "ArrowDown" ? d : 0,
        })
      }
    },
    [p],
  )
  return (
    <section
      className="canvas"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas is a scroll region that takes keys (zoom, pan)
      tabIndex={0}
      ref={p.canvasRef}
      aria-label="Automation graph. Arrow keys pan, plus and minus zoom, 0 fits."
      data-od-id="automation-canvas"
      data-endpoint="GET /v1/automations/{id} · graph, counts"
      onKeyDown={onKeyDown}
    >
      <div className="canvas-inner" ref={p.innerRef} style={{ zoom: p.zoom }} data-zoom={p.zoom}>
        <div className="stack" style={{ ["--gap" as string]: "40px", alignItems: "center" }}>
          <Flow items={p.layout.main} c={p} />
          {p.layout.orphans.map((items, i) => (
            <div
              key={orphanKey(items, i)}
              className="stack"
              style={{ ["--gap" as string]: "8px", alignItems: "center" }}
            >
              <span className="lane-tag">Not connected</span>
              <Flow items={items} c={p} orphan />
            </div>
          ))}
        </div>
      </div>
      {p.legend}
    </section>
  )
}

function Flow({ items, c, orphan }: { items: FlowItem[]; c: CanvasProps; orphan?: boolean | undefined }) {
  const out: ReactNode[] = []
  items.forEach((it, i) => {
    if (i > 0) {
      if (it.kind === "fork")
        out.push(<div key={`e-${it.from}`} className={`edge${edgePath(c, it.from, null)}`} />)
      else
        out.push(
          <Edge
            key={`e-${it.from}-${it.port ?? ""}`}
            c={c}
            from={it.from}
            port={it.port}
            to={it.kind === "node" ? it.node.id : null}
          />,
        )
    }
    if (it.kind === "node") out.push(<NodeView key={it.node.id} node={it.node} c={c} orphan={orphan} />)
    else if (it.kind === "fork")
      out.push(
        <div key={`f${it.from}`} className="fork">
          {it.lanes.map((l) => (
            <div key={l.port} className={`lane${laneCls(c, it.from, l.port)}`}>
              <span className="lane-tag">{l.label}</span>
              <Flow items={l.items} c={c} orphan={orphan} />
            </div>
          ))}
        </div>,
      )
    else if (it.kind === "open")
      out.push(
        <div
          key={`o-${it.from}-${it.port ?? ""}`}
          className="node node-end is-invalid"
          role="img"
          aria-label="Not connected"
        >
          <span className="node-ic">
            <Icon name="warn" />
          </span>
          <span className="node-title">Not connected</span>
        </div>,
      )
    else if (it.kind === "ref")
      out.push(
        <button
          key={`r-${it.from}-${it.port ?? ""}`}
          type="button"
          className="node node-end"
          style={{ cursor: "pointer" }}
          onClick={() => c.onSelect(it.to.id)}
          aria-label={`Continues at ${describeNode(it.to, c.names).title}`}
        >
          <span className="node-ic">
            <Icon name="arrow-right" />
          </span>
          <span className="node-title">Continues at {describeNode(it.to, c.names).title}</span>
        </button>,
      )
  })
  return <div className="flow">{out}</div>
}

function edgePath(c: CanvasProps, from: string | null, to: string | null): string {
  if (!c.overlay || !from) return ""
  const onPath = c.overlay.order.has(from) && (to === null || c.overlay.order.has(to))
  return onPath ? " is-path" : " is-off"
}

function laneCls(c: CanvasProps, from: string, port: Port): string {
  if (!c.overlay) return ""
  return c.overlay.ports.has(`${from}:${port}`) ? " is-path" : " is-off"
}

function Edge({
  c,
  from,
  port,
  to,
}: {
  c: CanvasProps
  from: string | null
  port: Port | undefined
  to: string | null
}) {
  const cls = `edge${edgePath(c, from, to)}`
  if (!c.editable || !from || c.overlay) return <div className={cls} />
  return (
    <div className={cls}>
      <button
        className="edge-add"
        type="button"
        aria-label="Add a step here"
        data-tip="Add a step here"
        onClick={() => c.onInsert(from, port)}
      >
        <Icon name="plus" />
      </button>
    </div>
  )
}

function NodeView({ node, c, orphan }: { node: GNode; c: CanvasProps; orphan?: boolean | undefined }) {
  const d = describeNode(node, c.names)
  const issues = c.issues.get(node.id) ?? []
  const unreachable = orphan || issues.some((i) => i.code === "unreachable")
  const step = c.overlay?.order.get(node.id)
  const sel = c.selected === node.id
  if (node.type === "exit") {
    const cls = [
      "node node-end",
      step ? "is-path" : c.overlay ? "is-off" : "",
      sel ? "is-selected" : "",
      unreachable ? "is-unreachable" : "",
    ]
      .filter(Boolean)
      .join(" ")
    return (
      <button
        type="button"
        className={cls}
        data-node={node.id}
        aria-pressed={sel}
        aria-label={`Exit${node.label ? `: ${node.label}` : ""}`}
        onClick={() => c.onSelect(node.id)}
      >
        <span className="node-ic">
          <Icon name={NODE_ICON.exit} />
        </span>
        <span className="node-title">{node.label ?? "Exit"}</span>
      </button>
    )
  }
  const cls = [
    "node",
    node.type === "trigger" ? "is-trigger" : "",
    sel ? "is-selected" : "",
    issues.length && !unreachable ? "is-invalid" : "",
    unreachable ? "is-unreachable" : "",
    c.overlay && step && !c.overlay.skipped.has(node.id) && !c.overlay.failed.has(node.id) ? "is-path" : "",
    c.overlay && !step ? "is-off" : "",
    c.overlay?.failed.has(node.id) ? "is-failed" : "",
    c.overlay?.skipped.has(node.id) ? "is-skipped" : "",
  ]
    .filter(Boolean)
    .join(" ")
  const hidden = c.redacted && node.type === "webhook" && node.config.url.includes("•••")
  return (
    <button
      className={cls}
      type="button"
      data-node={node.id}
      data-od-id={`node-${node.id}`}
      aria-pressed={sel}
      onClick={() => c.onSelect(node.id)}
    >
      {step ? <span className="node-step">{step}</span> : null}
      <span className="node-top">
        <span className="node-ic">
          <Icon name={NODE_ICON[node.type]} />
        </span>
        <span className="grow">
          <span className="node-kind">{d.kind}</span>
          <span className="node-title" style={{ display: "block" }}>
            {d.title}
          </span>
        </span>
      </span>
      <span className="node-meta">
        <MonoMeta meta={d.meta} mono={d.mono} />
      </span>
      {hidden ? (
        <span className="node-lock">
          <Icon name="lock" />
          URL hidden for your key
        </span>
      ) : null}
      {issues.map((i) => (
        <span key={`${i.code}-${i.message}`} className="node-issue">
          <Icon name={unreachable ? "warn" : "x-circle"} />
          <span>{i.message}</span>
        </span>
      ))}
      <span className="node-counts">
        {c.overlay?.skipped.has(node.id) ? (
          <span className="ncount is-skip">
            Skipped{c.overlay.why.get(node.id) ? ` · no ${c.overlay.why.get(node.id)}` : ""}
          </span>
        ) : c.overlay?.failed.has(node.id) ? (
          <span className="ncount is-fail">Failed here</span>
        ) : c.overlay && !step ? (
          <span className="ncount">Not taken</span>
        ) : (
          countChips(c.counts[node.id]).map((x) => (
            <span key={x.text} className={x.cls}>
              {x.text}
            </span>
          ))
        )}
      </span>
    </button>
  )
}

function orphanKey(items: FlowItem[], i: number): string {
  const first = items[0]
  return first?.kind === "node" ? first.node.id : `orphan-${i}`
}

/** A node's detail line with its id, event or URL in mono (HANDOFF §6: mono is for those only). */
export function MonoMeta({ meta, mono }: { meta: string; mono?: string | undefined }) {
  const i = mono ? meta.indexOf(mono) : -1
  if (!mono || i < 0) return <>{meta}</>
  return (
    <>
      {meta.slice(0, i)}
      <span className="mono">{mono}</span>
      {meta.slice(i + mono.length)}
    </>
  )
}

/** The read-only graph on a phone (`ol.outline`), the same walk as the canvas. */
export function Outline({
  items,
  names,
  counts,
  issues,
}: {
  items: FlowItem[]
  names: Names
  counts: Counts
  issues: Map<string, Issue[]>
}) {
  return <ol className="outline">{outlineItems(items, names, counts, issues)}</ol>
}

function outlineItems(
  items: FlowItem[],
  names: Names,
  counts: Counts,
  issues: Map<string, Issue[]>,
): ReactNode[] {
  const out: ReactNode[] = []
  items.forEach((it) => {
    if (it.kind === "node") {
      const n = it.node
      const chips = countChips(counts[n.id])
      const iss = issues.get(n.id) ?? []
      out.push(
        <li key={n.id}>
          <span className="o-ic">
            <Icon name={NODE_ICON[n.type]} />
          </span>
          <span className="o-t">{outlineTitle(n, names)}</span>
          {iss.length ? (
            <span className="o-s" style={{ color: "var(--red-900)" }}>
              <Icon name="x-circle" /> {iss.map((x) => x.message).join(" ")}
            </span>
          ) : chips.length && n.type !== "exit" ? (
            <span className="o-s">{chips.map((c) => c.text).join(" · ")}</span>
          ) : null}
        </li>,
      )
    } else if (it.kind === "fork") {
      for (const l of it.lanes)
        out.push(
          <li key={`${it.from}-${l.port}`}>
            <span className="o-branch" style={{ gridColumn: 2 }}>
              {l.label}
            </span>
            <ul>{outlineItems(l.items, names, counts, issues)}</ul>
          </li>,
        )
    } else if (it.kind === "open") {
      out.push(
        <li key={`o-${it.from}-${it.port ?? ""}`}>
          <span className="o-ic">
            <Icon name="warn" />
          </span>
          <span className="o-t">Not connected</span>
        </li>,
      )
    } else {
      out.push(
        <li key={`r-${it.from}-${it.port ?? ""}`}>
          <span className="o-ic">
            <Icon name="arrow-right" />
          </span>
          <span className="o-t">Continues at {describeNode(it.to, names).title}</span>
        </li>,
      )
    }
  })
  return out
}
