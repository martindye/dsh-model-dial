/**
 * Session-log tail for the model dial: DSH appends its session events as
 * jsonl lines inside concatenated zstd frames (session.v4.jsonl.zstd).
 * Prompt compaction — the harness summarising the old context, a few
 * minutes of model time — is bracketed by compaction/start and
 * compaction/end events, which is the only place that state is visible.
 *
 * Pure/tame on purpose: the frame walker and event parser are unit-tested
 * against copies of real session logs; the controller owns the cursor.
 */
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const ZSTD_MAGIC = 0xfd2fb528

/**
 * Walk bytes from `from`, collecting every COMPLETE zstd frame.
 * Returns the frames plus `next`: the offset to resume from — the end of
 * the last complete frame, or `from` itself when nothing completed (a
 * partial frame at the tail simply waits for more bytes).
 */
export function scanZstdFrames(
  buf: Buffer,
  from: number,
): { frames: { start: number; end: number }[]; next: number } {
  const frames: { start: number; end: number }[] = []
  let pos = Math.max(0, from)
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) { pos += 1; continue }
    const end = walkZstdFrame(buf, pos)
    if (end === null) {
      // Incomplete at the tail (or junk): a real frame here is small, so
      // only wait when the magic sits near the end of the buffer.
      if (pos > buf.length - (1 << 20)) break
      pos += 4
      continue
    }
    frames.push({ start: pos, end })
    pos = end
  }
  return { frames, next: frames.length > 0 ? frames[frames.length - 1].end : from }
}

/** Frame header + block walk; end offset, or null when bytes run out. */
function walkZstdFrame(buf: Buffer, start: number): number | null {
  let offset = start + 4
  if (offset >= buf.length) return null
  const descriptor = buf.readUInt8(offset); offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (buf.length - offset < remainingHeaderBytes) return null
  offset += remainingHeaderBytes
  for (;;) {
    if (buf.length - offset < 3) return null
    const blockHeader = buf.readUIntLE(offset, 3); offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (buf.length - offset < (blockType === 1 ? 1 : blockSize)) return null
    offset += blockType === 1 ? 1 : blockSize
    if (lastBlock) break
  }
  if (checksum) {
    if (buf.length - offset < 4) return null
    offset += 4
  }
  return offset
}

/** Decompress every complete frame and return the concatenated text. */
export function framesToText(buf: Buffer, frames: { start: number; end: number }[]): string {
  const parts: string[] = []
  for (const f of frames) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'))
    } catch { /* a torn frame is skipped, never fatal */ }
  }
  return parts.join('\n')
}

export interface CompactionEvent {
  kind: 'start' | 'end'
  /** data.compactionId (present on every real event; null only if absent). */
  id: string | null
  /** Epoch ms from the event's time field (starts only). */
  time: number | null
}

/**
 * Pull compaction events out of a chunk of session-log jsonl, in order.
 * One chunk may span several compaction cycles, so the caller replays the
 * list rather than squashing it.
 */
export function parseCompactionEvents(text: string): CompactionEvent[] {
  const out: CompactionEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev: { type?: unknown; time?: unknown; data?: { compactionId?: unknown } }
    try { ev = JSON.parse(line) } catch { continue }
    const id = typeof ev.data?.compactionId === 'string' ? ev.data.compactionId : null
    if (ev.type === 'compaction/start' && typeof ev.time === 'number') out.push({ kind: 'start', id, time: ev.time })
    else if (ev.type === 'compaction/end') out.push({ kind: 'end', id, time: null })
  }
  return out
}

/**
 * The most recently written session.v4.jsonl.zstd under the sessions dir
 * (sessions/<project>/session-<id>/session.v4.jsonl.zstd), or null.
 */
export function findNewestSessionLog(sessionsDir: string): string | null {
  let projects: string[]
  try { projects = readdirSync(sessionsDir) } catch { return null }
  let newest: { file: string; mtime: number } | null = null
  for (const project of projects) {
    let sessions: string[]
    try { sessions = readdirSync(path.join(sessionsDir, project)) } catch { continue }
    for (const session of sessions) {
      const file = path.join(sessionsDir, project, session, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(file)
        if (!newest || st.mtimeMs > newest.mtime) newest = { file, mtime: st.mtimeMs }
      } catch { /* project dir without a session log */ }
    }
  }
  return newest?.file ?? null
}
