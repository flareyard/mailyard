/**
 * ⌘K: jump to a screen, run an action, or search the workspace (GET /v1/search, HAL-3363). Results carry the
 * web app route as `url`, so selecting one is a plain navigation. Arrow keys move, Enter opens, Esc closes.
 */
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { api, unwrap } from "../api/client.ts"
import { Icon, type IconName } from "../ui/icons.tsx"
import { SECTIONS } from "./nav.ts"

type Item = {
  id: string
  group: string
  title: string
  sub: string
  icon: IconName
  to: string
  keys?: string[]
}

const TYPE_ICON: Record<string, IconName> = {
  thread: "mail",
  contact: "user",
  campaign: "campaigns",
  template: "transactional",
  mailbox: "mailbox",
  domain: "domains",
}
const ACTIONS: Item[] = [
  {
    id: "a-campaign",
    group: "Actions",
    title: "New campaign",
    sub: "Action",
    icon: "plus",
    to: "/campaigns/new",
  },
  {
    id: "a-domain",
    group: "Actions",
    title: "Add a domain",
    sub: "Action",
    icon: "plus",
    to: "/domains/new",
  },
  {
    id: "a-import",
    group: "Actions",
    title: "Import contacts",
    sub: "Action",
    icon: "upload",
    to: "/audience/import",
  },
]

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms)
    return () => clearTimeout(t)
  }, [v, ms])
  return d
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("")
  const [active, setActive] = useState(0)
  const term = useDebounced(q.trim(), 160)
  const navigate = useNavigate()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])

  const search = useQuery({
    queryKey: ["search", term],
    queryFn: () => unwrap(api.GET("/v1/search", { params: { query: { q: term, limit: "8" } } })),
    enabled: term.length >= 2,
    staleTime: 30_000,
  })

  const items = useMemo<Item[]>(() => {
    const t = q.trim().toLowerCase()
    const jump: Item[] = SECTIONS.filter((s) => !t || s.label.toLowerCase().includes(t)).map((s) => ({
      id: `s-${s.to}`,
      group: "Jump to",
      title: s.label,
      sub: "Screen",
      icon: s.icon,
      to: s.to,
      keys: ["G", s.chord.toUpperCase()],
    }))
    const actions = ACTIONS.filter((a) => !t || a.title.toLowerCase().includes(t))
    const results: Item[] = (search.data?.results ?? []).map((r) => ({
      id: `r-${r.type}-${r.id}`,
      group: "Results",
      title: r.title,
      sub: r.subtitle ?? r.type,
      icon: TYPE_ICON[r.type] ?? "search",
      to: r.url,
    }))
    return [...results, ...jump, ...actions]
  }, [q, search.data])

  const go = (it: Item | undefined) => {
    if (!it) return
    onClose()
    navigate({ to: it.to })
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") onClose()
    else if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((a) => Math.min(items.length - 1, a + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === "Enter") {
      e.preventDefault()
      go(items[active])
    }
  }

  let lastGroup = ""
  return (
    <div
      className="palette-wrap"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onKeyDown={onKey}
    >
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div className="palette" style={{ position: "relative", zIndex: 1 }}>
        <div className="palette-input">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
            }}
            placeholder="Search mail, contacts, campaigns, templates, or type a command"
            aria-label="Search"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `pi-${items[active].id}` : undefined}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-list" id="palette-list" role="listbox">
          {search.isFetching ? (
            <div className="palette-group" role="presentation">
              Searching…
            </div>
          ) : null}
          {items.map((it, i) => {
            const head = it.group !== lastGroup
            lastGroup = it.group
            return (
              <div key={it.id} role="presentation">
                {head ? (
                  <div className="palette-group" role="presentation">
                    {it.group}
                  </div>
                ) : null}
                <a
                  id={`pi-${it.id}`}
                  className="palette-item"
                  role="option"
                  href={it.to}
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onClick={(e) => {
                    e.preventDefault()
                    go(it)
                  }}
                >
                  <span className="pi-icon">
                    <Icon name={it.icon} />
                  </span>
                  <span className="grow">
                    <span className="pi-title">{it.title}</span>
                    <span className="pi-sub">{it.sub}</span>
                  </span>
                  {it.keys ? (
                    <span className="kbd-group">
                      {it.keys.map((k) => (
                        <span key={k} className="kbd">
                          {k}
                        </span>
                      ))}
                    </span>
                  ) : null}
                </a>
              </div>
            )
          })}
          {term.length >= 2 && search.isSuccess && !search.data.results.length ? (
            <div className="palette-group" role="presentation">
              No results for “{term}”
            </div>
          ) : null}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> move
          </span>
          <span>
            <span className="kbd">↵</span> open
          </span>
          <span>
            <span className="kbd">esc</span> close
          </span>
        </div>
      </div>
    </div>
  )
}
