/**
 * Unit: budget-advisor tool group, spec 11 (cost-accuracy-tradeoff) + spec 60 (reasoning-cost-model).
 *
 * Host setup mirrors test/unit/reasoning-core.spec.ts: a real Cordis Context
 * with the real dsh services.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { budgetAdvisorTools } from '../../src/tools/budget-advisor.ts'
import { defineTool } from '../../src/tools/shared.ts'
import { DEFAULT_SESSION } from '../../src/state/episode.ts'

const TOOL_NAME = 'fable51_budget-advisor'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  const registered = new Set(ctx.tools.schemas().map((schema) => schema.name))
  for (const spec of budgetAdvisorTools()) {
    const name = `fable51_${spec.name}`
    if (registered.has(name)) continue
    ctx.tools.register(defineTool(spec, { service: ctx.fable51, sessionKey: DEFAULT_SESSION }))
  }
  return ctx
}

interface Envelope {
  ok: boolean
  spec: string
  output: Record<string, unknown>
  verdict: string
  unverified: string[]
  rerun: boolean
  gates: unknown[]
}

interface ToolOutcome {
  isError: boolean
  value: Envelope
  content: unknown
}

/** The advisor's inner output, typed so the assertions stay checked. */
interface AdvisorOutput {
  taskClass: 'bounded' | 'search' | 'multihop' | 'open'
  recommended: { stageTokenBudget: number; maxForkDepth: number; effortTier: 'low' | 'mid' | 'high' | 'max' }
  confidence: 'high' | 'medium' | 'low'
  rationale: string
  stageStats: Array<{
    stage: string
    count: number
    p50Tokens: number
    p90Tokens: number
    p50LatencyMs: number
    p90LatencyMs: number
    avgRisk: number
  }>
  sampleSize: number
}

async function dispatch(ctx: Context, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c1'), name, arguments: args })
  return result as unknown as ToolOutcome
}

async function run(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const outcome = await dispatch(ctx, name, args)
  assert.equal(outcome.isError, false, `${name} failed: ${JSON.stringify(outcome.content)}`)
  return outcome.value
}

async function runAdvisor(ctx: Context, args: Record<string, unknown>): Promise<AdvisorOutput> {
  const res = await run(ctx, TOOL_NAME, args)
  return res.output as unknown as AdvisorOutput
}

