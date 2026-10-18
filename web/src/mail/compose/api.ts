/**
 * The composer's calls: create (with an idempotency key, so a retried create is one draft), autosave,
 * discard, send (undo window, schedule, tracking; idempotent too), cancel, and the raw attachment upload.
 */
import { ApiError, type ApiErrorBody, api, unwrap } from "../../api/client.ts"
import { fixtureFetch, fixturesEnabled } from "../../fixtures/mode.ts"
import type { Draft, DraftCreate, DraftPatch, SendBody, SendResult, Upload } from "../types.ts"

export function createDraft(mailboxId: string, body: DraftCreate, idempotencyKey: string): Promise<Draft> {
  return unwrap(
    api.POST("/v1/mailboxes/{id}/drafts", {
      params: { path: { id: mailboxId }, header: { "idempotency-key": idempotencyKey } },
      body,
    }),
  ) as Promise<Draft>
}

export function saveDraft(mailboxId: string, draftId: string, body: DraftPatch): Promise<Draft> {
  return unwrap(
    api.PATCH("/v1/mailboxes/{id}/drafts/{draftId}", { params: { path: { id: mailboxId, draftId } }, body }),
  ) as Promise<Draft>
}

export function getDraft(mailboxId: string, draftId: string): Promise<Draft> {
  return unwrap(
    api.GET("/v1/mailboxes/{id}/drafts/{draftId}", { params: { path: { id: mailboxId, draftId } } }),
  ) as Promise<Draft>
}

export async function discardDraft(mailboxId: string, draftId: string): Promise<void> {
  await unwrap(
    api.DELETE("/v1/mailboxes/{id}/drafts/{draftId}", { params: { path: { id: mailboxId, draftId } } }),
  )
}

export function sendDraft(
  mailboxId: string,
  draftId: string,
  body: SendBody,
  idempotencyKey: string,
): Promise<SendResult> {
  return unwrap(
    api.POST("/v1/mailboxes/{id}/drafts/{draftId}/send", {
      params: { path: { id: mailboxId, draftId }, header: { "idempotency-key": idempotencyKey } },
      body,
    }),
  ) as Promise<SendResult>
}

export function cancelSend(mailboxId: string, draftId: string): Promise<Draft> {
  return unwrap(
    api.POST("/v1/mailboxes/{id}/drafts/{draftId}/cancel", { params: { path: { id: mailboxId, draftId } } }),
  ) as Promise<Draft>
}

/**
 * Uploads one file as the raw request body (`POST …/uploads?filename=`). XMLHttpRequest rather than fetch,
 * so the row shows real upload progress; in fixture mode the request is answered by the fixture table.
 */
export function uploadFile(
  mailboxId: string,
  file: File,
  onProgress: (share: number) => void,
  signal?: AbortSignal,
): Promise<Upload> {
  const path = `/v1/mailboxes/${encodeURIComponent(mailboxId)}/uploads?filename=${encodeURIComponent(file.name)}`
  if (fixturesEnabled()) {
    onProgress(0.5)
    return fixtureFetch(
      new Request(new URL(path, window.location.origin), {
        method: "POST",
        body: JSON.stringify({ size: file.size, type: file.type }),
      }),
    ).then(async (r) => {
      const body = (await r.json()) as Upload & ApiErrorBody
      if (!r.ok) throw new ApiError(r.status, body)
      onProgress(1)
      return body
    })
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", path)
    xhr.withCredentials = true
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream")
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onload = () => {
      let body: ApiErrorBody = {}
      try {
        body = JSON.parse(xhr.responseText) as ApiErrorBody
      } catch {
        body = { message: xhr.statusText }
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as Upload)
      else reject(new ApiError(xhr.status, body))
    }
    xhr.onerror = () => reject(new TypeError("network"))
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"))
    signal?.addEventListener("abort", () => xhr.abort())
    xhr.send(file)
  })
}
