import { DurableObject } from "cloudflare:workers"
import type { Env } from "../Bindings.ts"
import {
  BULK,
  bulkAllowance,
  DEFAULT_CONFIG,
  dayKey,
  daysBetween,
  type GovernorConfig,
  MINUTE_MS,
  minuteKey,
  nextCap,
  nextMidnight,
  PROVIDERS,
  type Provider,
  pauseReason,
  projectEta,
  providerOf,
  type Stream,
} from "../campaigns/governor.ts"

/** One recipient a bulk send wants to reach: a caller's key (a contact or message id) and their domain. */
export interface Recipient {
  readonly key: string
  readonly domain: string
}

export interface Grant {
  readonly granted: ReadonlyArray<string>
  /** When to ask again for the rest; null when nothing is left, or when only a resume will help. */
  readonly retryAt: number | null
  readonly reason: "paused" | "quota" | "warmup" | "provider" | null
}

export type Outcome = "delivered" | "bounced" | "complained"

type Row = Record<string, SqlStorageValue>

/**
 * The account's send scheduler: a single writer over today's counts, so concurrent campaigns can't
 * both spend the last of the quota. Bulk sends ask before sending (`acquire`), transactional sends
 * report after (`consume`), and delivery events feed back (`record`) so a campaign that starts
 * bouncing stops itself.
 */
