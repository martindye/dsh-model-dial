/** Shared status shape published by the host half and consumed by the client dial. */

export type DialPhase = 'idle' | 'prefill' | 'decode' | 'down'

export interface ModelStatus {
  /** What the model is doing right now. */
  phase: DialPhase
  /** Epoch ms of the freshest /slots sample behind this status. */
  at: number
  /** llama-server task id of the current work, if any. */
  task: number | null
  /** Slot KV context size in tokens (prompt + generated so far). */
  contextTokens: number | null
  /** Prompt tokens processed so far (prefill phase). */
  prefilled: number | null
  /** Total prompt tokens of the current prefill, from the log when known. */
  prefillTotal: number | null
  /** Prefill completion 0..1, from the server's own progress line. */
  prefillPercent: number | null
  /** Prompt-processing speed, tokens per second, from the server's own line. */
  prefillTps: number | null
  /** Epoch ms of the newest progress line behind this status (null when none). */
  progressAt: number | null
  /** Generated tokens of the current task (decode phase). */
  decoded: number | null
  /** Rolling 3-second decode speed, tokens per second. */
  decodeTps: number | null
  /** The harness is compacting the prompt (summarising the old context). */
  compacting: boolean
}
