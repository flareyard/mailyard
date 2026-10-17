/**
 * A ZIP writer for exports: stored entries (mail is mostly already compressed or base64), written as
 * a stream of parts so a large mailbox never has to fit in memory. ZIP64 records are always written
 * at the end, and per entry when sizes or offsets pass 4 GiB, so any size of export opens everywhere.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++)
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const MAX32 = 0xffffffff
const enc = new TextEncoder()

const dosTime = (ms: number) => {
  const d = new Date(ms)
  const year = Math.max(1980, d.getUTCFullYear())
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  }
}

/** What the central directory needs about an entry; small, so it can be kept between Workflow steps. */
export interface CentralEntry {
  readonly name: string
  readonly crc: number
  readonly size: number
  readonly offset: number
  readonly modified: number
}

/** A local file header and the entry's bytes, starting at `offset` in the archive. */
export const localEntry = (name: string, content: Uint8Array, offset: number, modified: number) => {
  const nameBytes = enc.encode(name)
  const crc = crc32(content)
  const big = content.length >= MAX32
  const extra = big ? zip64Extra(content.length, content.length, null) : new Uint8Array(0)
  const header = new Uint8Array(30 + nameBytes.length + extra.length)
  const v = new DataView(header.buffer)
  const { time, date } = dosTime(modified)
  v.setUint32(0, 0x04034b50, true)
  v.setUint16(4, 45, true) // version needed: 4.5 (ZIP64)
  v.setUint16(6, 0x0800, true) // UTF-8 names
  v.setUint16(8, 0, true) // stored
  v.setUint16(10, time, true)
  v.setUint16(12, date, true)
  v.setUint32(14, crc, true)
  v.setUint32(18, big ? MAX32 : content.length, true)
  v.setUint32(22, big ? MAX32 : content.length, true)
  v.setUint16(26, nameBytes.length, true)
  v.setUint16(28, extra.length, true)
  header.set(nameBytes, 30)
  header.set(extra, 30 + nameBytes.length)
  const bytes = new Uint8Array(header.length + content.length)
  bytes.set(header)
  bytes.set(content, header.length)
  return { bytes, entry: { name, crc, size: content.length, offset, modified } satisfies CentralEntry }
}

const zip64Extra = (uncompressed: number | null, compressed: number | null, offset: number | null) => {
  const fields = [uncompressed, compressed, offset].filter((f): f is number => f !== null)
  const out = new Uint8Array(4 + fields.length * 8)
  const v = new DataView(out.buffer)
  v.setUint16(0, 0x0001, true)
  v.setUint16(2, fields.length * 8, true)
  for (const [i, f] of fields.entries()) v.setBigUint64(4 + i * 8, BigInt(f), true)
  return out
}

/** The central directory and end records, written after the last entry at `offset`. */
export const centralDirectory = (entries: ReadonlyArray<CentralEntry>, offset: number) => {
  const records: Array<Uint8Array> = []
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const bigSize = e.size >= MAX32
    const bigOffset = e.offset >= MAX32
    const extra =
      bigSize || bigOffset
        ? zip64Extra(bigSize ? e.size : null, bigSize ? e.size : null, bigOffset ? e.offset : null)
        : new Uint8Array(0)
    const r = new Uint8Array(46 + nameBytes.length + extra.length)
    const v = new DataView(r.buffer)
    const { time, date } = dosTime(e.modified)
    v.setUint32(0, 0x02014b50, true)
    v.setUint16(4, 45, true)
    v.setUint16(6, 45, true)
    v.setUint16(8, 0x0800, true)
    v.setUint16(10, 0, true)
    v.setUint16(12, time, true)
    v.setUint16(14, date, true)
    v.setUint32(16, e.crc, true)
    v.setUint32(20, bigSize ? MAX32 : e.size, true)
    v.setUint32(24, bigSize ? MAX32 : e.size, true)
    v.setUint16(28, nameBytes.length, true)
    v.setUint16(30, extra.length, true)
    v.setUint32(42, bigOffset ? MAX32 : e.offset, true)
    r.set(nameBytes, 46)
    r.set(extra, 46 + nameBytes.length)
    records.push(r)
  }
  const cdSize = records.reduce((n, r) => n + r.length, 0)
  const zip64Eocd = new Uint8Array(56)
  const z = new DataView(zip64Eocd.buffer)
  z.setUint32(0, 0x06064b50, true)
  z.setBigUint64(4, 44n, true)
  z.setUint16(12, 45, true)
  z.setUint16(14, 45, true)
  z.setBigUint64(24, BigInt(entries.length), true)
  z.setBigUint64(32, BigInt(entries.length), true)
  z.setBigUint64(40, BigInt(cdSize), true)
  z.setBigUint64(48, BigInt(offset), true)
  const locator = new Uint8Array(20)
  const l = new DataView(locator.buffer)
  l.setUint32(0, 0x07064b50, true)
  l.setBigUint64(8, BigInt(offset + cdSize), true)
  l.setUint32(16, 1, true)
  const eocd = new Uint8Array(22)
  const e = new DataView(eocd.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, Math.min(entries.length, 0xffff), true)
  e.setUint16(10, Math.min(entries.length, 0xffff), true)
  e.setUint32(12, Math.min(cdSize, MAX32), true)
  e.setUint32(16, Math.min(offset, MAX32), true)
  const out = new Uint8Array(cdSize + zip64Eocd.length + locator.length + eocd.length)
  let p = 0
  for (const r of records) {
    out.set(r, p)
    p += r.length
  }
  out.set(zip64Eocd, p)
  out.set(locator, p + zip64Eocd.length)
  out.set(eocd, p + zip64Eocd.length + locator.length)
  return out
}
