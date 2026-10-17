/**
 * Threading rules, kept pure so they can be tested on their own.
 *
 * A thread is a connected component of a graph whose nodes are messages. Two messages are linked when
 * one names the other's Message-ID in In-Reply-To or References (directly, or through a message-id both
 * name: an absent ancestor still joins its descendants), or when the subject fallback below links them.
 * Both relations are symmetric and depend only on the two messages, never on arrival order, so every
 * arrival order of a conversation yields the same threads.
 */

/** Reply and forward prefixes in the languages mail clients actually write them in. */
const PREFIX =
  /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw|odp|tr|rif|r|réf|enc|res|ynt|vá|vs)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]\s*)+/i
/** `[list-name]` tags mailing lists add, anywhere before the first word. */
const LIST_TAG = /^\s*(?:\[[^\]]{1,40}\]\s*)+/

export interface SubjectKey {
  /** Lowercased subject without prefixes, list tags or repeated whitespace; "" when nothing is left. */
  readonly key: string
  /** The subject carried a reply or forward prefix. */
  readonly reply: boolean
}

export const subjectKey = (subject: string): SubjectKey => {
  let rest = subject
  let reply = false
  for (let i = 0; i < 10; i++) {
    const before = rest
    rest = rest.replace(LIST_TAG, "")
    const stripped = rest.replace(PREFIX, "")
    if (stripped !== rest) reply = true
    rest = stripped
    if (rest === before) break
  }
  return { key: rest.replace(/\s+/g, " ").trim().toLowerCase(), reply }
}

/** How far apart two messages may be sent for the subject fallback to join them. */
export const SUBJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

export interface ThreadingFacts {
  readonly subjectKey: string
  readonly reply: boolean
  /** The message carried neither In-Reply-To nor References. */
  readonly headerless: boolean
  /** Date header, or arrival time when there is none. */
  readonly sentAt: number
}

/**
 * The subject fallback, for clients that drop threading headers: a reply-prefixed message without
 * In-Reply-To or References joins a message with the same subject sent within the window.
 */
export const subjectLinked = (a: ThreadingFacts, b: ThreadingFacts) =>
  a.subjectKey !== "" &&
  a.subjectKey === b.subjectKey &&
  Math.abs(a.sentAt - b.sentAt) <= SUBJECT_WINDOW_MS &&
  ((a.reply && a.headerless) || (b.reply && b.headerless))

/** Every message-id a message links through: its own, its parent's and its ancestors'. */
export const linkIds = (m: {
  readonly messageId: string | null
  readonly inReplyTo: string | null
  readonly references: ReadonlyArray<string>
}) => {
  const ids = new Set<string>()
  for (const id of [m.messageId, m.inReplyTo, ...m.references]) {
    if (id) ids.add(id.trim().toLowerCase())
  }
  return [...ids]
}
