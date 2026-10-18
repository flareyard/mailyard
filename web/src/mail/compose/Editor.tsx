/**
 * The message body: a `contenteditable` `.compose-body` with the design's formatting bar (bold, link,
 * bulleted and numbered lists, quote), templates from `GET /v1/templates` rendered with
 * `POST /v1/templates/{id}/render`, and Draft with AI shown but off until HAL-3305 ships.
 */
import { useQuery } from "@tanstack/react-query"
import { forwardRef, type ReactNode, useEffect, useImperativeHandle, useRef, useState } from "react"
import { api, unwrap } from "../../api/client.ts"
import { useCapabilities } from "../../auth/capabilities.ts"
import { Gated } from "../../auth/NoPermission.tsx"
import { fixturesEnabled } from "../../fixtures/mode.ts"
import { Icon } from "../../ui/icons.tsx"
import { toast } from "../toasts.tsx"
import { CIcon } from "./icons.tsx"
import { sanitizeHtml, textToHtml } from "./logic.ts"
import { Menu, useMenu } from "./Menus.tsx"

export type EditorHandle = {
  focus: () => void
  html: () => string
  text: () => string
  insertText: (t: string) => void
}

type Props = {
  label: string
  initialHtml: string
  onInput: () => void
  /** The signature and the quoted original, shown under what you write (not editable here). */
  after?: ReactNode
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  onTemplateSubject?: (subject: string) => void
  autoFocus?: boolean
  /** For Draft with AI: which mailbox and thread the draft is for. */
  aiContext?: { mailboxId: string; threadId?: string }
}

const exec = (cmd: string, value?: string) => {
  // execCommand is deprecated but is still the only editing primitive every browser ships for
  // contenteditable; the result is sanitised to the toolbar's tags on every read.
  document.execCommand(cmd, false, value)
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor(
  { label, initialHtml, onInput, after, onKeyDown, onTemplateSubject, autoFocus, aiContext },
  ref,
) {
  const el = useRef<HTMLDivElement>(null)
  const seeded = useRef(false)
  useEffect(() => {
    if (!el.current || seeded.current) return
    el.current.innerHTML = sanitizeHtml(initialHtml)
    seeded.current = true
    if (autoFocus) el.current.focus()
  }, [initialHtml, autoFocus])
  useImperativeHandle(ref, () => ({
    focus: () => el.current?.focus(),
    html: () => sanitizeHtml(el.current?.innerHTML ?? ""),
    text: () => (el.current?.innerText ?? "").replace(/ /g, " ").replace(/\n{3,}/g, "\n\n"),
    insertText: (t: string) => {
      el.current?.focus()
      exec("insertHTML", textToHtml(t))
      onInput()
    },
  }))
  const tool = (
    cmd: string,
    icon: ReactNode,
    text: string,
    key?: string,
    value?: () => string | undefined,
  ) => (
    <button
      className="icon-btn"
      type="button"
      aria-label={text}
      title={key ? `${text} · ${key}` : text}
      {...(key ? { "aria-keyshortcuts": key.replace("⌘ ", "Meta+") } : {})}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const v = value?.()
        if (value && v === undefined) return
        exec(cmd, v)
        onInput()
      }}
    >
      {icon}
    </button>
  )
  const askLink = () => {
    const url = window.prompt("Link to (https://…)")
    if (!url) return undefined
    return /^(https?:|mailto:)/i.test(url) ? url : `https://${url}`
  }
  return (
    <>
      <div className="ed-tools" role="toolbar" aria-label="Formatting">
        {tool("bold", <CIcon name="bold" />, "Bold", "⌘ B")}
        {tool("createLink", <Icon name="link" />, "Link", "⌘ K", askLink)}
        {tool("insertUnorderedList", <Icon name="list" />, "Bulleted list")}
        {tool("insertOrderedList", <CIcon name="list-ordered" />, "Numbered list")}
        {tool("formatBlock", <CIcon name="quote" />, "Quote", undefined, () => "blockquote")}
        <span className="vdivider" aria-hidden="true" />
        <TemplateMenu
          onPick={(r) => {
            el.current?.focus()
            exec("insertHTML", textToHtml(r.text))
            if (r.subject && onTemplateSubject) onTemplateSubject(r.subject)
            onInput()
          }}
        />
        <AiDraft
          {...(aiContext ? { ctx: aiContext } : {})}
          onInsert={(t) => {
            el.current?.focus()
            exec("insertHTML", textToHtml(t))
            onInput()
          }}
        />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a rich-text body; the design's contenteditable .compose-body */}
      <div
        ref={el}
        className="compose-body"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        aria-multiline="true"
        aria-label={label}
        onInput={onInput}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
            e.preventDefault()
            exec("bold")
            onInput()
          } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
            e.preventDefault()
            e.stopPropagation()
            const v = askLink()
            if (v) {
              exec("createLink", v)
              onInput()
            }
          }
          onKeyDown?.(e)
        }}
        onPaste={(e) => {
          // Pasted rich text keeps only what the toolbar can make.
          const html = e.clipboardData.getData("text/html")
          if (!html) return
          e.preventDefault()
          exec("insertHTML", sanitizeHtml(html))
          onInput()
        }}
      />
      {after}
    </>
  )
})

