/**
 * `?focus=<id>` (a check's fix, HAL-3430): lands on the field it names, scrolled into view, focused and ringed
 * for a moment, opening the `<details>` it sits in.
 */
import { useEffect } from "react"

export function useFocusParam(id: string | undefined) {
  useEffect(() => {
    if (!id) return
    let ring: ReturnType<typeof setTimeout> | undefined
    // Wait a frame so the step has rendered its fields.
    const t = setTimeout(() => {
      const el = document.getElementById(id)
      if (!el) return
      const details = el.closest("details")
      if (details && !details.open) details.open = true
      el.scrollIntoView({ block: "center" })
      if (el.tabIndex < 0 && !/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName))
        el.setAttribute("tabindex", "-1")
      el.focus({ preventScroll: true })
      el.classList.add("is-focus-target")
      ring = setTimeout(() => el.classList.remove("is-focus-target"), 2500)
    }, 60)
    return () => {
      clearTimeout(t)
      if (ring) clearTimeout(ring)
    }
  }, [id])
}
