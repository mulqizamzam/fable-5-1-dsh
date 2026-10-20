/**
 * tools/pre-execute hook — spec 55 (reasoning-bandwidth).
 *
 * Verified contract: `tools/pre-execute` is a WATERFALL with payload
 * `(exec, next)`; `next()` delegates to allow, and the decision may be
 * allow / deny / cancel / ask. An async listener must observe `exec.signal`;
 * the registry re-checks cancellation after it settles but never abandons
 * its promise.
 *
 * The service caps how many passes run at once. Excess is QUEUED, not
 * denied: the call waits for a slot instead of being turned away, so a burst
 * of parallel work is throttled rather than refused.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { Fable51Policy } from '../policy-service.ts'
import { sessionKeyFromExec } from '../state/session-key.ts'

export function wireToolsPreExecute(ctx: Context): void {
  ctx.on('tools/pre-execute', async (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    const svc = ctx.fable51 as Fable51Policy
    // A nested call is part of a pass that is already running, not a new
    // parallel pass. It takes no slot and never waits for one: waiting on a
    // slot the caller itself holds is a deadlock, and the cap would then
    // punish a dependency chain instead of a fan-out.
    if (exec.parent !== undefined) return next()
    const key = sessionKeyFromExec(exec)
    try {
      const granted = await svc.acquireSlot(key, exec.signal)
      // An aborted wait never took a slot, so it must not be recorded as
      // holding one — the release side would then free a slot it never had.
      if (granted) svc.holdSlot(exec, key)
    } catch (err) {
      // A plugin fault must never block a call: admit it and say so.
      ctx.logger('fable51').warn(`tools/pre-execute fault, admitting the call: ${String(err)}`)
    }
    return next()
  })
}
