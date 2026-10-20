/**
 * The mailbox helpers in the reader: a thread's summary and a drafted reply (`POST …/threads/{id}/summary`,
 * `POST …/threads/{id}/draft`), lit by `GET /v1/settings/assistant`. What a model writes is a suggestion: the
 * summary sits beside the thread and a drafted reply opens as an ordinary draft for a person to edit and send.
 */
import { queryOptions } from "@tanstack/react-query"
import { ApiError, api, unwrap } from "../api/client.ts"
import { num } from "../lib/format.ts"
import type { AssistantSettings } from "./types.ts"

export const assistantKey = ["settings", "assistant"] as const

export const assistantQuery = queryOptions({
  queryKey: assistantKey,
  queryFn: () => unwrap(api.GET("/v1/settings/assistant", {})) as Promise<AssistantSettings>,
  staleTime: 5 * 60_000,
})

export type Helper = "summaries" | "drafts"

/** Why a helper can't run here, from the settings alone; null when it can. */
export function helperOff(s: AssistantSettings | undefined, helper: Helper): "off" | "disabled" | null {
  if (!s) return null
  if (!s.available || s.provider === "off") return "off"
  return s[helper] ? null : "disabled"
}

/** The sentence for an `AssistantRefused` reason (or a settings state), in the reader's words. */
export function refusalText(
  reason: string | undefined,
  helper: Helper,
  s?: AssistantSettings | undefined,
): string {
  const what = helper === "summaries" ? "Summaries" : "Drafted replies"
  switch (reason) {
    case "off":
      return "AI is off for this Mailyard. An owner can turn it on in Settings → AI."
    case "disabled":
      return `${what} are off. An owner or admin can turn them on in Settings → AI.`
    case "cap": {
      const cap = num(s?.dailyCallsPerMailbox)
      return `This mailbox has used today’s ${cap ? `${cap} ` : ""}${helper === "summaries" ? "summaries" : "drafted replies"}. More are available after 00:00 UTC.`
    }
    case "no_answer":
      return "The model didn’t answer. Try again in a moment."
    case "invalid":
      return "The model’s answer couldn’t be used. Try again."
    default:
      return "That didn’t work. Try again."
  }
}

/** The refusal reason on an error from either helper, if the backend said one. */
export const refusalOf = (e: unknown): string | undefined =>
  e instanceof ApiError && e.body._tag === "AssistantRefused" ? e.reason : undefined
