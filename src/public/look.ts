import * as Effect from "effect/Effect"
import { getCompliance } from "../campaigns/compliance.ts"
import { customBrandSettings } from "../domain/brand.ts"
import { pageTheme } from "./shell.ts"

/**
 * Everything a public page needs to look like the sender: the brand (or Flareyard's look), and the
 * compliance footer. A database hiccup falls back to the default look rather than failing the page.
 */
export const publicLook = Effect.gen(function* () {
  const brand = yield* customBrandSettings()
  const compliance = yield* getCompliance()
  return {
    theme: pageTheme(brand),
    postalAddress: compliance.postalAddress,
    privacyUrl: compliance.privacyUrl ?? null,
  }
}).pipe(
  Effect.catchTag("DatabaseError", () =>
    Effect.succeed({ theme: pageTheme(null), postalAddress: null, privacyUrl: null }),
  ),
)
