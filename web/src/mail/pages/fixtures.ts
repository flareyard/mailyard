/**
 * Fixture-mode answers for the mailbox pages (rules, senders, import, export, labels, smart folders), in the
 * live contract and typed against the generated schema. Bodies are the designs' (rules.html, senders.html,
 * import-*.html, export.html, labels-manage.html, smart-folders.html, rule-apply.html, rule-from-message.html).
 *
 * Ids that pick a designed state, so the audit reaches each one by URL:
 *   mailbox mbx_new                    → no rules, no senders, no imports, no exports (rules-empty)
 *   import  imp_01JAF9 / imp_running   → running, with a catch-up pass waiting (import-running)
 *   import  imp_paused                 → paused, password held (import-paused)
 *   import  imp_failed                 → stopped, 14 retryable, password dropped (import-failed; ?retry=1 → import-retry)
 *   import  imp_done                   → complete
 *   import  imp_01JAFC                 → the catch-up pass itself (pending)
 *   mailbox mbx_hello exports          → only finished exports (export, done); every other mailbox has one running
 * Writes answer with what the API would return; nothing is stored between requests.
 */
import type { MailOverride } from "../fixtures-core.ts"
import type {
  ExportList,
  ImportList,
  LabelBody,
  MailExport,
  MailImport,
  Probe,
  Rule,
  RuleApply,
  RuleList,
  RuleTest,
  SenderList,
  SmartFolder,
} from "./types.ts"

const NOW = 1792259160000 // Sat 17 Oct 2026, 17:46 UTC: the designs' "now"
const ok = (body: unknown) => ({ status: 200, body })
const MB = "([^/]+)"
const obj = (b: unknown) => (b && typeof b === "object" ? (b as Record<string, unknown>) : {})

export const RULES: RuleList = {
  rules: [
    {
      id: "rul_01",
      name: "Billing questions",
      enabled: true,
      match: "any",
      conditions: [
        { field: "subject", op: "contains", value: "invoice" },
        { field: "subject", op: "contains", value: "payment" },
        { field: "body", op: "contains", value: "refund" },
      ],
      actions: [{ type: "label", labelId: "lbl_billing" }],
      stop: false,
      position: 0,
      createdAt: 1788803280000,
      updatedAt: 1791222480000,
      matchCount: 212,
      lastMatchedAt: NOW,
    },
    {
      id: "rul_02",
      name: "Bug reports from the app",
      enabled: true,
      match: "all",
      conditions: [{ field: "tag", op: "equals", value: "app-feedback" }],
      actions: [
        { type: "label", labelId: "lbl_bugs" },
        { type: "assign", assignee: "key_01JA4B7M" },
        { type: "webhook", endpointId: "whk_linear" },
      ],
      stop: true,
      position: 1,
      createdAt: 1788976080000,
      updatedAt: 1788976080000,
      matchCount: 64,
      lastMatchedAt: 1792254960000,
    },
    {
      id: "rul_03",
      name: "Partners to Halleluyah",
      enabled: true,
      match: "any",
      conditions: [{ field: "from", op: "endsWith", value: "@musaanalytics.ng" }],
      actions: [
        { type: "label", labelId: "lbl_partners" },
        { type: "star" },
        { type: "forward", to: ["halleluyah@coursified.app"] },
      ],
      stop: false,
      position: 2,
      createdAt: 1789667280000,
      updatedAt: 1791481680000,
      matchCount: 17,
      lastMatchedAt: 1792251780000,
    },
    {
      id: "rul_04",
      name: "Block .icu senders",
      enabled: true,
      match: "all",
      conditions: [{ field: "from", op: "endsWith", value: ".icu" }],
      actions: [{ type: "spam" }],
      stop: true,
      position: 3,
      createdAt: 1790444880000,
      updatedAt: 1790444880000,
      matchCount: 9,
      lastMatchedAt: 1792000080000,
    },
    {
      id: "rul_05",
      name: "Out-of-office replies",
      enabled: false,
      match: "all",
      conditions: [
        { field: "automated", value: true },
        { field: "subject", op: "startsWith", value: "Out of office" },
      ],
      actions: [{ type: "markRead" }, { type: "archive" }],
      stop: false,
      position: 4,
      createdAt: 1791049680000,
      updatedAt: 1792086480000,
      matchCount: 0,
      lastMatchedAt: null,
    },
  ],
}

