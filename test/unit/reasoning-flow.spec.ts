/**
 * Unit: reasoning-flow tools — specs 51, 53, 54, 56, 57, 59, 61–69, 71.
 * Host: real Cordis + real dsh services (5-plugin setup; a 3-plugin host
 * leaves the policy service PENDING and registers nothing).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name, arguments: args })
}

type Envelope = { spec: string; output: Record<string, unknown>; rerun: boolean }

async function call(ctx: Context, name: string, args: unknown): Promise<Envelope> {
  const result = await execute(ctx, name, args)
  assert.equal(result.isError, false, `${name} failed: ${JSON.stringify(result.content)}`)
  return result.value as Envelope
}

describe('reasoning-flow tools', () => {
  it('registers every spec under the fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      for (const expected of ['reasoning-priority', 'reasoning-dedup', 'hypothesis-scoring', 'failure-isolation',
        'reasoning-replay', 'reasoning-audit', 'reasoning-topology', 'adaptive-branching', 'reasoning-heatmap',
        'cross-pass-consistency', 'reasoning-fingerprint', 'pass-scheduling', 'reasoning-window',
        'merge-conflict-resolution', 'reasoning-lineage', 'reasoning-backpressure']) {
        assert.ok(names.includes(`fable51.${expected}`), `missing fable51.${expected}`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('51 orders verify before critical before explore', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'fable51.reasoning-priority', { tasks: [{ id: 'e1', kind: 'explore' }, { id: 'v1', kind: 'verify' }, { id: 'c1', kind: 'critical' }] })
      assert.equal(first.spec, '51')
      assert.equal(first.rerun, false)
      assert.deepEqual(first.output.order, ['v1', 'c1', 'e1'])
      const again = await call(ctx, 'fable51.reasoning-priority', { tasks: [{ id: 'e1', kind: 'explore' }, { id: 'v1', kind: 'verify' }, { id: 'c1', kind: 'critical' }] })
      assert.equal(again.rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('53 separates duplicates by exact content', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.reasoning-dedup', { items: ['a', 'b', 'a'] })
      assert.deepEqual(out.output.unique, ['a', 'b'])
      assert.deepEqual(out.output.duplicates, ['a'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('54 computes the weighted hypothesis score', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.hypothesis-scoring', { evidence: 5, contradiction: 2, coverage: 3 })
      assert.equal(out.output.score, 6)
      const weighted = await call(ctx, 'fable51.hypothesis-scoring', { evidence: 5, contradiction: 2, coverage: 3, weights: [2, 1, 0] })
      assert.equal(weighted.output.score, 8)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('56 never fails the pipeline', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.failure-isolation', { failedPass: 'p1', pipelineSize: 4 })
      assert.equal(out.output.pipelineFailed, false)
      assert.equal(out.output.isolated, 'p1')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('57 matches only on the exact trace hash', async () => {
    const ctx = await setup()
    try {
      const bad = await call(ctx, 'fable51.reasoning-replay', { traceHash: 'sha256:nope', actual: { a: 1 } })
      assert.equal(bad.output.match, false)
      const good = await call(ctx, 'fable51.reasoning-replay', { traceHash: bad.output.actualHash, actual: { a: 1 } })
      assert.equal(good.output.match, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('59 classifies by weighted score', async () => {
    const ctx = await setup()
    try {
      const contributed = await call(ctx, 'fable51.reasoning-audit', { evidence: 2, coherence: 1, coverage: 1, contradiction: 0 })
      assert.equal(contributed.output.verdict, 'contributed')
      const discarded = await call(ctx, 'fable51.reasoning-audit', { weighted: -3 })
      assert.equal(discarded.output.verdict, 'discarded')
      const neutral = await call(ctx, 'fable51.reasoning-audit', { weighted: 0 })
      assert.equal(neutral.output.verdict, 'neutral')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('61 maps task shapes to topologies', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.reasoning-topology', { taskShape: 'fan-out' })).output.topology, 'star')
      assert.equal((await call(ctx, 'fable51.reasoning-topology', { taskShape: 'linear' })).output.topology, 'chain')
      assert.equal((await call(ctx, 'fable51.reasoning-topology', { taskShape: 'all-to-all' })).output.topology, 'mesh')
      assert.equal((await call(ctx, 'fable51.reasoning-topology', { taskShape: 'cyclic' })).output.topology, 'ring')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('62 branches proportionally to ambiguity within the depth budget', async () => {
    const ctx = await setup()
    try {
      const none = await call(ctx, 'fable51.adaptive-branching', { ambiguity: 0 })
      assert.equal(none.output.branches, 0)
      const full = await call(ctx, 'fable51.adaptive-branching', { ambiguity: 1 })
      assert.equal(full.output.branches, ctx.fable51.config.budget.maxForkDepth)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('63 ranks by contribution and flags waste', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.reasoning-heatmap', {
        passes: [
          { id: 'a', tokens: 1000, contribution: 1 },
          { id: 'b', tokens: 10, contribution: 100 },
          { id: 'c', tokens: 500, contribution: 50 },
        ],
      })
      assert.deepEqual(out.output.waste, ['a'])
      const ranked = out.output.ranked as Array<{ id: string }>
      assert.deepEqual(ranked.map((r) => r.id), ['b', 'c', 'a'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('64 flags only facts whose values differ', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.cross-pass-consistency', {
        facts: [
          { fact: 'same', values: ['x', 'x'] },
          { fact: 'drifted', values: ['x', 'y'] },
        ],
      })
      assert.deepEqual(out.output.drifts, ['drifted'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('65 fingerprints canonically', async () => {
    const ctx = await setup()
    try {
      const a = await call(ctx, 'fable51.reasoning-fingerprint', { content: { a: 1, b: 2 } })
      const b = await call(ctx, 'fable51.reasoning-fingerprint', { content: { b: 2, a: 1 } })
      assert.equal(a.output.fingerprint, b.output.fingerprint)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('66 schedules by the declared policy', async () => {
    const ctx = await setup()
    try {
      const fifo = await call(ctx, 'fable51.pass-scheduling', { order: 'FIFO', passes: [{ id: 'b' }, { id: 'a' }] })
      assert.deepEqual(fifo.output.scheduled, ['b', 'a'])
      const priority = await call(ctx, 'fable51.pass-scheduling', { order: 'priority', passes: [{ id: 'b', priority: 1 }, { id: 'a', priority: 9 }] })
      assert.deepEqual(priority.output.scheduled, ['a', 'b'])
      const sjf = await call(ctx, 'fable51.pass-scheduling', { order: 'SJF', passes: [{ id: 'b', size: 1 }, { id: 'a', size: 9 }] })
      assert.deepEqual(sjf.output.scheduled, ['b', 'a'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('67 bounds the pass window', async () => {
    const ctx = await setup()
    try {
      const ok = await call(ctx, 'fable51.reasoning-window', { turns: 5, tokens: 1000, toolCalls: 3 })
      assert.equal(ok.output.withinBounds, true)
      const over = await call(ctx, 'fable51.reasoning-window', { turns: 11, tokens: 1, toolCalls: 1 })
      assert.equal(over.output.withinBounds, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('68 escalates merge conflicts by severity', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.merge-conflict-resolution', { conflictScore: 0.1 })).output.strategy, 'vote')
      assert.equal((await call(ctx, 'fable51.merge-conflict-resolution', { conflictScore: 0.6 })).output.strategy, 'weight')
      assert.equal((await call(ctx, 'fable51.merge-conflict-resolution', { conflictScore: 0.95 })).output.strategy, 'escalate')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('69 records lineage edges and answers ancestors; roots need no parent', async () => {
    const ctx = await setup()
    try {
      const root = await call(ctx, 'fable51.reasoning-lineage', { passId: 'seed' })
      assert.equal(root.output.recorded, true)
      const mid = await call(ctx, 'fable51.reasoning-lineage', { passId: 'root', parentId: 'seed' })
      assert.deepEqual(mid.output.ancestors, ['seed'])
      const child = await call(ctx, 'fable51.reasoning-lineage', { passId: 'child', parentId: 'root' })
      assert.deepEqual(child.output.ancestors, ['root', 'seed'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('71 throttles above the concurrency threshold', async () => {
    const ctx = await setup()
    try {
      const threshold = ctx.fable51.config.reasoning.maxConcurrentPasses
      assert.equal((await call(ctx, 'fable51.reasoning-backpressure', { queueDepth: 1 })).output.throttle, false)
      assert.equal((await call(ctx, 'fable51.reasoning-backpressure', { queueDepth: threshold + 1 })).output.throttle, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects out-of-contract arguments loudly', async () => {
    const ctx = await setup()
    try {
      const bad = await execute(ctx, 'fable51.reasoning-priority', { tasks: 'nope' })
      assert.equal(bad.isError, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
