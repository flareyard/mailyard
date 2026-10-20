/**
 * Mail's fixture-mode answers (see fixtures/overrides.ts): routes whose design fixtures are missing or
 * predate the live contract, and the ids that pick a designed state so the audit can reach it:
 *
 *   mailbox mbx_new      → an empty mailbox (inbox-empty)
 *   mailbox mbx_broken   → the thread list fails with 500 (inbox-error); folders still load
 *   thread  thr_broken   → the thread fails with 500 (thread-error)
 *
 * The composer's and the mailbox pages' own states live in compose/fixtures.ts and pages/fixtures.ts.
 */

import { ASSISTANT_OVERRIDES } from "./assistant-fixtures.ts"
import { COMPOSE_OVERRIDES } from "./compose/fixtures.ts"
import type { MailOverride } from "./fixtures-core.ts"
import { CORE_OVERRIDES } from "./fixtures-core.ts"
import { PAGES_OVERRIDES } from "./pages/fixtures.ts"

export const MAIL_OVERRIDES: readonly MailOverride[] = [
  ...ASSISTANT_OVERRIDES,
  ...COMPOSE_OVERRIDES,
  ...PAGES_OVERRIDES,
  ...CORE_OVERRIDES,
]
