/**
 * The campaign being edited, shared by the five steps (HAL-3428). Edits live here, above the step routes, so
 * moving between Content, Audience, Preview, Checks and Schedule keeps them. They save on their own a moment
 * after you stop typing, and every PATCH carries `ifMatch` with the `updatedAt` the edits were made on: a
 * `409 { reason: "stale" }` stops saving and shows the conflict panel, and nothing is ever retried over it.
 * A 400 marks the string its `field` names (HAL-3433) and waits for the next edit.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ApiError, api, unwrap } from "../../api/client.ts"
import { isEditable, staleRefusal } from "../logic.ts"
import { type Campaign, campaignQuery, type Patch } from "../queries.ts"

export type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict"
export type Conflict = {
  message: string
  updatedAt: number | null
  updatedBy: string | null
  requestId?: string | undefined
}

type Edits = Partial<Omit<Patch, "ifMatch">>

type Ctx = {
  id: string
  /** The campaign as the server has it. */
  server: Campaign
  /** What the editor shows: the server's campaign with the unsaved edits on top. */
  draft: Campaign
  edits: Edits
  editable: boolean
  set: (patch: Edits) => void
  state: SaveState
  error: ApiError | null
  conflict: Conflict | null
  /** Saves now; resolves true when everything is saved. */
  flush: () => Promise<boolean>
  /** Drops the edits and loads what the other save left. */
  reloadTheirs: () => Promise<void>
  /** The `updatedAt` the edits were made on (sent as `ifMatch`). */
  baseUpdatedAt: number | null
  savedAt: number | null
  /** Content of body modes not in use, kept in this tab until saved (HANDOFF: "switching keeps the others"). */
  stash: Stash
  setStash: (s: Stash) => void
}

export type Stash = { blocks?: Campaign["bodyBlocks"]; html?: string | null; templateId?: string | null }

const EditorCtx = createContext<Ctx | null>(null)

export function useEditor(): Ctx {
  const c = useContext(EditorCtx)
  if (!c) throw new Error("useEditor outside CampaignEditorProvider")
  return c
}

/** The editor, when there is one (the sending view and report render without it). */
export const useMaybeEditor = () => useContext(EditorCtx)

const AUTOSAVE_MS = 1200

const isCampaign = (v: unknown): v is Campaign =>
  Boolean(v && typeof v === "object" && "id" in v && "status" in v && !("_tag" in v))

export function CampaignEditorProvider({ campaign, children }: { campaign: Campaign; children: ReactNode }) {
  const qc = useQueryClient()
  const id = campaign.id
  const [edits, setEdits] = useState<Edits>({})
  const [base, setBase] = useState<number | null>(
    campaign.updatedAt === null ? null : Number(campaign.updatedAt),
  )
  const [state, setState] = useState<SaveState>("saved")
  const [error, setError] = useState<ApiError | null>(null)
  const [conflict, setConflict] = useState<Conflict | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [stash, setStash] = useState<Stash>({})
  const editsRef = useRef(edits)
  editsRef.current = edits
  const baseRef = useRef(base)
  baseRef.current = base
  const inFlight = useRef<Promise<boolean> | null>(null)
  const editable = isEditable(campaign.status)

  // With nothing unsaved, follow the server (another tab's save, a refetch on focus).
  useEffect(() => {
    if (Object.keys(editsRef.current).length === 0 && !conflict)
      setBase(campaign.updatedAt === null ? null : Number(campaign.updatedAt))
  }, [campaign.updatedAt, conflict])

  const save = useCallback(async (): Promise<boolean> => {
    if (inFlight.current) await inFlight.current
    const sent = editsRef.current
    if (Object.keys(sent).length === 0) return true
    const run = (async () => {
      setState("saving")
      try {
        const res = await unwrap(
          api.PATCH("/v1/campaigns/{id}", {
            params: { path: { id } },
            body: { ...sent, ifMatch: baseRef.current },
          }),
        )
        if (!isCampaign(res)) throw new ApiError(400, (res ?? {}) as ApiError["body"])
        qc.setQueryData(campaignQuery(id).queryKey, res)
        qc.invalidateQueries({ queryKey: ["campaigns", "list"] })
        qc.invalidateQueries({ queryKey: ["campaigns", id], exact: false, refetchType: "none" })
        setBase(res.updatedAt === null ? null : Number(res.updatedAt))
        // Keep anything typed while the save was in flight.
        const cur = editsRef.current
        const next: Edits = { ...cur }
        for (const k of Object.keys(sent) as (keyof Edits)[])
          if (JSON.stringify(cur[k]) === JSON.stringify(sent[k])) delete next[k]
        editsRef.current = next
        setEdits(next)
        setError(null)
        setSavedAt(Date.now())
        setState(Object.keys(editsRef.current).length ? "dirty" : "saved")
        return Object.keys(editsRef.current).length === 0
      } catch (e) {
        const stale = staleRefusal(e)
        if (stale) {
          setConflict({ ...stale, requestId: e instanceof ApiError ? e.requestId : undefined })
          setState("conflict")
          return false
        }
        setError(e instanceof ApiError ? e : new ApiError(0, { message: "Mailyard couldn’t be reached." }))
        setState("error")
        return false
      } finally {
        inFlight.current = null
      }
    })()
    inFlight.current = run
    return run
  }, [id, qc])

  // Save a moment after the last edit, unless a conflict or a refusal is waiting on the person.
  useEffect(() => {
    if (state !== "dirty" || !editable) return
    const t = setTimeout(() => void save(), AUTOSAVE_MS)
    return () => clearTimeout(t)
  }, [state, editable, save])

  // Don't lose edits to a closed tab.
  useEffect(() => {
    if (state !== "dirty" && state !== "error" && state !== "saving") return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [state])

  const set = useCallback(
    (patch: Edits) => {
      if (!editable) return
      const next = { ...editsRef.current, ...patch }
      editsRef.current = next
      setEdits(next)
      setError(null)
      setState((s) => (s === "conflict" ? s : "dirty"))
    },
    [editable],
  )

  const reloadTheirs = useCallback(async () => {
    const fresh = await qc.fetchQuery({ ...campaignQuery(id), staleTime: 0 })
    setEdits({})
    editsRef.current = {}
    setConflict(null)
    setError(null)
    setBase(fresh.updatedAt === null ? null : Number(fresh.updatedAt))
    setState("saved")
  }, [id, qc])

  const draft = useMemo(() => ({ ...campaign, ...edits }) as Campaign, [campaign, edits])

  const value: Ctx = {
    id,
    server: campaign,
    draft,
    edits,
    editable,
    set,
    state,
    error,
    conflict,
    flush: save,
    reloadTheirs,
    baseUpdatedAt: base,
    savedAt,
    stash,
    setStash,
  }
  return <EditorCtx.Provider value={value}>{children}</EditorCtx.Provider>
}

/** Loads the campaign for a route under `/campaigns/$campaignId`. */
export const useCampaign = (id: string) => useQuery(campaignQuery(id))
