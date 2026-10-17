import type { Folder } from "../mailbox/types.ts"

export interface FolderMapping {
  /** Skipped folders: virtual views (All Mail, Starred), drafts, and folders that hold no mail. */
  readonly skip: string | null
  readonly folder: Folder
  /** A folder without a standard meaning becomes a label, the way Gmail shows folders. */
  readonly label: string | null
}

const has = (flags: ReadonlyArray<string>, flag: string) =>
  flags.some((f) => f.toLowerCase() === flag.toLowerCase())

/**
 * Where an IMAP folder's mail goes. RFC 6154 special-use flags first, then the names servers use when
 * they don't send them (English and the common European ones).
 */
export const mapFolder = (name: string, flags: ReadonlyArray<string>): FolderMapping => {
  const lower = name.toLowerCase()
  const leaf = lower.split(/[/.]/).at(-1) ?? lower
  if (has(flags, "\\Noselect") || has(flags, "\\NonExistent"))
    return { skip: "holds no mail", folder: "archive", label: null }
  if (has(flags, "\\All") || /^\[gmail\]\/all mail$/i.test(name))
    return { skip: "a view of every folder", folder: "archive", label: null }
  if (has(flags, "\\Flagged") || /^\[gmail\]\/starred$/i.test(name))
    return { skip: "a view of starred mail", folder: "archive", label: null }
  if (has(flags, "\\Drafts") || /^(drafts?|entw(ü|ue)rfe|brouillons|borradores)$/.test(leaf)) {
    return { skip: "drafts aren't imported", folder: "archive", label: null }
  }
  if (lower === "inbox") return { skip: null, folder: "inbox", label: null }
  if (
    has(flags, "\\Sent") ||
    /^(sent|sent items|sent mail|sent messages|gesendet|envoy(é|e)s|enviados)$/.test(leaf)
  ) {
    return { skip: null, folder: "sent", label: null }
  }
  if (
    has(flags, "\\Trash") ||
    /^(trash|deleted|deleted items|deleted messages|papierkorb|corbeille|papelera|bin)$/.test(leaf)
  ) {
    return { skip: null, folder: "trash", label: null }
  }
  if (has(flags, "\\Junk") || /^(spam|junk|junk e-?mail|bulk mail|courrier ind(é|e)sirable)$/.test(leaf)) {
    return { skip: null, folder: "spam", label: null }
  }
  if (has(flags, "\\Archive") || /^(archive|archives|all archive|archiv)$/.test(leaf))
    return { skip: null, folder: "archive", label: null }
  return {
    skip: null,
    folder: "archive",
    label: name.replace(/^INBOX[./]/i, "").replace(/^\[Gmail\]\//i, ""),
  }
}
