/**
 * Coursified's lifecycle emails (B1–B6) as Mailyard automations (HAL-3383). This file is the
 * contract with Coursified: for each email, the event Coursified tracks (`POST /v1/track`) and the
 * data it sends with it. Templates read the data as `{{trigger.*}}`.
 *
 * Mailyard templates are logic-less, so anything Coursified's TypeScript works out (a number as a
 * word, a plural, a clamped percentage, a first name) arrives ready in the data. `dataFor` does that
 * from the props Coursified's own template functions take, so the snapshot test can check that
 * Mailyard renders exactly what Coursified would.
 *
 * Plain TypeScript, no Worker imports: the port script (bun) and the tests (workerd) both use it.
 */

const WORDS = [
  "Zero",
  "One",
  "Two",
  "Three",
  "Four",
  "Five",
  "Six",
  "Seven",
  "Eight",
  "Nine",
  "Ten",
  "Eleven",
  "Twelve",
  "Thirteen",
  "Fourteen",
  "Fifteen",
  "Sixteen",
  "Seventeen",
  "Eighteen",
  "Nineteen",
  "Twenty",
]
/** streakRescue's numberWord: words to twenty. */
const numberWord = (n: number) => WORDS[n] ?? String(n)
/** upgradeToPro's countWord: words to ten. */
const countWord = (n: number) => WORDS.slice(0, 11)[n] ?? String(n)

export type WelcomeProps = { readonly name: string; readonly planLine?: string }
export type ActivationNudgeProps = {
  readonly name?: string
  readonly goal?: string
  readonly suggestions: ReadonlyArray<{
    readonly title: string
    readonly metaLine: string
    readonly cloneLabel: string
  }>
  readonly createUrl: string
  readonly exploreUrl: string
}
export type StreakRescueProps = {
  readonly streakDays: number
  readonly shortestModuleMinutes: number
  readonly resumeUrl: string
  readonly personalBest?: boolean
}
export type RetakeUnlockedProps = {
  readonly courseTitle: string
  readonly score: number
  readonly passMark: number
  readonly clips: ReadonlyArray<{ readonly title: string; readonly metaLine: string }>
  readonly rewatchMinutes: number
  readonly rewatchUrl: string
  readonly retakeUrl: string
}
export type WinBackProps = {
  readonly courseTitle: string
  readonly progressPct: number
  readonly quizAvgPct?: number
  readonly moduleTitle: string
  readonly minutesLeft: number
  readonly resumeUrl: string
  readonly pathwayCount?: number
  readonly shrinkUrl?: string
}
export type UpgradeToProProps = {
  readonly used: number
  readonly limit: number
  readonly resetDateLabel: string
  readonly upgradeUrl: string
  readonly priceLabel?: string
}

export type Lifecycle = {
  welcome: WelcomeProps
  activationNudge: ActivationNudgeProps
  streakRescue: StreakRescueProps
  retakeUnlocked: RetakeUnlockedProps
  winBack: WinBackProps
  upgradeToPro: UpgradeToProProps
}
export type LifecycleKey = keyof Lifecycle

/** The event data Coursified sends for each email: the props, plus what its template worked out. */
export const dataFor: { [K in LifecycleKey]: (props: Lifecycle[K]) => Record<string, unknown> } = {
  welcome: (p) => ({ firstName: p.name.trim().split(/\s+/)[0] || "there", planLine: p.planLine ?? null }),
  activationNudge: (p) => ({
    goal: p.goal ?? null,
    suggestions: p.suggestions,
    createUrl: p.createUrl,
    exploreUrl: p.exploreUrl,
  }),
  streakRescue: (p) => ({
    streakDays: p.streakDays,
    streakWord: numberWord(p.streakDays),
    shortestModuleMinutes: p.shortestModuleMinutes,
    resumeUrl: p.resumeUrl,
    personalBest: p.personalBest === true,
  }),
  retakeUnlocked: (p) => ({
    courseTitle: p.courseTitle,
    score: p.score,
    passMark: p.passMark,
    clips: p.clips,
    modulesLabel: p.clips.length === 1 ? "one module" : `${p.clips.length} modules`,
    rewatchMinutes: p.rewatchMinutes,
    rewatchUrl: p.rewatchUrl,
    retakeUrl: p.retakeUrl,
  }),
  winBack: (p) => ({
    courseTitle: p.courseTitle,
    progressPct: p.progressPct,
    progressBarPct: Math.max(0, Math.min(100, Math.round(p.progressPct))),
    quizAvgPct: p.quizAvgPct ?? null,
    hasQuizAvg: p.quizAvgPct != null,
    moduleTitle: p.moduleTitle,
    minutesLeft: p.minutesLeft,
    resumeUrl: p.resumeUrl,
    pathwayCount: p.pathwayCount ?? null,
    pathwayCourses: p.pathwayCount ? `${p.pathwayCount} course${p.pathwayCount === 1 ? "" : "s"}` : null,
    shrinkUrl: p.shrinkUrl ?? null,
  }),
  upgradeToPro: (p) => ({
    used: p.used,
    limit: p.limit,
    usedWord: countWord(p.used),
    limitWord: countWord(p.limit).toLowerCase(),
    resetDateLabel: p.resetDateLabel,
    upgradeUrl: p.upgradeUrl,
    priceLabel: p.priceLabel ?? null,
  }),
}