export class SendGovernorDO extends DurableObject<Env> {
  private readonly sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        create table if not exists config (key text primary key, value text not null);
        create table if not exists usage (day text not null, stream text not null, sent integer not null default 0, primary key (day, stream));
        create table if not exists minutes (minute integer not null, provider text not null, sent integer not null default 0, primary key (minute, provider));
        create table if not exists domains (
          domain text primary key, first_day text not null, cap integer, day text not null,
          sent integer not null default 0, delivered integer not null default 0,
          bounced integer not null default 0, complained integer not null default 0
        );
        create table if not exists campaigns (
          id text primary key, paused integer not null default 0, reason text,
          sent integer not null default 0, delivered integer not null default 0,
          bounced integer not null default 0, complained integer not null default 0,
          updated_at integer not null default 0
        );
      `)
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(nextMidnight(Date.now()))
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------------------------

  config(): GovernorConfig {
    const row = this.sql.exec("select value from config where key = 'config'").toArray()[0]
    if (!row) return DEFAULT_CONFIG
    const stored = JSON.parse(String(row.value)) as Partial<GovernorConfig>
    return {
      ...DEFAULT_CONFIG,
      ...stored,
      providerPerMinute: { ...DEFAULT_CONFIG.providerPerMinute, ...stored.providerPerMinute },
      warmup: { ...DEFAULT_CONFIG.warmup, ...stored.warmup },
      pause: { ...DEFAULT_CONFIG.pause, ...stored.pause },
    }
  }

  configure(patch: Partial<GovernorConfig>): GovernorConfig {
    const current = this.config()
    const next: GovernorConfig = {
      ...current,
      ...patch,
      providerPerMinute: { ...current.providerPerMinute, ...patch.providerPerMinute },
      warmup: { ...current.warmup, ...patch.warmup },
      pause: { ...current.pause, ...patch.pause },
      establishedDomains: (patch.establishedDomains ?? current.establishedDomains).map((d) =>
        d.toLowerCase(),
      ),
    }
    this.sql.exec(
      "insert into config (key, value) values ('config', ?) on conflict (key) do update set value = excluded.value",
      JSON.stringify(next),
    )
    return next
  }

  /** The quota in force: the configured one, else Cloudflare's last reading, else the fallback. */
  private quota(live: number | null | undefined): number {
    const config = this.config()
    if (config.dailyQuota !== null) return config.dailyQuota
    if (typeof live === "number" && live > 0) {
      this.sql.exec(
        "insert into config (key, value) values ('liveQuota', ?) on conflict (key) do update set value = excluded.value",
        String(live),
      )
      return live
    }
    const stored = this.sql.exec("select value from config where key = 'liveQuota'").toArray()[0]
    return stored ? Number(stored.value) : config.fallbackQuota
  }

  // ---------------------------------------------------------------------------------------------
  // Counters
  // ---------------------------------------------------------------------------------------------

  private sentToday(day: string): Record<Stream, number> {
    const out: Record<Stream, number> = { transactional: 0, campaign: 0, automation: 0, mailbox: 0 }
    for (const r of this.sql.exec("select stream, sent from usage where day = ?", day)) {
      out[r.stream as Stream] = Number(r.sent)
    }
    return out
  }

  private addUsage(day: string, stream: Stream, n: number) {
    this.sql.exec(
      "insert into usage (day, stream, sent) values (?, ?, ?) on conflict (day, stream) do update set sent = sent + excluded.sent",
      day,
      stream,
      n,
    )
  }

  private providerSent(minute: number): Record<Provider, number> {
    const out = Object.fromEntries(PROVIDERS.map((p) => [p, 0])) as Record<Provider, number>
    for (const r of this.sql.exec("select provider, sent from minutes where minute = ?", minute)) {
      out[r.provider as Provider] = Number(r.sent)
    }
    return out
  }

  /**
   * A sending domain's warm-up state for today, rolled forward from the last day it sent. Worked out
   * when asked rather than by an alarm, so a missed alarm can't stall a campaign. Null: no warm-up.
   */
  private domainToday(domain: string, today: string, quota: number) {
    const config = this.config()
    const d = domain.toLowerCase()
    if (!config.warmup.enabled || config.establishedDomains.includes(d)) return null
    const row = this.sql.exec("select * from domains where domain = ?", d).toArray()[0] as Row | undefined
    if (!row) {
      this.sql.exec(
        "insert into domains (domain, first_day, cap, day) values (?, ?, ?, ?)",
        d,
        today,
        config.warmup.start,
        today,
      )
      return { cap: config.warmup.start, sent: 0 }
    }
    const cap = Number(row.cap)
    if (row.day === today) return { cap, sent: Number(row.sent) }
    // Only the last active day counts: idle days in between neither earn nor lose a step.
    const rolled = nextCap(
      cap,
      {
        sent: Number(row.sent),
        delivered: Number(row.delivered),
        bounced: Number(row.bounced),
        complained: Number(row.complained),
      },
      config.warmup,
      quota,
    )
    this.sql.exec(
      "update domains set cap = ?, day = ?, sent = 0, delivered = 0, bounced = 0, complained = 0 where domain = ?",
      rolled,
      today,
      d,
    )
    return { cap: rolled, sent: 0 }
  }

  private campaignRow(id: string) {
    return this.sql.exec("select * from campaigns where id = ?", id).toArray()[0] as Row | undefined
  }

  // ---------------------------------------------------------------------------------------------
  // The calls
  // ---------------------------------------------------------------------------------------------

  /**
   * Grants as many of `recipients` as the quota, the domain's warm-up and each provider's per-minute
   * pace allow, in order. A recipient whose provider is at its pace is skipped for one that isn't.
   */
  acquire(input: {
    readonly campaignId: string
    readonly stream?: "campaign" | "automation"
    readonly sendingDomain: string
    readonly recipients: ReadonlyArray<Recipient>
    readonly now: number
    readonly liveQuota?: number | null
  }): Grant {
    const stream = input.stream ?? "campaign"
    const campaign = this.campaignRow(input.campaignId)
    if (campaign && Number(campaign.paused) === 1) return { granted: [], retryAt: null, reason: "paused" }
    const config = this.config()
    const today = dayKey(input.now)
    const quota = this.quota(input.liveQuota)
    let allowance = bulkAllowance(quota, config.transactionalReserve, this.sentToday(today))
    let limitedBy: Grant["reason"] = allowance <= 0 ? "quota" : null
    const warm = this.domainToday(input.sendingDomain, today, quota)
    if (warm && warm.cap - warm.sent < allowance) {
      allowance = Math.max(0, warm.cap - warm.sent)
      if (allowance <= 0) limitedBy = "warmup"
    }
    const minute = minuteKey(input.now)
    const paced = this.providerSent(minute)
    const granted: Array<string> = []
    const perProvider: Partial<Record<Provider, number>> = {}
    let providerLimited = false
    for (const r of input.recipients) {
      if (granted.length >= allowance) {
        limitedBy ??= warm && warm.cap - warm.sent <= granted.length ? "warmup" : "quota"
        break
      }
      const p = providerOf(r.domain)
      if ((paced[p] ?? 0) + (perProvider[p] ?? 0) >= config.providerPerMinute[p]) {
        providerLimited = true
        continue
      }
      perProvider[p] = (perProvider[p] ?? 0) + 1
      granted.push(r.key)
    }
    if (granted.length > 0) {
      this.ctx.storage.transactionSync(() => {
        this.addUsage(today, stream, granted.length)
        for (const [p, n] of Object.entries(perProvider)) {
          this.sql.exec(
            "insert into minutes (minute, provider, sent) values (?, ?, ?) on conflict (minute, provider) do update set sent = sent + excluded.sent",
            minute,
            p,
            n,
          )
        }
        if (warm)
          this.sql.exec(
            "update domains set sent = sent + ? where domain = ?",
            granted.length,
            input.sendingDomain.toLowerCase(),
          )
        this.sql.exec(
          `insert into campaigns (id, sent, updated_at) values (?, ?, ?)
           on conflict (id) do update set sent = sent + excluded.sent, updated_at = excluded.updated_at`,
          input.campaignId,
          granted.length,
          input.now,
        )
      })
    }
    const rest = input.recipients.length - granted.length
    if (rest === 0) return { granted, retryAt: null, reason: null }
    if (limitedBy === "quota" || limitedBy === "warmup")
      return { granted, retryAt: nextMidnight(input.now), reason: limitedBy }
    if (providerLimited) return { granted, retryAt: (minute + 1) * MINUTE_MS, reason: "provider" }
    return { granted, retryAt: nextMidnight(input.now), reason: "quota" }
  }

  /** Records sends that weren't asked for first (transactional, mailbox), so bulk knows what's left. */
  consume(input: {
    readonly stream: "transactional" | "mailbox"
    readonly count: number
    readonly now: number
  }) {
    if (input.count > 0) this.addUsage(dayKey(input.now), input.stream, input.count)
  }

  /**
   * One delivery outcome for a bulk send. Updates the sending domain's warm-up day and the campaign's
   * running rates, and pauses the campaign the moment those cross the line.
   */
  record(input: {
    readonly campaignId: string | null
    readonly sendingDomain: string
    readonly outcome: Outcome
    readonly now: number
  }): { paused: boolean; reason: string | null } {
    const column = input.outcome
    this.sql.exec(
      `update domains set ${column} = ${column} + 1 where domain = ? and day = ?`,
      input.sendingDomain.toLowerCase(),
      dayKey(input.now),
    )
    if (!input.campaignId) return { paused: false, reason: null }
    this.sql.exec(
      `insert into campaigns (id, ${column}, updated_at) values (?, 1, ?)
       on conflict (id) do update set ${column} = ${column} + 1, updated_at = excluded.updated_at`,
      input.campaignId,
      input.now,
    )
    const row = this.campaignRow(input.campaignId) as Row
    if (Number(row.paused) === 1) return { paused: true, reason: String(row.reason ?? "") }
    const reason = pauseReason(
      { delivered: Number(row.delivered), bounced: Number(row.bounced), complained: Number(row.complained) },
      this.config().pause,
    )
    if (reason)
      this.sql.exec("update campaigns set paused = 1, reason = ? where id = ?", reason, input.campaignId)
    return { paused: reason !== null, reason }
  }

  pause(campaignId: string, reason: string, now: number) {
    this.sql.exec(
      `insert into campaigns (id, paused, reason, updated_at) values (?, 1, ?, ?)
       on conflict (id) do update set paused = 1, reason = excluded.reason, updated_at = excluded.updated_at`,
      campaignId,
      reason,
      now,
    )
  }

  resume(campaignId: string, now: number) {
    this.sql.exec(
      "update campaigns set paused = 0, reason = null, updated_at = ? where id = ?",
      now,
      campaignId,
    )
  }

  /** A campaign's pace: whether it's paused and why, its outcomes, and when `remaining` will have gone. */
  campaign(input: {
    readonly campaignId: string
    readonly sendingDomain: string
    readonly remaining: number
    readonly now: number
    readonly liveQuota?: number | null
  }) {
    const row = this.campaignRow(input.campaignId)
    const config = this.config()
    const today = dayKey(input.now)
    const quota = this.quota(input.liveQuota)
    const warm = this.domainToday(input.sendingDomain, today, quota)
    const eta = projectEta({
      remaining: input.remaining,
      now: input.now,
      todayAllowance: bulkAllowance(quota, config.transactionalReserve, this.sentToday(today)),
      dailyBulk: Math.floor(quota * (1 - config.transactionalReserve)),
      warmupCap: warm?.cap ?? null,
      warmupUsedToday: warm?.sent ?? 0,
      warmupFactor: config.warmup.factor,
    })
    return {
      paused: row ? Number(row.paused) === 1 : false,
      reason: row?.reason === undefined || row.reason === null ? null : String(row.reason),
      sent: Number(row?.sent ?? 0),
      delivered: Number(row?.delivered ?? 0),
      bounced: Number(row?.bounced ?? 0),
      complained: Number(row?.complained ?? 0),
      eta,
    }
  }

  /** Today at a glance, for the usage screen. */
  overview(input: { readonly now: number; readonly liveQuota?: number | null }) {
    const config = this.config()
    const today = dayKey(input.now)
    const quota = this.quota(input.liveQuota)
    const sent = this.sentToday(today)
    const domains = this.sql
      .exec(
        "select domain, first_day, cap, day, sent, delivered, bounced, complained from domains order by domain",
      )
      .toArray()
      .map((r) => ({
        domain: String(r.domain),
        warmingSince: String(r.first_day),
        day: daysBetween(String(r.first_day), today) + 1,
        cap: Number(r.cap),
        sentToday: r.day === today ? Number(r.sent) : 0,
      }))
    return {
      day: today,
      quota,
      quotaSource: (config.dailyQuota !== null
        ? "configured"
        : input.liveQuota
          ? "cloudflare"
          : "fallback") as "configured" | "cloudflare" | "fallback",
      sent,
      bulkRemaining: bulkAllowance(quota, config.transactionalReserve, sent),
      transactionalReserve: Math.ceil(quota * config.transactionalReserve),
      resetsAt: nextMidnight(input.now),
      providerThisMinute: this.providerSent(minuteKey(input.now)),
      warming: domains,
      config,
    }
  }

  /** Midnight UTC: drop counters older than a month; the next day's counts start fresh by key. */
  override async alarm() {
    const now = Date.now()
    const cutoff = dayKey(now - 31 * 86_400_000)
    this.sql.exec("delete from usage where day < ?", cutoff)
    this.sql.exec("delete from minutes where minute < ?", minuteKey(now) - 60)
    await this.ctx.storage.setAlarm(nextMidnight(now))
  }

  /** Bulk streams, for callers that check a stream name. */
  static isBulk(stream: string): stream is "campaign" | "automation" {
    return (BULK as ReadonlyArray<string>).includes(stream)
  }
}
