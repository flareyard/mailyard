/** Why a sign-in attempt came back to this page: a lapsed session, or a Flareyard hand-off that didn't finish. */
export const FLAREYARD_ERRORS = {
  flareyard_state: "That Flareyard sign-in expired or was started in another tab. Try again.",
  flareyard_session_expired: "That Flareyard sign-in code was already used or has expired. Try again.",
  flareyard_denied: "You cancelled on Flareyard, so nothing changed. Continue when you're ready.",
  flareyard_wrong_install:
    "Flareyard answered for a different install of Mailyard. This is rare: sign in another way, and contact support if it keeps happening.",
  flareyard_refused: "Flareyard refused the sign-in. Try again, or get a sign-in link by email.",
  flareyard_unreachable: "Flareyard didn't answer. Get a sign-in link by email instead.",
} as const
export type FlareyardError = keyof typeof FLAREYARD_ERRORS
export const isFlareyardError = (v: unknown): v is FlareyardError =>
  typeof v === "string" && Object.hasOwn(FLAREYARD_ERRORS, v)
