# Coursified lifecycle automations: dry runs

Against https://mailyard-api.halleluyaholudele.workers.dev, 2026-10-17T19:19:48.083Z.

## Coursified B1 · Welcome

Trigger: `onboarding_completed`. Draft issues: coursified.app isn't set up for sending.

**sample**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | s | would-send | "Welcome — paste your first link" |
| 0.00 | x | exited | Finished. |

## Coursified B2 · Activation nudge

Trigger: `signed_up`. Draft issues: coursified.app isn't set up for sending.

**never converts**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | w1 | would-wait | Waiting 3 days. |
| 3.00 | b1 | no | No: hasn't done course_converted. |
| 3.00 | s1 | would-send | "That video you keep re-watching?" |
| 3.00 | w2 | would-wait | Waiting 4 days. |
| 7.00 | b2 | no | No: hasn't done course_converted. |
| 7.00 | s2 | would-send | "That video you keep re-watching?" |
| 7.00 | x3 | exited | Finished. |

**converts on day 5**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | w1 | would-wait | Waiting 3 days. |
| 3.00 | b1 | no | No: hasn't done course_converted. |
| 3.00 | s1 | would-send | "That video you keep re-watching?" |
| 3.00 | w2 | would-wait | Waiting 4 days. |
| 7.00 | b2 | stopped | Stopped by course_converted. |

**converts on day 1**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | w1 | would-wait | Waiting 3 days. |
| 3.00 | b1 | stopped | Stopped by course_converted. |

## Coursified B3 · Streak rescue

Trigger: `streak_at_risk`. Draft issues: coursified.app isn't set up for sending.

**sample**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | s | would-send | "7 days, one evening from zero" |
| 0.00 | x | exited | Finished. |

## Coursified B4 · Retake unlocked

Trigger: `retake_unlocked`. Draft issues: coursified.app isn't set up for sending.

**sample**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | s | would-send | "Round two: your retake is unlocked" |
| 0.00 | x | exited | Finished. |

## Coursified B5 · Win-back

Trigger: `inactive_30_days`. Draft issues: coursified.app isn't set up for sending.

**sample**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | s | would-send | "Your pathway is still 4 courses long" |
| 0.00 | x | exited | Finished. |

## Coursified B6 · Upgrade to Pro

Trigger: `conversion_limit_hit`. Draft issues: coursified.app isn't set up for sending.

**sample**

| Day | Step | Outcome | Detail |
|---|---|---|---|
| 0.00 | t | would-run | Entered. |
| 0.00 | s | would-send | "You hit 3 of 3 conversions this month" |
| 0.00 | x | exited | Finished. |

