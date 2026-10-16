import { Effect } from "effect"
import { isProviderProblem, type Outgoing, type SendError, type SendResult } from "./Sender.ts"

interface SenderLike {
  send(message: Outgoing): Effect.Effect<SendResult, SendError>
}

/**
 * Try `primary`; if it fails for a reason that is the provider's problem (temporary, quota, or the
 * sender isn't set up there), send the same message through `secondary`. A message that is invalid or
 * whose recipients are suppressed fails at once: another transport wouldn't change that.
 */
export const failover = (primary: SenderLike, secondary: SenderLike): SenderLike => ({
  send: (message) =>
    primary
      .send(message)
      .pipe(
        Effect.catchIf(isProviderProblem, (first) =>
          Effect.logWarning(`send: primary transport refused (${first._tag}), trying the secondary`).pipe(
            Effect.andThen(secondary.send(message)),
          ),
        ),
      ),
})