describe('fable51 budget-advisor tools', () => {
  it('registers the budget-advisor tool under fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((schema) => schema.name)
      assert.ok(names.includes(TOOL_NAME), `expected ${TOOL_NAME} in [${names.join(', ')}]`)
      assert.ok(!names.includes(TOOL_NAME.slice('fable51_'.length)), `no un-namespaced tool may exist at root`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns defaults when cost ledger is empty', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, { taskClass: 'bounded' })
      assert.equal(res.spec, '11')
      assert.equal(res.verdict, 'verified')
      const out = res.output as unknown as AdvisorOutput
      assert.equal(out.taskClass, 'bounded')
      assert.equal(out.confidence, 'low')
      assert.ok(typeof out.recommended.stageTokenBudget === 'number')
      assert.ok(typeof out.recommended.maxForkDepth === 'number')
      assert.ok(['low', 'mid', 'high', 'max'].includes(out.recommended.effortTier))
      assert.ok(typeof out.rationale === 'string')
      assert.ok(Array.isArray(out.stageStats))
      assert.equal(out.sampleSize, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('derives the recommendation from a populated cost ledger', async () => {
    const ctx = await setup()
    try {
      // The default answer for an empty ledger, so the test can prove the
      // populated answer came from the data and not from the fallback.
      const empty = await runAdvisor(ctx, { taskClass: 'open' })
      const defaultBudget = empty.recommended.stageTokenBudget

      // Ten bookings on one stage: p90 is 200000, and 'open' scales by 5.
      for (let i = 0; i < 10; i += 1) {
        ctx.fable51.recordCost({
          stage: 'tool:fable51_chain-vs-tree',
          tokens: 200_000,
          latencyMs: 1200,
          riskWeight: 0,
          at: Date.now(),
        })
      }

      // minSamplesPerStage 2 drops the advisor's own single booking, so the
      // stats describe the stage under test and nothing else.
      const out = await runAdvisor(ctx, { taskClass: 'open', minSamplesPerStage: 2 })

      assert.equal(out.taskClass, 'open')
      assert.ok(out.sampleSize >= 10, `the ledger size must be reported, got ${out.sampleSize}`)
      assert.equal(out.stageStats.length, 1, 'one stage produced bookings')
      assert.equal(out.stageStats[0]?.stage, 'tool:fable51_chain-vs-tree')
      assert.equal(out.stageStats[0]?.count, 10)
      assert.equal(out.stageStats[0]?.p90Tokens, 200_000, 'p90 must come from the bookings')
      assert.equal(out.stageStats[0]?.p50Tokens, 200_000)

      // 200000 * 5.0 = 1000000, far above the empty-ledger fallback.
      assert.equal(out.recommended.stageTokenBudget, 1_000_000)
      assert.ok(
        out.recommended.stageTokenBudget !== defaultBudget,
        'the populated answer must differ from the empty-ledger default',
      )
      // 'open' needs 30 samples for high confidence; ten earn medium.
      assert.equal(out.confidence, 'medium')
      assert.ok(out.rationale.includes('tool:fable51_chain-vs-tree'), `rationale must name the stage: ${out.rationale}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('excludes a stage below the minimum sample count', async () => {
    const ctx = await setup()
    try {
      ctx.fable51.recordCost({ stage: 'tool:rare', tokens: 1000, latencyMs: 10, riskWeight: 0, at: Date.now() })
      const out = await runAdvisor(ctx, { taskClass: 'search', minSamplesPerStage: 2 })

      assert.equal(out.sampleSize, 1)
      assert.equal(out.stageStats.length, 0, 'a stage with one sample must not be reported')
      assert.equal(out.confidence, 'low')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns different defaults for each task class', async () => {
    // Use separate contexts to avoid cache interference between different taskClass calls
    const contexts = await Promise.all([
      setup(),
      setup(),
      setup(),
      setup(),
    ])
    try {
      const bounded = await runAdvisor(contexts[0], { taskClass: 'bounded' })
      const search = await runAdvisor(contexts[1], { taskClass: 'search' })
      const multihop = await runAdvisor(contexts[2], { taskClass: 'multihop' })
      const open = await runAdvisor(contexts[3], { taskClass: 'open' })

      // Bounded should have lowest budget and effort
      assert.ok(bounded.recommended.stageTokenBudget <= search.recommended.stageTokenBudget)
      assert.ok(search.recommended.stageTokenBudget <= multihop.recommended.stageTokenBudget)
      assert.ok(multihop.recommended.stageTokenBudget <= open.recommended.stageTokenBudget)

      // Fork depth should increase
      assert.ok(bounded.recommended.maxForkDepth <= search.recommended.maxForkDepth)
      assert.ok(search.recommended.maxForkDepth <= multihop.recommended.maxForkDepth)
      assert.ok(multihop.recommended.maxForkDepth <= open.recommended.maxForkDepth)

      // Effort tier should increase
      const effortOrder: Record<AdvisorOutput['recommended']['effortTier'], number> = { low: 0, mid: 1, high: 2, max: 3 }
      assert.ok(effortOrder[bounded.recommended.effortTier] <= effortOrder[search.recommended.effortTier])
      assert.ok(effortOrder[search.recommended.effortTier] <= effortOrder[multihop.recommended.effortTier])
      assert.ok(effortOrder[multihop.recommended.effortTier] <= effortOrder[open.recommended.effortTier])
    } finally {
      await Promise.all(contexts.map((c) => c.fiber.dispose()))
    }
  })

  it('rejects invalid taskClass', async () => {
    const ctx = await setup()
    try {
      const outcome = await dispatch(ctx, TOOL_NAME, { taskClass: 'invalid' })
      assert.equal(outcome.isError, false, 'malformed argument must answer, not throw')
      const value = outcome.value as unknown as { ok: boolean; verdict: string; output: Record<string, unknown>; unverified: string[] }
      assert.equal(value.ok, false)
      assert.equal(value.verdict, 'unverified')
      assert.ok(String(value.output.error).length > 0)
      assert.equal(value.unverified[0], value.output.error)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects missing taskClass', async () => {
    const ctx = await setup()
    try {
      const outcome = await dispatch(ctx, TOOL_NAME, {})
      assert.equal(outcome.isError, false)
      const value = outcome.value as unknown as { ok: boolean; verdict: string; output: Record<string, unknown>; unverified: string[] }
      assert.equal(value.ok, false)
      assert.equal(value.verdict, 'unverified')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('second call with same args replays cache (spec 19)', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, TOOL_NAME, { taskClass: 'search' })
      assert.equal(first.rerun, false, 'first call must not be a rerun')

      const second = await run(ctx, TOOL_NAME, { taskClass: 'search' })
      assert.equal(second.rerun, true, 'second call must replay the cache')
      assert.deepEqual(second.output, first.output, 'rerun must replay the same output')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts historyWindow and minSamplesPerStage parameters', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, { taskClass: 'multihop', historyWindow: 100, minSamplesPerStage: 5 })
      assert.equal(res.spec, '11')
      assert.equal(res.verdict, 'verified')
      const out = res.output as unknown as AdvisorOutput
      assert.equal(out.taskClass, 'multihop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('output schema includes all required fields', async () => {
    const ctx = await setup()
    try {
      const out = await runAdvisor(ctx, { taskClass: 'open' })

      assert.ok('taskClass' in out)
      assert.ok('recommended' in out)
      assert.ok('confidence' in out)
      assert.ok('rationale' in out)
      assert.ok('stageStats' in out)
      assert.ok('sampleSize' in out)

      assert.ok('stageTokenBudget' in out.recommended)
      assert.ok('maxForkDepth' in out.recommended)
      assert.ok('effortTier' in out.recommended)

      assert.ok(['high', 'medium', 'low'].includes(out.confidence))
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
