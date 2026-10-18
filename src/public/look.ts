import * as Effect from "effect/Effect"
import { DEFAULT_PREFERENCE_PAGE, getCompliance } from "../campaigns/compliance.ts"
import { customBrandSettings } from "../domain/brand.ts"
import { pageTheme } from "./shell.ts"

/**
 * Everything a public page needs to look like the sender: the brand (or Flareyard's look), and the
 * compliance footer. A database hiccup falls back to the default look rather than failing the page.
 */
export const publicLook = Effect.gen(function* () {
  const brand = yield* customBrandSettings()
  const compliance = yield* getCompliance()
  const prefs = compliance.preferencePage ?? DEFAULT_PREFERENCE_PAGE
  return {
    // A workspace can keep Flareyard's look on its public pages even with a brand set (HAL-3376).
    theme: pageTheme(prefs.useBrand ? brand : null),
    postalAddress: compliance.postalAddress,
    privacyUrl: compliance.privacyUrl ?? null,
    showTopicDescriptions: prefs.showTopicDescriptions,
  }
}).pipe(
  Effect.catchTag("DatabaseError", () =>
    Effect.succeed({
      theme: pageTheme(null),
      postalAddress: null,
      privacyUrl: null,
      showTopicDescriptions: true,
    }),
  ),
)
