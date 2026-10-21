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
    svc.recordWorklog({
      stage: `tool:${exec.name ?? 'unknown'}`,
      output: text.slice(0, 500),
      check: 'tools/result observed',
      verdict: verified ? 'contributed' : 'neutral',
      unverified: verified ? [] : ['tool result carried no verifiable evidence'],
      at: Date.now(),
    }, scopeKey)
    // spec 58: a verified tool result is new evidence, it blocks convergence.
    // The evidence belongs to the session that produced it.
    if (verified) svc.markEvidence(scopeKey)
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