function TemplateMenu({ onPick }: { onPick: (r: { subject: string; text: string }) => void }) {
  const { open, setOpen, ref } = useMenu()
  const [busy, setBusy] = useState<string | null>(null)
  const list = useQuery({
    queryKey: ["templates", "compose"],
    queryFn: () => unwrap(api.GET("/v1/templates", { params: { query: { archived: "false" } } })),
    enabled: open,
    staleTime: 5 * 60_000,
  })
  const usable = (list.data?.templates ?? []).filter((t) => t.publishedVersion !== null)
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-endpoint="GET /v1/templates · POST /v1/templates/{id}/render"
        onClick={() => setOpen(!open)}
      >
        Template
      </button>
      {open ? (
        <Menu id="template-menu" label="Insert a template" style={{ left: 0, top: "calc(100% + 4px)" }}>
          <div className="menu-label">Insert a published template’s text</div>
          {list.isPending ? <div className="menu-note">Loading templates…</div> : null}
          {list.isError ? (
            <div className="menu-note">Templates didn’t load. Try again in a moment.</div>
          ) : null}
          {list.isSuccess && !usable.length ? (
            <div className="menu-note">No published templates yet. Publish one in Transactional.</div>
          ) : null}
          {usable.map((t) => (
            <button
              key={t.id}
              className="menu-item"
              type="button"
              role="menuitem"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(t.id)
                try {
                  const r = await unwrap(
                    api.POST("/v1/templates/{id}/render", {
                      params: { path: { id: t.id } },
                      body: { version: "published" },
                    }),
                  )
                  onPick({ subject: r.subject, text: r.text })
                  if (r.variables.missing.length)
                    toast({
                      title: `Fill in ${r.variables.missing.join(", ")}`,
                      sub: "The template uses them and they have no value here.",
                    })
                  setOpen(false)
                } catch {
                  toast({ title: `“${t.name}” didn’t render`, tone: "error" })
                } finally {
                  setBusy(null)
                }
              }}
            >
              <span className="grow">{t.name}</span>
              {busy === t.id ? <span className="spinner" role="img" aria-label="Rendering" /> : null}
            </button>
          ))}
        </Menu>
      ) : null}
    </div>
  )
}

/**
 * Draft with AI (`POST /v1/ai/draft`, HAL-3305): visible, off with the reason until the route deploys. The
 * route isn't in the schema yet, so the call uses the shape GAPS-mail M5.8 agreed and reads it defensively.
 */
function AiDraft({
  ctx,
  onInsert,
}: {
  ctx?: { mailboxId: string; threadId?: string }
  onInsert: (text: string) => void
}) {
  const caps = useCapabilities()
  const live = !fixturesEnabled() && caps.has("post", "/v1/ai/draft") && Boolean(ctx)
  const [busy, setBusy] = useState(false)
  return (
    <Gated
      allowed={live}
      reason="Draft with AI isn’t built yet"
      who="It arrives with HAL-3305 (Workers AI on your account)."
    >
      <button
        className="btn btn-ghost btn-sm"
        type="button"
        disabled={busy}
        data-endpoint="POST /v1/ai/draft (planned, HAL-3305)"
        onClick={async () => {
          if (!ctx) return
          const instruction = window.prompt("What should the draft say?")
          if (!instruction) return
          setBusy(true)
          try {
            const r = await fetch("/v1/ai/draft", {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...ctx, instruction }),
            })
            const body = (await r.json()) as { bodyText?: string; message?: string }
            if (!r.ok || typeof body.bodyText !== "string")
              throw new Error(body.message ?? `The API answered ${r.status}`)
            onInsert(body.bodyText)
          } catch (e) {
            toast({ title: "No draft came back", sub: (e as Error).message, tone: "error" })
          } finally {
            setBusy(false)
          }
        }}
      >
        Draft with AI
      </button>
    </Gated>
  )
}