const SENDERS: SenderList = {
  senders: [
    { value: "musaanalytics.ng", list: "allow", source: "user", createdAt: 1789667280000 },
    { value: "sade.williams@yahoo.com", list: "allow", source: "not_spam", createdAt: 1791740880000 },
    { value: "unilag.edu.ng", list: "allow", source: "user", createdAt: 1791222480000 },
    { value: "payout-desk.top", list: "block", source: "spam", createdAt: 1792165680000 },
    { value: "rank-experts-mail.xyz", list: "block", source: "user", createdAt: 1791913680000 },
    { value: "coursified-app.co", list: "block", source: "user", createdAt: 1792256400000 },
  ],
}

type Folder = MailImport["folders"][number]
const folder = (f: Partial<Folder> & Pick<Folder, "name" | "folder" | "source">): Folder => ({
  label: null,
  uidValidity: 1696413021,
  imported: 0,
  duplicates: 0,
  failed: 0,
  skipped: 0,
  lastUid: 0,
  batches: 0,
  batchesDone: 0,
  lastError: null,
  retryable: 0,
  ...f,
})

const RUNNING: MailImport = {
  id: "imp_01JAF9",
  source: "imap",
  mode: "full",
  host: "imap.gmail.com",
  port: 993,
  username: "support.coursified@gmail.com",
  status: "running",
  error: null,
  folders: [
    folder({
      name: "INBOX",
      folder: "inbox",
      source: 4210,
      imported: 4210,
      duplicates: 12,
      lastUid: 48211,
      batches: 43,
      batchesDone: 43,
    }),
    folder({
      name: "[Gmail]/Sent Mail",
      folder: "sent",
      source: 2186,
      imported: 1302,
      failed: 3,
      lastUid: 9012,
      batches: 22,
      batchesDone: 14,
      lastError: "3 messages are over 25 MiB, which Cloudflare can’t store.",
    }),
    folder({ name: "Receipts", folder: "archive", label: "receipts", source: 640, batches: 7 }),
    folder({ name: "[Gmail]/Spam", folder: "spam", source: 58, skipped: 58 }),
  ],
  totals: { source: 7094, imported: 5512, duplicates: 12, failed: 3, skipped: 58 },
  accountedFor: false,
  ratePerMinute: 212,
  etaAt: NOW + 10 * 60_000,
  startedAt: 1792257720000,
  pausedAt: null,
  catchupOf: null,
  since: null,
  retryOf: null,
  credentialsHeld: true,
  createdAt: 1792257720000,
  finishedAt: null,
}

const CATCHUP: MailImport = {
  ...RUNNING,
  id: "imp_01JAFC",
  mode: "catchup",
  status: "pending",
  folders: [],
  totals: { source: 0, imported: 0, duplicates: 0, failed: 0, skipped: 0 },
  ratePerMinute: null,
  etaAt: null,
  startedAt: null,
  catchupOf: "imp_01JAF9",
  since: 1792257720000,
}

const PAUSED: MailImport = {
  ...RUNNING,
  id: "imp_paused",
  status: "paused",
  ratePerMinute: null,
  etaAt: null,
  pausedAt: NOW - 4 * 60_000,
}

const FAILED: MailImport = {
  ...RUNNING,
  id: "imp_failed",
  status: "failed",
  error:
    "The connection to imap.gmail.com closed after 3 retries (ECONNRESET). Folders that finished are kept.",
  folders: [
    RUNNING.folders[0] as Folder,
    folder({
      name: "[Gmail]/Sent Mail",
      folder: "sent",
      source: 2186,
      imported: 1688,
      failed: 17,
      lastUid: 9012,
      batches: 22,
      batchesDone: 17,
      lastError: "Connection reset by imap.gmail.com during batch 18 (ECONNRESET).",
      retryable: 14,
    }),
    RUNNING.folders[2] as Folder,
    RUNNING.folders[3] as Folder,
  ],
  totals: { source: 7094, imported: 5898, duplicates: 12, failed: 17, skipped: 58 },
  ratePerMinute: null,
  etaAt: null,
  credentialsHeld: false,
  finishedAt: 1792259100000,
}

