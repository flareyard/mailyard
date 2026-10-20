/** Reads `#token=` once and removes it from the address bar, so a reload or a copied URL doesn't carry it. */
export function takeClaimToken(): string | null {
  if (typeof window === "undefined") return null
  const m = window.location.hash.match(/(?:^#|&)token=([^&]+)/)
  if (!m?.[1]) return null
  window.history.replaceState(null, "", window.location.pathname + window.location.search)
  return decodeURIComponent(m[1])
}