/** The event each email's automation starts on (see the automations in install.ts). */
export const EVENTS: { readonly [K in LifecycleKey]: string } = {
  welcome: "onboarding_completed",
  activationNudge: "signed_up",
  streakRescue: "streak_at_risk",
  retakeUnlocked: "retake_unlocked",
  winBack: "inactive_30_days",
  upgradeToPro: "conversion_limit_hit",
}

/** Sample props for the snapshot test: each optional path both ways, and characters that need escaping. */
export const SAMPLES: { readonly [K in LifecycleKey]: ReadonlyArray<Lifecycle[K]> } = {
  welcome: [{ name: "Ada Lovelace" }, { name: "  ", planLine: "You're on Pro — unlimited & priority." }],
  activationNudge: [
    {
      goal: "Product & Design",
      suggestions: [
        { title: "Shape Up, in 6 modules", metaLine: "Basecamp · 41 min", cloneLabel: "Clone" },
        { title: "Jobs-to-be-done <basics>", metaLine: "Clayton's talk · 28 min", cloneLabel: "1.2k clones" },
      ],
      createUrl: "https://coursified.app/create",
      exploreUrl: "https://coursified.app/explore?goal=product",
    },
    {
      suggestions: [],
      createUrl: "https://coursified.app/create",
      exploreUrl: "https://coursified.app/explore",
    },
  ],
  streakRescue: [
    {
      streakDays: 7,
      shortestModuleMinutes: 6,
      resumeUrl: "https://coursified.app/learn/c1?m=3",
      personalBest: true,
    },
    { streakDays: 23, shortestModuleMinutes: 12, resumeUrl: "https://coursified.app/learn/c2" },
  ],
  retakeUnlocked: [
    {
      courseTitle: "Stats for A/B tests",
      score: 64,
      passMark: 70,
      clips: [
        { title: "p-values vs confidence", metaLine: "4 min at 22:10" },
        { title: "Power & sample size", metaLine: "6 min at 31:02" },
      ],
      rewatchMinutes: 10,
      rewatchUrl: "https://coursified.app/learn/c3/rewatch",
      retakeUrl: "https://coursified.app/learn/c3/retake",
    },
    {
      courseTitle: "SQL joins",
      score: 55,
      passMark: 60,
      clips: [{ title: "LEFT vs INNER", metaLine: "3 min at 05:40" }],
      rewatchMinutes: 3,
      rewatchUrl: "https://coursified.app/r",
      retakeUrl: "https://coursified.app/t",
    },
  ],
  winBack: [
    {
      courseTitle: "Rust for TS devs",
      progressPct: 42.6,
      quizAvgPct: 88,
      moduleTitle: "Ownership & borrowing",
      minutesLeft: 17,
      resumeUrl: "https://coursified.app/learn/c4",
      pathwayCount: 4,
      shrinkUrl: "https://coursified.app/pathway/shrink",
    },
    {
      courseTitle: "Go basics",
      progressPct: 130,
      moduleTitle: "Goroutines",
      minutesLeft: 9,
      resumeUrl: "https://coursified.app/learn/c5",
      pathwayCount: 1,
    },
    {
      courseTitle: "Docker",
      progressPct: 5,
      moduleTitle: "Images",
      minutesLeft: 30,
      resumeUrl: "https://coursified.app/learn/c6",
    },
  ],
  upgradeToPro: [
    { used: 3, limit: 3, resetDateLabel: "Nov 1", upgradeUrl: "https://coursified.app/pro" },
    {
      used: 12,
      limit: 12,
      resetDateLabel: "Dec 1",
      upgradeUrl: "https://coursified.app/pro?y=1",
      priceLabel: "€8",
    },
  ],
}
