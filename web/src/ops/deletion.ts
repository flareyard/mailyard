/**
 * A workspace being deleted (HAL-3448): while its 7 days run, every API response carries
 * `x-workspace-deleting: <deletesAt ISO>`. The client's middleware feeds each response here, and the shell's
 * banner reads it, so the countdown costs no extra request.
 *
 * In fixture mode no response carries the header, so the deletion is simulated: `?deleting=1` (or the fixture
 * DELETE /v1/workspace) starts it, `?deleting=0` (or the fixture restore) ends it. It sticks for the tab.
 */
import { useSyncExternalStore } from "react"
import { fixturesEnabled } from "../fixtures/mode.ts"

const KEY = "mailyard-fixture-deleting"
const DAY = 86_400_000
let deletesAt: number | null = null
const listeners = new Set<() => void>()

function set(next: number | null) {
  if (next === deletesAt) return
  deletesAt = next
  for (const l of listeners) l()
}

/** The deletion time a response announces, or null when it says nothing. Pure, for tests. */
export function parseDeletingHeader(v: string | null): number | null {
  if (!v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

let seenSearch: string | null = null

function fixtureDeletesAt(): number | null {
  if (typeof window === "undefined") return null
  // The query only acts when the URL changes, so a restore isn't undone by the next response on the same page.
  const search = window.location.search
  const q = search === seenSearch ? null : new URLSearchParams(search).get("deleting")
  seenSearch = search
  try {
    if (q === "1" && !sessionStorage.getItem(KEY))
      sessionStorage.setItem(KEY, String(Date.now() + 7 * DAY - 3_600_000))
    if (q === "0") sessionStorage.removeItem(KEY)
    const v = Number(sessionStorage.getItem(KEY))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return q === "1" ? Date.now() + 7 * DAY : deletesAt
  }
}

/** Called by the API client for every response from Mailyard. */
export function noteResponse(response: Response) {
  if (fixturesEnabled()) {
    set(fixtureDeletesAt())
    return
  }
  // Only a successful or refused API answer speaks for the workspace; a network error page doesn't.
  if (!response.headers.get("content-type")?.includes("json") && response.status !== 204) return
  set(parseDeletingHeader(response.headers.get("x-workspace-deleting")))
}

/** For the fixture DELETE /v1/workspace and restore overrides, and for tests. */
export function setFixtureDeleting(at: number | null) {
  try {
    if (at) sessionStorage.setItem(KEY, String(at))
    else sessionStorage.removeItem(KEY)
  } catch {}
  set(at)
}

/** Forces the known state, after a delete (202) or a restore. */
export const setDeleting = set

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** When the workspace will be deleted, or null when it isn't being deleted. */
export function useDeleting(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => deletesAt,
    () => null,
  )
}

/** Test seams: the store's value and a subscription, without rendering a component. */
export const peekForTests = () => deletesAt
export const subscribeForTests = subscribe
