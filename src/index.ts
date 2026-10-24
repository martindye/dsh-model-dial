/**
 * Host half of @martin/dsh-model-dial.
 *
 * Publishes one `modelDial.status` Remote (no arguments) that returns the
 * live state of the local llama-server:
 *   - GET /slots on 127.0.0.1:8080  -> phase, task id, context size, decoded count
 *   - tail of the server's log file -> prefill progress %, prompt t/s, decode t/s
 *
 * The dial is decorative: nothing here may ever throw out of the poll loop,
 * and a dead server simply reports phase "down".
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ModelStatus } from './model.ts'
import {
  findNewestSessionLog,
  framesToText,
  parseCompactionEvents,
  scanZstdFrames,
} from './sessionlog.ts'

const PORT = Number(process.env.DSH_DIAL_PORT ?? 8080)
const LOG_DIR = process.env.DSH_DIAL_LOG_DIR ?? 'C:/Users/press/OneDrive/Projects/TurboQuantLlamaCppSetup/logs'
const SESSIONS_DIR = process.env.DSH_DIAL_SESSIONS_DIR ?? path.join(os.homedir(), '.dsh', 'sessions')
const SLOTS_URL = `http://127.0.0.1:${PORT}/slots`
const POLL_MS = 750
const STALE_MS = 4000
/** A compaction without its end event is dropped after this long. */
const COMPACT_TTL_MS = 15 * 60_000
/** Trailing window replayed when attaching to a (new) session log. */
const REPLAY_BYTES = 1 << 20
const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods'

interface PrefillLine { task: number; tokens: number; percent: number; tps: number; at: number }
interface DecodeLine { task: number; decoded: number; tg3: number; at: number }

const IDLE: Omit<ModelStatus, 'phase' | 'at'> = {
  task: null,
  contextTokens: null,
  prefilled: null,
  prefillTotal: null,
  prefillPercent: null,
  prefillTps: null,
  progressAt: null,
  decoded: null,
  decodeTps: null,
  compacting: false,
  compactPercent: null,
}

class ModelDialController {
  readonly typertRemote = Object.freeze({
    service: this,
    serviceKey: 'modelDialController',
    namespace: 'modelDial',
  })

  private state: ModelStatus = { phase: 'idle', at: 0, ...IDLE }
  private ticking = false
  private slotsAt = 0
  private logFile: string | null = null
  private logOffset = 0
  private tail = ''
  private prefillLine: PrefillLine | null = null
  private decodeLine: DecodeLine | null = null
  private timer: NodeJS.Timeout | null = null
  private sessionFile: string | null = null
  private sessionOffset = 0
  private compactingId: string | null = null
  private compactingSince: number | null = null
  /**
   * Last summary percent of the running compaction, held across the brief
   * slot-idle tail between the last token and the compaction/end event.
   */
  private lastCompactPercent: number | null = null

