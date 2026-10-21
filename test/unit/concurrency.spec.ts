/**
 * Unit: tool concurrency safety and live-state freshness.
 *
 * The host dispatches a group of tool calls in parallel only when the tool
 * says it is safe. The bundle derives that from `effectful`: a tool that
 * touches live state is exclusive, a pure computation is not.
 *
 * The same property keeps the cache honest. A tool that READS live state
 * must not be served from the idempotency cache, or the operator gets a
 * stale picture of a running bundle.
 */
import { describe, it } from 'node:test'
import { DEFAULT_SCOPE } from '../../src/state/tenant.ts'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { allToolSpecs } from '../../src/tools/index.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

interface Envelope {
  ok: boolean
  spec: string
  output: Record<string, unknown>
  verdict: string
  rerun: boolean
}

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`c-${name}`),
    name,
    arguments: args,
  })
  assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`)
  return result.value as unknown as Envelope
}

/** The mode the host would use for this tool. */
function mode(ctx: Context, name: string): string {
  return ctx.tools.executionMode({
    signal: new AbortController().signal,
    callId: ToolCallId('m'),
    name,
    arguments: {},
  }).kind
}

describe('tool concurrency safety', () => {
  it('marks a pure tool parallel and a state-touching tool exclusive', async () => {
    const ctx = await setup()
    try {
      assert.equal(mode(ctx, 'fable51_chain-vs-tree'), 'parallel', 'a pure computation may run in parallel')
      assert.equal(mode(ctx, 'fable51_context-management'), 'parallel')
      assert.equal(mode(ctx, 'fable51_verification-gates'), 'exclusive', 'a tool that records a gate mutates shared state')
      assert.equal(mode(ctx, 'fable51_token-budget-per-stage'), 'exclusive')
      assert.equal(mode(ctx, 'fable51_reasoning-forking'), 'exclusive')
      assert.equal(mode(ctx, 'fable51_worklog-format'), 'exclusive')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('derives the flag from effectful, so a tool that starts touching state turns exclusive by itself', async () => {
    const ctx = await setup()
    try {
      // Every tool that mutates or reads live state must be effectful, and
      // every effectful tool must be exclusive. A tool that only computes
      // must be parallel.
      for (const spec of allToolSpecs()) {
        const kind = mode(ctx, `fable51_${spec.name}`)
        if (spec.effectful === true) {
          assert.equal(kind, 'exclusive', `${spec.name} is effectful and must be exclusive`)
        } else {
          assert.equal(kind, 'parallel', `${spec.name} is pure and must be parallel`)
        }
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not serve a stale picture from the cache', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'fable51_inspect', { format: 'json' })
      assert.equal(first.rerun, false, 'the first call is not a replay')

      // Something changes the state the inspector reports.
      ctx.fable51.recordCost({ stage: 'tool:baru', tokens: 999_999, latencyMs: 1, riskWeight: 0, at: Date.now() }, DEFAULT_SCOPE)

      const second = await call(ctx, 'fable51_inspect', { format: 'json' })
      assert.equal(second.rerun, false, 'a live-state reader must never replay a cached answer')
      const before = (first.output.costs as { totalTokens: number }).totalTokens
      const after = (second.output.costs as { totalTokens: number }).totalTokens
      assert.ok(after > before, `the inspector must show the new spend, got ${before} then ${after}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('recomputes the budget advisor against the live ledger', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'fable51_budget-advisor', { taskClass: 'search' })
      const sizeBefore = (first.output as { sampleSize: number }).sampleSize

      ctx.fable51.recordCost({ stage: 'tool:fable51_chain-vs-tree', tokens: 50_000, latencyMs: 10, riskWeight: 0, at: Date.now() }, DEFAULT_SCOPE)

      const second = await call(ctx, 'fable51_budget-advisor', { taskClass: 'search' })
      assert.equal(second.rerun, false, 'the advisor must not replay a cached recommendation')
      const sizeAfter = (second.output as { sampleSize: number }).sampleSize
      assert.ok(sizeAfter > sizeBefore, `the advisor must see the new booking, got ${sizeBefore} then ${sizeAfter}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
