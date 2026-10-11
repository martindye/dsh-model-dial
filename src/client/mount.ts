/**
 * Client wiring for @martin/dsh-model-dial: mount the one Remote
 * (modelDial.status) and register the dial in the session header's
 * actions row, right of the shipped header utilities.
 *
 * Note: `conversation.session.header.corner` is a single slot owned by
 * the app's own controls (sidebar expand button, voice auto-read
 * toggle), so the dial must not fight for that seat.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ModelStatus } from '../model.ts'
import { Dial } from './Dial.tsx'
import { NS, en, zh } from './locales.ts'

export const inject = ['remote', 'slots', 'locale']

/** Pass-through codec (the bundle has no zod): the runtime only needs the shape. */
function passThroughCodec(typeSymbol: string): unknown {
  return {
    mode: 'strict',
    typeSymbol,
    create: () => ({
      parse: (value: unknown) => value,
      safeParse: (value: unknown) => ({ success: true, data: value }),
    }),
  }
}

const DIAL_REMOTE = {
  package: '@martin/dsh-model-dial',
  descriptors: [{
    id: '@martin/dsh-model-dial#modelDial/status',
    service: 'modelDialController',
    namespace: 'modelDial',
    method: 'status',
    invocation: { kind: 'direct' },
    parameters: [],
    result: passThroughCodec('@martin/dsh-model-dial#ModelStatus'),
  }],
} as const

export interface DialRemote {
  status?: () => Promise<ModelStatus | null>
}

/**
 * The typert remote resolves to the result envelope ({ ok, value }), not
 * the bare value — unwrap it (same pattern as the dsh-voice client).
 */
function unwrap(status: unknown): ModelStatus | null {
  if (status && typeof status === 'object' && 'ok' in status) {
    const r = status as { ok: boolean; value?: unknown }
    return r.ok && r.value !== null && typeof r.value === 'object' ? (r.value as ModelStatus) : null
  }
  return (status as ModelStatus | null) ?? null
}

export async function mountDial(ctx: Context): Promise<() => Promise<void>> {
  const contribution = DIAL_REMOTE as unknown as TypertRemoteContribution
  const disposeRemote = await ctx.remote.$mount(contribution)
  // The Remote proxy gates namespace access by the fiber's inject list, and
  // this fiber only declares 'remote': take the namespace lookup once, here.
  const ns = ctx.get('remote.modelDial') as DialRemote | undefined

  const ui = ctx.inject(['slots', 'locale'], (c: Context) => {
    c.effect(() => c.locale.register(NS, { zh, en }))
    c.slots.inject('conversation.session.header.actions', () => c.slots.register({
      name: 'conversation.session.header.actions',
      id: 'model-dial',
      // After the shipped actions (preset label, jobs, subagents): far right
      // of the header band, next to the corner.
      order: 900,
      locale: NS,
      inject: () => ({
        status: () => Promise.resolve(ns)
          .then((n) => n?.status?.())
          .then(unwrap)
          .catch(() => null),
      }),
    }, Dial))
  })

  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
