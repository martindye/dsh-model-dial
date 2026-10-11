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
import path from 'node:path'
import { homedir } from 'node:os'
import type { ModelStatus } from './model.ts'

const PORT = Number(process.env.DSH_DIAL_PORT ?? 8080)
const LOG_DIR = process.env.DSH_DIAL_LOG_DIR ?? path.join(homedir(), 'OneDrive', 'Projects', 'TurboQuantLlamaCppSetup', 'logs')
const SLOTS_URL = `http://127.0.0.1:${PORT}/slots`
const POLL_MS = 750
const STALE_MS = 4000
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

  private synthesize(slot: Record<string, unknown> | null): void {
    const now = Date.now()
    const stale = !slot || now - this.slotsAt > STALE_MS
    const s = (slot ?? {}) as Record<string, unknown>
    const task = typeof s.id_task === 'number' ? s.id_task : null
    const contextTokens = typeof s.n_prompt_tokens === 'number' ? s.n_prompt_tokens : null
    if (stale) {
      this.state = { phase: 'down', at: now, ...IDLE }
      return
    }
    const nextToken = (s.next_token as Array<Record<string, unknown>> | undefined)?.[0]
    const decoded = typeof nextToken?.n_decoded === 'number' ? nextToken.n_decoded : 0
    const processed = typeof s.n_prompt_tokens_processed === 'number' ? s.n_prompt_tokens_processed : null
    if (s.is_processing !== true) {
      this.state = { phase: 'idle', at: now, ...IDLE, contextTokens }
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