  constructor() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => { /* the dial must never take the host down with it */ })
    }, POLL_MS)
    this.timer.unref?.()
  }

  /** Latest frozen snapshot, for the Remote. */
  status(): ModelStatus {
    return this.state
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const slot = await this.fetchSlot()
      this.scanLog()
      this.scanSessionLog()
      this.synthesize(slot)
    } finally {
      this.ticking = false
    }
  }

  private async fetchSlot(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(SLOTS_URL, { signal: AbortSignal.timeout(2500) })
      if (!res.ok) return null
      const body = (await res.json()) as Record<string, unknown> | Record<string, unknown>[]
      const slot = Array.isArray(body) ? body[0] : body
      if (!slot || typeof slot !== 'object') return null
      this.slotsAt = Date.now()
      return slot
    } catch {
      return null
    }
  }

  /** Read newly appended bytes from the newest llama-server log (UTF-16LE). */
  private scanLog(): void {
    let names: string[]
    try {
      names = readdirSync(LOG_DIR)
    } catch {
      return
    }
    const candidates = names.filter(n => n.startsWith('llama-server-') && n.endsWith('.log')).sort()
    const name = candidates[candidates.length - 1]
    if (!name) return
    const file = path.join(LOG_DIR, name)
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (size % 2 !== 0) return // writer mid-code-unit; skip this tick
    if (this.logFile !== file) {
      this.logFile = file
      this.logOffset = 0
      this.tail = ''
    }
    if (size < this.logOffset) {
      this.logOffset = 0
      this.tail = ''
    }
    if (size <= this.logOffset) return
    let fd: number
    try {
      fd = openSync(file, 'r')
    } catch {
      return // locked by Tee-Object for an instant; fine
    }
    try {
      const len = Math.min(size - this.logOffset, 1 << 20)
      const buf = Buffer.alloc(len)
      const read = readSync(fd, buf, 0, len, this.logOffset)
      this.logOffset += read
      this.tail += buf.subarray(0, read).toString('utf16le')
    } catch {
      return
    } finally {
      closeSync(fd)
    }
    let nl: number
    while ((nl = this.tail.indexOf('\n')) !== -1) {
      const line = this.tail.slice(0, nl)
      this.tail = this.tail.slice(nl + 1)
      this.parseLine(line)
    }
    if (this.tail.length > 65536) this.tail = this.tail.slice(-8192)
  }

  /**
   * Tail newly appended zstd frames of the active session log and track
   * prompt compaction: compaction/start … compaction/end bracket a few
   * minutes of model time summarising the old context.
   */
  private scanSessionLog(): void {
    const file = findNewestSessionLog(SESSIONS_DIR)
    if (!file) return
    if (this.sessionFile !== file) {
      this.sessionFile = file
      // Attach at EOF on first sight; a live compaction flag survives the
      // switch (it expires via its own TTL) and replayTail re-derives it.
      this.sessionOffset = -1
    }
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return
    }
    if (this.sessionOffset < 0) {
      this.sessionOffset = size
      // The event that just made this file the newest (often a
      // compaction/start), or a compaction already in flight, sits right at
      // the attach point: replay the trailing window so it is not swallowed.
      this.replayTail(file, size)
      return
    }
    if (size < this.sessionOffset) {
      this.sessionOffset = size // file replaced or truncated: re-attach
      return
    }
    if (size === this.sessionOffset) return
    let fd: number
    try {
      fd = openSync(file, 'r')
    } catch {
      return
    }
    try {
      const len = Math.min(size - this.sessionOffset, 1 << 20)
      const buf = Buffer.alloc(len)
      const read = readSync(fd, buf, 0, len, this.sessionOffset)
      const chunk = buf.subarray(0, read)
      const { frames, next } = scanZstdFrames(chunk, 0)
      if (frames.length > 0) {
        for (const e of parseCompactionEvents(framesToText(chunk, frames))) this.applyCompactionEvent(e)
      }
      this.sessionOffset += next
    } catch {
      /* the dial must never take the host down with it */
    } finally {
      closeSync(fd)
    }
  }

  /** Feed one compaction event into the start/end state machine. */
  private applyCompactionEvent(e: { kind: 'start' | 'end'; id: string | null; time: number | null }): void {
    if (e.kind === 'start') {
      this.compactingId = e.id
      this.compactingSince = e.time
    } else if (this.compactingId === null || e.id === null || this.compactingId === e.id) {
      this.compactingId = null
      this.compactingSince = null
    }
  }

  /**
   * Re-read the trailing window of a freshly attached session log and
   * replay its compaction events, so a compaction that began (or is in
   * flight) before the attach still lights the dial.
   */
  private replayTail(file: string, size: number): void {
    if (size === 0) return
    const from = Math.max(0, size - REPLAY_BYTES)
    let fd: number
    try {
      fd = openSync(file, 'r')
    } catch {
      return
    }
    try {
      const buf = Buffer.alloc(size - from)
      const read = readSync(fd, buf, 0, size - from, from)
      const { frames } = scanZstdFrames(buf, 0)
      if (frames.length > 0) {
        for (const e of parseCompactionEvents(framesToText(buf, frames))) this.applyCompactionEvent(e)
      }
    } catch {
      /* the dial must never take the host down with it */
    } finally {
      closeSync(fd)
    }
  }

  /** True while a compaction from the session log is still running. */
  private isCompacting(): boolean {
    if (this.compactingSince === null) return false
    if (Date.now() - this.compactingSince > COMPACT_TTL_MS) {
      this.compactingSince = null // end event lost; never amber forever
      return false
    }
    return true
  }

  private parseLine(line: string): void {
    const now = Date.now()
    let m = line.match(
      /\|\s*task\s+(\d+)\s*\|\s*prompt processing, n_tokens =\s*(\d+), progress = ([\d.]+), t =\s*[\d.]+ s \/ ([\d.]+) tokens per second/,
    )
    if (m) {
      this.prefillLine = { task: Number(m[1]), tokens: Number(m[2]), percent: Math.min(1, Number(m[3])), tps: Number(m[4]), at: now }
      return
    }
    m = line.match(/\|\s*task\s+(\d+)\s*\|\s*n_decoded =\s*(\d+), tg =\s*[\d.]+ t\/s, tg_3s =\s*([\d.]+) t\/s/)
    if (m) {
      this.decodeLine = { task: Number(m[1]), decoded: Number(m[2]), tg3: Number(m[3]), at: now }
    }
  }

  private freshPrefill(task: number | null): PrefillLine | null {
    const l = this.prefillLine
    if (!l || Date.now() - l.at > 30_000) return null
    if (task !== null && l.task !== task) return null
    return l
  }

  private freshDecode(task: number | null): DecodeLine | null {
    const l = this.decodeLine
    if (!l || Date.now() - l.at > 20_000) return null
    if (task !== null && l.task !== task) return null
    return l
  }

  /**
   * Summary progress of the running compaction, 0..1: generated tokens over
   * the summarisation budget. The compaction is a single request on the
   * slot, and while it runs the slot reports the request's own cap
   * (params.max_tokens) and the live n_decoded — that ratio is the percent.
   * Held in lastCompactPercent across the slot-idle tail (last token ->
   * compaction/end event); null when unknown so the dial can spin.
   */
  private compactPercentFor(slot: Record<string, unknown> | null, compacting: boolean): number | null {
    if (!compacting) {
      this.lastCompactPercent = null
      return null
    }
    if (slot !== null && slot.is_processing === true) {
      const nextToken = (slot.next_token as Array<Record<string, unknown>> | undefined)?.[0]
      const decoded = typeof nextToken?.n_decoded === 'number' ? nextToken.n_decoded : null
      const params = slot.params as Record<string, unknown> | undefined
      const cap = typeof params?.max_tokens === 'number'
        ? params.max_tokens
        : typeof params?.n_predict === 'number'
          ? params.n_predict
          : null
      if (decoded !== null && typeof cap === 'number' && cap > 0) {
        this.lastCompactPercent = Math.min(1, Math.max(0, decoded / cap))
      }
    }
    return this.lastCompactPercent
  }

  private synthesize(slot: Record<string, unknown> | null): void {
    const now = Date.now()
    const compacting = this.isCompacting()
    const compactPercent = this.compactPercentFor(slot, compacting)
    const stale = !slot || now - this.slotsAt > STALE_MS
    const s = (slot ?? {}) as Record<string, unknown>
    const task = typeof s.id_task === 'number' ? s.id_task : null
    const contextTokens = typeof s.n_prompt_tokens === 'number' ? s.n_prompt_tokens : null
    if (stale) {
      this.state = { phase: 'down', at: now, ...IDLE, compacting }
      return
    }
    const nextToken = (s.next_token as Array<Record<string, unknown>> | undefined)?.[0]
    const decoded = typeof nextToken?.n_decoded === 'number' ? nextToken.n_decoded : 0
    const processed = typeof s.n_prompt_tokens_processed === 'number' ? s.n_prompt_tokens_processed : null
    if (s.is_processing !== true) {
      this.state = { phase: 'idle', at: now, ...IDLE, contextTokens, compacting, compactPercent }
      return
    }
    if (decoded > 0) {
      const dl = this.freshDecode(task)
      this.state = {
        phase: 'decode',
        at: now,
        task,
        contextTokens,
        prefilled: processed,
        prefillTotal: null,
        prefillPercent: null,
        prefillTps: null,
        progressAt: null,
        decoded,
        decodeTps: dl?.tg3 ?? null,
        compacting,
        compactPercent,
      }
      return
    }
    const pl = this.freshPrefill(task)
    this.state = {
      phase: 'prefill',
      at: now,
      task,
      contextTokens,
      prefilled: pl ? pl.tokens : processed,
      prefillTotal: pl && pl.percent > 0 ? Math.round(pl.tokens / pl.percent) : null,
      prefillPercent: pl ? pl.percent : null,
      prefillTps: pl ? pl.tps : null,
      progressAt: pl ? pl.at : null,
      decoded: null,
      decodeTps: null,
      compacting,
      compactPercent,
    }
  }
}

Object.defineProperty(ModelDialController.prototype, REMOTE_METHODS_KEY, {
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      { method: 'status', invocation: { kind: 'direct' } },
    ]),
  }),
})

interface HostContext {
  provide(serviceKey: string, controller: unknown): void
}

export function apply(ctx: HostContext): void {
  ctx.provide('modelDialController', new ModelDialController())
}

/** Session-log helpers, exported for the deploy probe (not part of the Remote). */
export const _internals = {
  findNewestSessionLog,
  scanZstdFrames,
  framesToText,
  parseCompactionEvents,
}
