/**
 * tools/result hook, specs 5, 7, 12, 13, 47, 58.
 *
 * Verified contract: `tools/result` is EMIT-mode with payload
 * `(exec, result)`. Observers cannot rewrite the result; this hook tags
 * provenance and records the verification/worklog trail.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Fable51Policy } from '../policy-service.ts'

interface ResultLike {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
  /** The tool's canonical output. For this bundle it is the envelope. */
  value?: unknown
}

/**
 * Whether this result was replayed from the idempotency cache.
 *
 * A replay returns the first answer instead of running the body again, and
 * the audit trail has to say so: without the mark, a replayed call leaves a
 * trail line identical to a real execution, and the operator cannot tell
 * that the tool never ran.
 */
function isReplay(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return (value as { rerun?: unknown }).rerun === true
}

export function wireToolsResult(ctx: Context): void {
  ctx.on('tools/result', (exec: { name?: string; arguments?: unknown }, result: Readonly<ResultLike>) => {
    const svc = ctx.fable51 as Fable51Policy
    const text = (result.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n')
    // spec 12: a "verified" claim is only recorded when the result carries
    // evidence (non-error, non-empty). Everything else lands unverified.
    const verified = !result.isError && text.length > 0
    // The trail belongs to the tenant that produced the call, so one tenant
    // never reads another's worklog or pays for another's tokens.
    const scopeKey = svc.scopeKeyOfExec(exec)
    const replay = isReplay(result.value)
    svc.recordWorklog({
      stage: `tool:${exec.name ?? 'unknown'}`,
      output: text.slice(0, 500),
      // A replay is an observation, not a contribution: the body did not run.
      check: replay ? 'tools/result observed (cache replay)' : 'tools/result observed',
      verdict: verified && !replay ? 'contributed' : 'neutral',
      unverified: verified
        ? (replay ? ['the answer was replayed from the cache, the body did not run'] : [])
        : ['tool result carried no verifiable evidence'],
      at: Date.now(),
    }, scopeKey)
    // spec 58: a verified tool result is new evidence, it blocks convergence.
    // The evidence belongs to the session that produced it. A replay is not
    // new evidence: the body did not run, so nothing was learned.
    if (verified && !replay) svc.markEvidence(scopeKey)
    // spec 95: coarse cost accounting per tool call.
    svc.recordCost({
      stage: `tool:${exec.name ?? 'unknown'}`,
      tokens: Math.ceil(text.length / 4),
      latencyMs: 0,
      riskWeight: result.isError ? 1 : 0,
      at: Date.now(),
    }, scopeKey)
  })
}
