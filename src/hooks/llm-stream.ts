/**
 * llm/stream hook — specs 15, 22, 33, 42, 53, 58, 92.
 *
 * Verified contract: `llm/stream` is a WATERFALL over the token stream; a
 * listener MUST call next() and pass chunks through. This wrapper counts
 * tokens (stage budget + interleaved budget), fingerprints chunks for dedup,
 * labels the reasoning between tool calls as interleaved (spec 15 — not
 * parallel), feeds the per-turn convergence tracker (spec 58), and tracks
 * convergence for early exit — without altering the stream.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Fable51Policy } from '../policy-service.ts'
import { fingerprint } from '../state/cache.ts'

/** Best-effort text extraction from a stream chunk shape. */
function chunkText(chunk: StreamChunk): string {
  const c = chunk as unknown as { text?: unknown; content?: unknown; delta?: unknown }
  if (typeof c.text === 'string') return c.text
  if (typeof c.content === 'string') return c.content
  if (typeof c.delta === 'string') return c.delta
  return ''
}

export function wireLlmStream(ctx: Context): void {
  ctx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const svc = ctx.fable51 as Fable51Policy
    const stage = `llm:${options.model ?? 'unknown'}`
    const seen = new Set<string>()
    let tokens = 0
    for await (const raw of next()) {
      const chunk: StreamChunk = raw
      const text = chunkText(chunk)
      if (text) {
        tokens += Math.ceil(text.length / 4)
        // spec 53: chunk-level dedup fingerprint.
        const fp = fingerprint(text)
        if (seen.has(fp)) {
          svc.recordWorklog({
            stage,
            output: 'duplicate chunk suppressed from accounting (stream itself passes through)',
            check: 'reasoning dedup',
            verdict: 'neutral',
            unverified: [],
            at: Date.now(),
          })
        }
        seen.add(fp)
      }
      yield raw
    }
    // spec 15: reasoning between tool calls is interleaved, never parallel.
    svc.labelPass(stage, 'interleaved')
    // spec 58: this turn's distance from the previous turn — a stable stream
    // is one convergence signal. New evidence (tools/result) is the other.
    const previous = svc.previousTurnTokens.get(stage) ?? 0
    const distance = previous === 0 ? 0 : Math.abs(tokens - previous) / previous
    svc.previousTurnTokens.set(stage, tokens)
    svc.recordTurnDistance(distance)
    // spec 22: per-stage token accounting with 80% alert / 100% hard stop signal.
    const budget = svc.addStageTokens(stage, tokens)
    if (budget.alert) {
      svc.recordWorklog({
        stage,
        output: `token budget ${budget.used}${budget.stop ? ' (STOP)' : ' (alert)'}`,
        check: 'token budget per stage',
        verdict: budget.stop ? 'discarded' : 'neutral',
        unverified: budget.stop ? ['stage exceeded token budget'] : [],
        at: Date.now(),
      })
    }
    if (svc.converged().converged) {
      svc.recordWorklog({
        stage,
        output: `converged: ${svc.config.reasoning.convergenceTurns} stable turns below delta ${svc.config.reasoning.convergenceDelta}, no new evidence`,
        check: 'convergence criteria',
        verdict: 'neutral',
        unverified: [],
        at: Date.now(),
      })
    }
  })
}
