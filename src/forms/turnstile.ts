/**
 * Cloudflare Turnstile's server-side check (siteverify). A form with a site key and a deploy with
 * TURNSTILE_SECRET verifies every submission's token before anything is written. It fails closed:
 * no token, a rejected one, or no answer from Cloudflare all refuse the submission.
 */
export const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify"

export type TurnstileResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export const verifyTurnstile = async (input: {
  readonly secret: string
  readonly token: unknown
  readonly ip: string | null
}): Promise<TurnstileResult> => {
  if (typeof input.token !== "string" || input.token.length === 0 || input.token.length > 2048)
    return { ok: false, reason: "missing-input-response" }
  const body = new URLSearchParams({ secret: input.secret, response: input.token })
  if (input.ip) body.set("remoteip", input.ip)
  try {
    const response = await fetch(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(5_000) })
    const result = (await response.json()) as { success?: boolean; "error-codes"?: ReadonlyArray<string> }
    return result.success === true
      ? { ok: true }
      : { ok: false, reason: result["error-codes"]?.join(",") || "rejected" }
  } catch {
    return { ok: false, reason: "unreachable" }
  }
}