const DONE: MailImport = {
  ...RUNNING,
  id: "imp_done",
  host: "imap.fastmail.com",
  username: "hello@coursified.org",
  status: "complete",
  folders: [
    folder({
      name: "INBOX",
      folder: "inbox",
      source: 812,
      imported: 806,
      duplicates: 6,
      batches: 9,
      batchesDone: 9,
    }),
  ],
  totals: { source: 812, imported: 806, duplicates: 6, failed: 0, skipped: 0 },
  accountedFor: true,
  ratePerMinute: null,
  etaAt: null,
  startedAt: 1791913680000,
  credentialsHeld: false,
  createdAt: 1791913680000,
  finishedAt: 1791914400000,
}

const IMPORTS: Record<string, MailImport> = {
  imp_01JAF9: RUNNING,
  imp_running: { ...RUNNING, id: "imp_running" },
  imp_paused: PAUSED,
  imp_failed: FAILED,
  imp_done: DONE,
  imp_01JAFC: CATCHUP,
}

const PROBE: Probe = {
  host: "imap.gmail.com",
  port: 993,
  folders: [
    { name: "INBOX", messages: 4210, folder: "inbox", label: null, skipped: false, skipReason: null },
    {
      name: "[Gmail]/Sent Mail",
      messages: 2186,
      folder: "sent",
      label: null,
      skipped: false,
      skipReason: null,
    },
    {
      name: "Receipts",
      messages: 640,
      folder: "archive",
      label: "receipts",
      skipped: false,
      skipReason: null,
    },
    {
      name: "[Gmail]/All Mail",
      messages: 9921,
      folder: null,
      label: null,
      skipped: true,
      skipReason: "Every message here is already in another folder, so copying it would make duplicates.",
    },
    {
      name: "[Gmail]/Spam",
      messages: 58,
      folder: "spam",
      label: null,
      skipped: true,
      skipReason: "Spam isn’t copied by default.",
    },
    {
      name: "[Gmail]/Trash",
      messages: 311,
      folder: "trash",
      label: null,
      skipped: true,
      skipReason: "Trash isn’t copied by default.",
    },
    {
      name: "[Gmail]",
      messages: null,
      folder: null,
      label: null,
      skipped: true,
      skipReason: "A container folder with no messages of its own.",
    },
  ],
}

const EXPORT_RUNNING: MailExport = {
  id: "exp_01JAG4",
  status: "running",
  format: "both",
  messageCount: 1904,
  size: 0,
  zipSize: 0,
  error: null,
  downloads: { mbox: null, zip: null },
  downloadsExpireAt: null,
  createdAt: NOW - 12 * 60_000,
  completedAt: null,
}
const EXPORT_DONE: MailExport = {
  id: "exp_01JAG2",
  status: "complete",
  format: "both",
  messageCount: 2756,
  size: 412830112,
  zipSize: 398102441,
  error: null,
  downloads: { mbox: "/v1/files/fixture-mbox", zip: "/v1/files/fixture-zip" },
  downloadsExpireAt: NOW + 24 * 3600_000,
  createdAt: 1792256040000,
  completedAt: 1792256880000,
}

const LABELS: Record<string, LabelBody> = {
  lbl_billing: {
    id: "lbl_billing",
    name: "billing",
    color: "blue",
    threads: 18,
    unreadThreads: 2,
    createdAt: 1788512400000,
  },
  lbl_bugs: {
    id: "lbl_bugs",
    name: "bugs",
    color: "teal",
    threads: 11,
    unreadThreads: 1,
    createdAt: 1788512460000,
  },
  lbl_partners: {
    id: "lbl_partners",
    name: "partners",
    color: "navy",
    threads: 6,
    unreadThreads: 0,
    createdAt: 1788692400000,
  },
  lbl_enrolment: {
    id: "lbl_enrolment",
    name: "enrolment",
    color: "pine",
    threads: 23,
    unreadThreads: 1,
    createdAt: 1789048800000,
  },
  lbl_refunds: {
    id: "lbl_refunds",
    name: "refunds",
    color: "slate",
    threads: 4,
    unreadThreads: 0,
    createdAt: 1789979400000,
  },
}

const TEST: RuleTest = {
  matched: [{ id: "rul_01", name: "Billing questions" }],
  outcome: {
    matched: ["rul_01"],
    folder: null,
    labelIds: ["lbl_billing"],
    markRead: false,
    star: false,
    skipSpamCheck: false,
    forwards: [],
    autoReplies: [],
    webhooks: [],
    assignee: null,
    stoppedAt: null,
  },
  authScore: { score: 0.4, reasons: [{ rule: "FREEMAIL_FROM", points: 0.4 }] },
  filedWith: {
    folder: "inbox",
    spamScore: 0.4,
    spamReasons: [{ rule: "FREEMAIL_FROM", points: 0.4 }],
    rulesMatched: ["rul_01"],
  },
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 16) || "new"
const isNew = (mb: string | undefined) => mb === "mbx_new"

