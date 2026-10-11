/** Browser entry for @martin/dsh-model-dial. */
import type { Context } from '@deepseek-ai/cordis'
import { mountDial } from './mount.ts'

export { inject } from './mount.ts'

/**
 * Activate the model dial.
 * @param ctx - Client runtime.
 * @returns disposer for the Remote and UI slot.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  try {
    return await mountDial(ctx)
  } catch (error) {
    // Surface the real boot failure in the page console.
    console.error('DSH_MODEL_DIAL_APPLY_ERR', error)
    throw error
  }
}
