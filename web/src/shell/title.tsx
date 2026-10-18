/**
 * The top bar's title. Routes give a default through `staticData.title`; a page that shows something else under
 * the same URL (the first-run checklist at `/`) overrides it with `usePageTitle`.
 */
import { createContext, useContext, useEffect } from "react"

export const PageTitleContext = createContext<(t: string | null) => void>(() => {})

export function usePageTitle(title: string) {
  const set = useContext(PageTitleContext)
  useEffect(() => {
    set(title)
    return () => set(null)
  }, [set, title])
}
