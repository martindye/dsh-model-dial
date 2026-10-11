/**
 * The dial itself: a 34px progress gauge in the session header.
 *   processing -> amber ring filling with the server's own progress %, % in the middle
 *   otherwise  -> grey ring with a dot (idle, generating, or server down)
 * A small task label ("prompt processing" / "generating") sits to the right
 * while work is active, and nothing when idle.
 * No speeds and no totals on the dial — those already live in the app's bar.
 */
import { useEffect, useState } from 'react'
import type { ModelStatus } from '../model.ts'

const R = 15
const CIRC = 2 * Math.PI * R
/** A progress line older than this means "no active progress": grey. */
const LIVE_MS = 3000

export interface DialProps {
  status?: () => Promise<ModelStatus | null>
}

export function Dial({ status }: DialProps) {
  const [st, setSt] = useState<ModelStatus | null>(null)

  useEffect(() => {
    let live = true
    const poll = async () => {
      try {
        const s = await status?.()
        if (live && s) setSt(s)
      } catch { /* cosmetic only */ }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [status])

  const pct = st?.prefillPercent ?? 0
  const gauge = st?.phase === 'prefill'
    && st.progressAt !== null && st.progressAt !== undefined
    && st.prefillPercent !== null
    && Date.now() - st.progressAt < LIVE_MS
  const color = gauge ? '#f59e0b' : '#6b7280'
  const arc = gauge ? Math.min(1, Math.max(0.02, pct)) : 0
  const center = gauge ? `${Math.round(pct * 100)}%` : ''
  /** Small task label shown to the right of the ring while work is active. */
  const label = gauge ? 'prompt processing' : st?.phase === 'decode' ? 'generating' : ''
  const title = gauge
    ? `Processing prompt · ${Math.round(pct * 100)}%`
    : st?.phase === 'decode'
      ? 'Generating'
      : st?.phase === 'down'
        ? 'Model server unreachable at 127.0.0.1:8080'
        : 'No active processing'

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 6, lineHeight: 1 }}
      title={title}
      data-model-dial={gauge ? 'progress' : (st?.phase ?? 'idle')}
    >
      <svg width={34} height={34} viewBox="0 0 34 34" aria-hidden="true">
        <circle cx={17} cy={17} r={R} fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth={3} />
        {arc > 0 && (
          <circle
            cx={17}
            cy={17}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={`${CIRC * arc} ${CIRC}`}
            transform="rotate(-90 17 17)"
          />
        )}
        {gauge ? (
          <text
            x={17}
            y={17.5}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize={7.5}
            fill={color}
          >
            {center}
          </text>
        ) : (
          <circle cx={17} cy={17} r={3} fill="#6b7280" opacity={0.6} />
        )}
      </svg>
      {label !== '' && (
        <span style={{ fontSize: 8, color: '#9ca3af', whiteSpace: 'nowrap', userSelect: 'none' }}>
          {label}
        </span>
      )}
    </div>
  )
}
