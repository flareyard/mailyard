import * as Schedule from "effect/Schedule"

/**
 * The default policy for calls to other people's systems: exponential backoff from 250 ms with each
 * delay capped at 30 s, jittered, at most 5 retries.
 *
 * `Schedule.min` recurs while either schedule does and takes the shorter delay, which caps the
 * exponential. `Schedule.max` recurs only while both do, which stops it after five retries.
 * Use it with `Effect.retry({ schedule: backoff, while: isTransient })` so a permanent rejection
 * fails at once instead of being retried.
 */
export const backoff = Schedule.max([
  Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("30 seconds")]),
  Schedule.recurs(5),
]).pipe(Schedule.jittered)
