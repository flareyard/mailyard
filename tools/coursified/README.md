# Coursified's lifecycle emails on Mailyard

Coursified's six lifecycle emails (B1–B6 in `coursified/packages/emails/FLOWS.md`) as Mailyard
templates and automations (HAL-3383). They are installed as **drafts**: switching Coursified over
is HAL-3302, and needs the founder.

- `port.ts` regenerates the templates from Coursified's own render functions
  (`COURSIFIED_DIR=~/dev/coursified bun tools/coursified/port.ts`), into `generated/`. Run it
  whenever a Coursified template changes.
- `test/templates/coursified.test.ts` renders each ported template in Mailyard and checks it
  matches Coursified's output for the samples in `data.ts`, character for character.
- `install.ts` creates or updates the templates and the draft automations in a Mailyard install,
  then dry-runs each one into `dry-runs.md`.

Coursified's layout escapes some text twice (HAL-3384), and the ports render what it meant to
send. The test applies the same correction (`intended` in `port.ts`) to both sides.

## What Coursified tracks

Each email is an automation started by an event Coursified sends to `POST /v1/track`:
`{ "event": "<name>", "email": "<learner>", "data": { … } }`. The data is what `dataFor` in
`data.ts` builds from the props Coursified's template function takes. Everything Coursified works
out (a number in words, a plural, a first name, the progress bar's width) arrives in the data,
because Mailyard templates don't compute.

| Email | Event | Data | Rules |
|---|---|---|---|
| B1 Welcome | `onboarding_completed` | `firstName`, `planLine` (or null) | Once |
| B2 Activation nudge | `signed_up` | `goal` (or null), `suggestions: [{ title, metaLine, cloneLabel }]`, `createUrl`, `exploreUrl` | Day 3 and day 7 unless converted; tracking `course_converted` stops it |
| B3 Streak rescue | `streak_at_risk` (the evening before the reset) | `streakDays`, `streakWord`, `shortestModuleMinutes`, `resumeUrl`, `personalBest` | Again after a day |
| B4 Retake unlocked | `retake_unlocked` | `courseTitle`, `score`, `passMark`, `clips: [{ title, metaLine }]`, `modulesLabel`, `rewatchMinutes`, `rewatchUrl`, `retakeUrl` | Each unlock |
| B5 Win-back | `inactive_30_days` | `courseTitle`, `progressPct`, `progressBarPct`, `quizAvgPct`, `hasQuizAvg`, `moduleTitle`, `minutesLeft`, `resumeUrl`, `pathwayCount`, `pathwayCourses`, `shrinkUrl` | Once |
| B6 Upgrade to Pro | `conversion_limit_hit` | `used`, `limit`, `usedWord`, `limitWord`, `resetDateLabel`, `upgradeUrl`, `priceLabel` (or null) | Each limit hit |

All six share the lifecycle cadence cap from FLOWS.md: at most two a week to one learner, counted
across every automation. The sender is set with `MAILYARD_FROM` at install, and its domain must be
a Mailyard sending domain before the drafts can publish.
