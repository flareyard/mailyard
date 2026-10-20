/**
 * A menu that opens under its trigger (`.menu`, `.chip-menu`): closes on a click outside, on Escape (focus goes
 * back to the trigger) and on Tab out of it.
 */
import { useEffect, useRef, useState } from "react"

export function usePopover<T extends HTMLElement = HTMLElement>() {
  const [open, setOpen] = useState(false)
  const anchor = useRef<T>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false)
        trigger.current?.focus()
      }
    }
    const onFocus = (e: FocusEvent) => {
      if (anchor.current && e.target instanceof Node && !anchor.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener("mousedown", onDoc)
    document.addEventListener("keydown", onKey)
    document.addEventListener("focusin", onFocus)
    return () => {
      document.removeEventListener("mousedown", onDoc)
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("focusin", onFocus)
    }
  }, [open])
  return { open, setOpen, anchor, trigger, toggle: () => setOpen((v) => !v) }
}
