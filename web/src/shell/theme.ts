import { useCallback, useState } from "react"

export type Theme = "system" | "light" | "dark"
const KEY = "mailyard-theme"

/** `data-theme` on <html>, absent means follow the system. index.html applies the stored choice before paint. */
export function useTheme() {
  const [theme, set] = useState<Theme>(() => {
    const t = document.documentElement.dataset.theme
    return t === "light" || t === "dark" ? t : "system"
  })
  const setTheme = useCallback((t: Theme) => {
    if (t === "system") delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = t
    try {
      if (t === "system") localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, t)
    } catch {}
    set(t)
  }, [])
  return { theme, setTheme }
}
