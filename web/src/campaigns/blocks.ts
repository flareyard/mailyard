/**
 * The block document (`bodyBlocks`, the same shape as a blocks template's source, HAL-3430): the palette, a
 * fresh block of each type, and the edits the canvas makes (move, duplicate, delete, insert). Pure, so the
 * editor's behaviour is testable without a browser.
 */
import type { Block, BlocksDoc, BlockType } from "./queries.ts"

export type PaletteGroup = { label: string; items: { type: BlockType; label: string }[] }

export const PALETTE: readonly PaletteGroup[] = [
  {
    label: "Text",
    items: [
      { type: "heading", label: "Heading" },
      { type: "subheading", label: "Subheading" },
      { type: "paragraph", label: "Paragraph" },
      { type: "note", label: "Note" },
      { type: "warn", label: "Warning" },
    ],
  },
  {
    label: "Actions",
    items: [
      { type: "button", label: "Button" },
      { type: "buttons", label: "Buttons" },
    ],
  },
  {
    label: "Data",
    items: [
      { type: "list", label: "List" },
      { type: "steps", label: "Steps" },
      { type: "stats", label: "Stats" },
      { type: "meta", label: "Details" },
      { type: "receipt", label: "Receipt" },
      { type: "progress", label: "Progress" },
    ],
  },
  {
    label: "More",
    items: [
      { type: "question", label: "Question" },
      { type: "feedback", label: "Feedback" },
      { type: "file", label: "File" },
      { type: "otp", label: "Code" },
      { type: "html", label: "HTML" },
    ],
  },
]

export const BLOCK_LABEL: Record<BlockType, string> = Object.fromEntries(
  PALETTE.flatMap((g) => g.items.map((i) => [i.type, i.label])),
) as Record<BlockType, string>

export function newBlock(type: BlockType): Block {
  switch (type) {
    case "heading":
      return { type, text: "A heading" }
    case "subheading":
      return { type, text: "A subheading" }
    case "paragraph":
      return { type, text: "Write something here." }
    case "note":
      return { type, text: "A note, in a quieter voice." }
    case "warn":
      return { type, text: "Something to watch out for." }
    case "button":
      return { type, label: "Open it", url: "https://", style: "primary" }
    case "buttons":
      return {
        type,
        items: [
          { label: "Yes", url: "https://", style: "primary" },
          { label: "Not now", url: "https://", style: "ghost" },
        ],
      }
    case "stats":
      return {
        type,
        items: [
          { label: "Lessons", value: "12" },
          { label: "Hours", value: "6" },
        ],
      }
    case "list":
      return { type, items: [{ title: "First item", sub: "A line about it" }] }
    case "steps":
      return { type, items: [{ title: "First step" }, { title: "Second step" }] }
    case "meta":
      return { type, items: [{ label: "When", value: "3 November" }] }
    case "receipt":
      return {
        type,
        lines: [{ label: "Course", value: "$49.00" }],
        total: { label: "Total", value: "$49.00" },
      }
    case "otp":
      return { type, code: "123456" }
    case "progress":
      return { type, stages: ["Signed up", "Started", "Finished"], done: 1 }
    case "feedback":
      return {
        type,
        label: "Feedback",
        question: "How was this email?",
        answers: [
          { label: "Useful", url: "https://" },
          { label: "Not for me", url: "https://" },
        ],
      }
    case "file":
      return { type, tag: "PDF", name: "syllabus.pdf", sub: "1.2 MB" }
    case "question":
      return {
        type,
        label: "Quick question",
        stem: "Which topic should we cover next?",
        answers: [
          { label: "SQL", url: "https://" },
          { label: "Charts", url: "https://" },
        ],
      }
    case "html":
      return { type, html: "<p>Your own HTML</p>" }
  }
}

export const emptyDoc = (): BlocksDoc => ({
  preheader: "",
  label: "",
  blocks: [newBlock("heading"), newBlock("paragraph")],
  footer: { reason: "You’re getting this because you subscribed at our site." },
})

export function moveBlock(blocks: readonly Block[], i: number, by: -1 | 1): Block[] {
  const j = i + by
  if (i < 0 || j < 0 || i >= blocks.length || j >= blocks.length) return [...blocks]
  const out = [...blocks]
  const a = out[i] as Block
  out[i] = out[j] as Block
  out[j] = a
  return out
}

export function duplicateBlock(blocks: readonly Block[], i: number): Block[] {
  const b = blocks[i]
  if (!b) return [...blocks]
  return [...blocks.slice(0, i + 1), structuredClone(b), ...blocks.slice(i + 1)]
}

export function removeBlock(blocks: readonly Block[], i: number): Block[] {
  return blocks.filter((_, k) => k !== i)
}

export function insertBlock(blocks: readonly Block[], at: number, b: Block): Block[] {
  const k = Math.max(0, Math.min(at, blocks.length))
  return [...blocks.slice(0, k), b, ...blocks.slice(k)]
}

export function updateBlock(blocks: readonly Block[], i: number, b: Block): Block[] {
  return blocks.map((x, k) => (k === i ? b : x))
}

/** Every string in a document, for finding the merge fields it uses. */
export function docTexts(doc: BlocksDoc | null | undefined): string[] {
  if (!doc) return []
  const out: string[] = [doc.preheader, doc.label, doc.footer.reason]
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v).forEach(walk)
  }
  walk(doc.blocks)
  return out
}

/** Applies a text transform to every string in a document (used to rewrite a fallback everywhere). */
export function mapDocTexts(doc: BlocksDoc, fn: (s: string) => string): BlocksDoc {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fn(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, k === "type" || k === "style" || k === "url" ? x : walk(x)]),
      )
    return v
  }
  return {
    ...doc,
    preheader: fn(doc.preheader),
    label: fn(doc.label),
    footer: { ...doc.footer, reason: fn(doc.footer.reason) },
    blocks: walk(doc.blocks) as Block[],
  }
}