export const PAGES_OVERRIDES: readonly MailOverride[] = [
  /* ── rules ── */
  {
    method: "GET",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules$`),
    answer: ([, mb]) => ok(isNew(mb) ? { rules: [] } : RULES),
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules$`),
    answer: (_m, body) => {
      const b = obj(body)
      const rule: Rule = {
        id: `rul_${slug(String(b.name ?? "new"))}`,
        name: String(b.name ?? "New rule"),
        enabled: b.enabled !== false,
        match: b.match === "any" ? "any" : "all",
        conditions: (b.conditions as Rule["conditions"]) ?? [],
        actions: (b.actions as Rule["actions"]) ?? [],
        stop: b.stop === true,
        position: RULES.rules.length,
        matchCount: 0,
        lastMatchedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }
      return ok(rule)
    },
  },
  {
    method: "PUT",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules/order$`),
    answer: (_m, body) => {
      const ids = (obj(body).ruleIds as string[] | undefined) ?? []
      const rules: Rule[] = []
      ids.forEach((id, i) => {
        const r = RULES.rules.find((x) => x.id === id)
        if (r) rules.push({ ...r, position: i })
      })
      return ok({ rules })
    },
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules/test$`),
    answer: () => ok(TEST),
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules/([^/]+)/apply$`),
    answer: (_m, body) => {
      const r: RuleApply = obj(body).cursor
        ? { examined: 212, matched: 9, changed: 9, skippedActions: ["webhook"], nextCursor: null }
        : {
            examined: 500,
            matched: 41,
            changed: 38,
            skippedActions: ["webhook"],
            nextCursor: "eyJ1IjoiMDFKQUUifQ",
          }
      return ok(r)
    },
  },
  {
    method: "PATCH",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules/([^/]+)$`),
    answer: ([, , id], body) => {
      const r = RULES.rules.find((x) => x.id === id) ?? (RULES.rules[0] as Rule)
      return ok({ ...r, ...obj(body), id, updatedAt: NOW })
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/mailboxes/${MB}/rules/([^/]+)$`),
    answer: ([, , id]) => ok({ deleted: id }),
  },

  /* ── senders ── */
  {
    method: "GET",
    path: new RegExp(`^/v1/mailboxes/${MB}/senders$`),
    answer: ([, mb]) => ok(isNew(mb) ? { senders: [] } : SENDERS),
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/senders$`),
    answer: (_m, body) => {
      const b = obj(body)
      return ok({
        value: String(b.value ?? ""),
        list: b.list === "block" ? "block" : "allow",
        source: "user",
        createdAt: NOW,
      })
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/mailboxes/${MB}/senders/([^/]+)$`),
    answer: ([, , v]) => ok({ removed: decodeURIComponent(v ?? "") }),
  },

  /* ── imports ── */
  {
    method: "GET",
    path: new RegExp(`^/v1/mailboxes/${MB}/imports$`),
    answer: ([, mb]) => {
      const list: ImportList = { imports: isNew(mb) ? [] : [RUNNING, CATCHUP, DONE] }
      return ok(list)
    },
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/imports/probe$`),
    answer: (_m, body) => {
      const b = obj(body)
      if (String(b.password ?? "") === "wrong")
        return {
          status: 400,
          body: {
            _tag: "InvalidRequest",
            field: "password",
            message: "imap.gmail.com refused the login: check the app password.",
            requestId: "fixture",
          },
        }
      return ok({ ...PROBE, host: String(b.host || PROBE.host), port: Number(b.port || 993) })
    },
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/imports$`),
    answer: (_m, body) => {
      const b = obj(body)
      if (b.source === "mbox")
        return ok({
          ...RUNNING,
          id: "imp_running",
          source: "mbox",
          host: null,
          port: null,
          username: null,
          folders: [],
          startedAt: NOW,
          createdAt: NOW,
        })
      return ok({
        ...RUNNING,
        id: "imp_running",
        host: String(b.host ?? RUNNING.host),
        username: String(b.username ?? RUNNING.username),
      })
    },
  },
  {
    method: "GET",
    path: new RegExp(`^/v1/mailboxes/${MB}/imports/([^/]+)$`),
    answer: ([, , id]) => {
      const imp = IMPORTS[id ?? ""]
      return imp
        ? ok(imp)
        : { status: 404, body: { _tag: "NotFound", message: `No import ${id}.`, requestId: "fixture" } }
    },
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/imports/([^/]+)/(pause|resume|cancel|retry-failed)$`),
    answer: ([, , id, action]) => {
      const imp = IMPORTS[id ?? ""] ?? RUNNING
      if (action === "pause")
        return ok({ ...imp, status: "paused", pausedAt: NOW, ratePerMinute: null, etaAt: null })
      if (action === "resume") return ok({ ...imp, status: "running", pausedAt: null, ratePerMinute: 212 })
      if (action === "cancel")
        return ok({ ...imp, status: "cancelled", credentialsHeld: false, finishedAt: NOW })
      const retry: MailImport = {
        ...imp,
        id: "imp_running",
        status: "running",
        error: null,
        retryOf: imp.id,
        folders: imp.folders
          .filter((f) => Number(f.retryable) > 0)
          .map((f) => ({
            ...f,
            source: f.retryable,
            imported: 0,
            failed: 0,
            duplicates: 0,
            retryable: 0,
            lastError: null,
          })),
        totals: {
          source: imp.folders.reduce((n, f) => n + Number(f.retryable), 0),
          imported: 0,
          duplicates: 0,
          failed: 0,
          skipped: 0,
        },
        credentialsHeld: true,
        startedAt: NOW,
        finishedAt: null,
      }
      return ok(retry)
    },
  },

  /* ── exports ── */
  {
    method: "GET",
    path: new RegExp(`^/v1/mailboxes/${MB}/exports$`),
    answer: ([, mb]) => {
      const list: ExportList = {
        exports: isNew(mb) ? [] : mb === "mbx_hello" ? [EXPORT_DONE] : [EXPORT_RUNNING, EXPORT_DONE],
      }
      return ok(list)
    },
  },
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/exports$`),
    answer: () => ok({ ...EXPORT_RUNNING, messageCount: 0, createdAt: NOW }),
  },
  {
    method: "GET",
    path: new RegExp(`^/v1/mailboxes/${MB}/exports/([^/]+)$`),
    answer: ([, , id]) => ok(id === EXPORT_DONE.id ? EXPORT_DONE : EXPORT_RUNNING),
  },

  /* ── labels ── */
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/labels$`),
    answer: (_m, body) => {
      const b = obj(body)
      const name = String(b.name ?? "label")
      const l: LabelBody = {
        id: `lbl_${slug(name)}`,
        name,
        color: (b.color as LabelBody["color"]) ?? null,
        threads: 0,
        unreadThreads: 0,
        createdAt: NOW,
      }
      return ok(l)
    },
  },
  {
    method: "PATCH",
    path: new RegExp(`^/v1/mailboxes/${MB}/labels/([^/]+)$`),
    answer: ([, , id], body) => {
      const base = LABELS[id ?? ""] ?? {
        id: id ?? "",
        name: "label",
        color: null,
        threads: 0,
        unreadThreads: 0,
        createdAt: NOW,
      }
      return ok({ ...base, ...obj(body), id })
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/mailboxes/${MB}/labels/([^/]+)$`),
    answer: ([, , id]) => ok({ deleted: id }),
  },

  /* ── smart folders ── */
  {
    method: "POST",
    path: new RegExp(`^/v1/mailboxes/${MB}/smart-folders$`),
    answer: (_m, body) => {
      const b = obj(body)
      const sf: SmartFolder = {
        id: `sf_${slug(String(b.name ?? "new"))}`,
        name: String(b.name ?? ""),
        q: String(b.q ?? ""),
        createdAt: NOW,
      }
      return ok(sf)
    },
  },
  {
    method: "PATCH",
    path: new RegExp(`^/v1/mailboxes/${MB}/smart-folders/([^/]+)$`),
    answer: ([, , id], body) => {
      const b = obj(body)
      const sf: SmartFolder = {
        id: id ?? "",
        name: String(b.name ?? ""),
        q: String(b.q ?? ""),
        createdAt: 1791740880000,
      }
      return ok(sf)
    },
  },
  {
    method: "DELETE",
    path: new RegExp(`^/v1/mailboxes/${MB}/smart-folders/([^/]+)$`),
    answer: ([, , id]) => ok({ deleted: id }),
  },
]
