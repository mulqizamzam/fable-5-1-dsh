/**
 * tools/execute hook — spec 55 (reasoning-bandwidth).
 *
 * Verified contract: `tools/execute` is the AROUND-DISPATCH waterfall. The
 * listener receives `(exec, next)`; `next()` runs the tool body and returns
 * the normalized result, so a listener that awaits it brackets exactly the
 * body.
 *
 * The slot is taken and released INSIDE this waterfall on purpose. The
 * pre-execute waterfall is the wrong place to block: the host awaits each
 * call's pre-execute before starting the next one, and a call's result is
 * only notified at COMMIT time, which happens behind that await. Blocking
 * there with a cap below the host's own parallel limit deadlocks the host:
 * the calls already running finish, but their results are never committed,
 * so the slot is never released.
 *
 * Bracketing the body avoids that entirely. The host starts every call it
 * allows, the excess waits here for a slot, and each body releases its own
 * slot when it finishes. Excess is QUEUED, not denied.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { Fable51Policy } from '../policy-service.ts'

export function wireToolsExecute(ctx: Context): void {
  ctx.on('tools/execute', async (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> => {
    const svc = ctx.fable51 as Fable51Policy
    // A nested call is part of a pass already running, not a new parallel
    // pass. It takes no slot and never waits: waiting on a slot the caller
    // itself holds is a deadlock, and the cap would punish a dependency
    // chain instead of a fan-out.
    if (exec.parent !== undefined) return next()
    // The slot belongs to the tenant scope, so two tenants of one host never
    // share a slot and one tenant's queue never blocks another's.
    const key = svc.scopeKeyOfExec(exec)
    let granted = false
    try {
      granted = await svc.acquireSlot(key, exec.signal)
    } catch (err) {
      // A fault in the slot bookkeeping must not swallow the call: the body
      // still runs, just without a slot.
      ctx.logger('fable51').warn(`tools/execute fault, admitting the call: ${String(err)}`)
    }
    try {
      // A body that throws propagates to the registry, which turns it into an
      // error result. It must not be re-run here.
      return await next()
    } finally {
      // An abandoned wait never took a slot, so it must not free one.
      if (granted) svc.releaseSlot(key)
    }
  })
}
