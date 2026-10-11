/**
 * Unit: reasoning-ops tools — specs 73, 74, 75, 76, 77, 78, 79, 80, 82, 83,
 * 84, 85, 86, 87, 88, 89, 90. Host: real Cordis + real dsh services.
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

describe('reasoning-ops tools', () => {
  it('registers every spec under the fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      for (const expected of ['reasoning-quorum', 'diversity-injection', 'reasoning-decay', 'pass-prioritization',
        'reasoning-snapshot-diff', 'reasoning-federation', 'pass-observability', 'reasoning-budget-pool',
        'reasoning-quarantine', 'pass-checkpoint-strategy', 'reasoning-lane', 'pass-cancellation',
        'reasoning-affinity', 'pass-lineage-prune', 'reasoning-deadline-propagation', 'pass-quality-score',
        'reasoning-warmup']) {
        assert.ok(names.includes(`fable51.${expected}`), `missing fable51.${expected}`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('73 computes quorum against the configured threshold', async () => {
    const ctx = await setup()
    try {
      const threshold = ctx.fable51.config.reasoning.quorumThreshold
      const met = await call(ctx, 'fable51.reasoning-quorum', { agree: 3, total: 4 })
      assert.equal(met.output.threshold, threshold)
      assert.equal(met.output.quorum, 0.75 >= threshold)
      const missed = await call(ctx, 'fable51.reasoning-quorum', { agree: 1, total: 4 })
      assert.equal(missed.output.quorum, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('74 derives a deterministic variant seed', async () => {
    const ctx = await setup()
    try {
      const a = await call(ctx, 'fable51.diversity-injection', { passId: 'p1' })
      const b = await call(ctx, 'fable51.diversity-injection', { passId: 'p1' })
      assert.equal(a.output.variantSeed, b.output.variantSeed)
      assert.ok(a.rerun === false && b.rerun === true, 'identical args must replay')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('75 decays weight monotonically with age', async () => {
    const ctx = await setup()
    try {
      const fresh = await call(ctx, 'fable51.reasoning-decay', { ageMs: 0 })
      const stale = await call(ctx, 'fable51.reasoning-decay', { ageMs: 100000 })
      assert.equal(fresh.output.weight, 1)
      assert.ok((stale.output.weight as number) < 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('76 prioritizes by the declared context', async () => {
    const ctx = await setup()
    try {
      const byRisk = await call(ctx, 'fable51.pass-prioritization', {
        context: 'risk',
        passes: [{ id: 'a', risk: 1, uncertainty: 9, cost: 9 }, { id: 'b', risk: 9, uncertainty: 1, cost: 1 }],
      })
      assert.deepEqual(byRisk.output.order, ['b', 'a'])
      const byCost = await call(ctx, 'fable51.pass-prioritization', {
        context: 'cost',
        passes: [{ id: 'a', risk: 1, uncertainty: 9, cost: 9 }, { id: 'b', risk: 9, uncertainty: 1, cost: 1 }],
      })
      assert.deepEqual(byCost.output.order, ['a', 'b'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('77 diffs both sides of a snapshot pair', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.reasoning-snapshot-diff', {
        from: { id: 's1', data: { a: 1, b: 2 } },
        to: { id: 's2', data: { b: 3, c: 4 } },
      })
      assert.deepEqual(out.output.added, ['c'])
      assert.deepEqual(out.output.removed, ['a'])
      assert.deepEqual(out.output.changed, ['b'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('78 merges federated worker outputs', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.reasoning-federation', { workers: [{ id: 'w1', output: { a: 1 } }, { id: 'w2', output: { b: 2 } }] })
      assert.deepEqual(out.output.merged, { a: 1, b: 2 })
      assert.equal(out.output.workerCount, 2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('79 emits a stable trace id', async () => {
    const ctx = await setup()
    try {
      const a = await call(ctx, 'fable51.pass-observability', { passId: 'p1', tokens: 10, verdict: 'contributed' })
      const b = await call(ctx, 'fable51.pass-observability', { passId: 'p1', tokens: 10, verdict: 'contributed' })
      assert.equal(a.output.traceId, b.output.traceId)
      assert.ok(ctx.fable51.worklog.some((w) => w.stage === 'pass:p1'), 'observability writes its one line')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('80 caps grants per active pass', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.reasoning-budget-pool', { pool: 100, requested: 90, activePasses: 4 })
      assert.equal(out.output.perPassCap, 25)
      assert.equal(out.output.granted, 25)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('82 quarantines only suspect passes', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.reasoning-quarantine', { passId: 'p', suspect: true })).output.quarantined, true)
      assert.equal((await call(ctx, 'fable51.reasoning-quarantine', { passId: 'q', suspect: false })).output.quarantined, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('83 maps checkpoint modes to intervals', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.pass-checkpoint-strategy', { mode: 'turn' })).output.interval, 1)
      assert.equal((await call(ctx, 'fable51.pass-checkpoint-strategy', { mode: 'bulk' })).output.interval, 50000)
      assert.equal((await call(ctx, 'fable51.pass-checkpoint-strategy', { mode: 'long' })).output.interval, 'milestone')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('84 routes lanes by complexity', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.reasoning-lane', { complexity: 0.1 })).output.lane, 'fast')
      assert.equal((await call(ctx, 'fable51.reasoning-lane', { complexity: 0.5 })).output.lane, 'slow')
      assert.equal((await call(ctx, 'fable51.reasoning-lane', { complexity: 0.9 })).output.lane, 'verify')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('85 cancels the pass and descendants only when the premise died', async () => {
    const ctx = await setup()
    try {
      const dead = await call(ctx, 'fable51.pass-cancellation', { premiseInvalidated: true, passId: 'p', descendants: ['c1', 'c2'] })
      assert.deepEqual(dead.output.cancelled, ['p', 'c1', 'c2'])
      const alive = await call(ctx, 'fable51.pass-cancellation', { premiseInvalidated: false, passId: 'q', descendants: ['d1'] })
      assert.deepEqual(alive.output.cancelled, [])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('86 routes identical content to the same worker', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.reasoning-affinity', { passA: { x: 1 }, passB: { x: 1 } })).output.sameWorker, true)
      assert.equal((await call(ctx, 'fable51.reasoning-affinity', { passA: { x: 1 }, passB: { x: 2 } })).output.sameWorker, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('87 prunes ancestry but keeps live and audit-protected', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      svc.recordPass({
        id: 'a', spec: 't', parentId: null, inHash: 'sha256:a', outHash: 'sha256:a', deps: [],
        verdict: 'contributed', score: svc.score({ evidence: 1, coherence: 0, coverage: 0, contradiction: 0 }),
        startedAt: 0, endedAt: 0, tokens: 0, latencyMs: 0, unverified: [],
      })
      const out = await call(ctx, 'fable51.pass-lineage-prune', { liveIds: ['a'] })
      assert.ok(!(out.output.dropped as string[]).includes('a'), 'live pass survives prune')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('88 propagates the tighter deadline', async () => {
    const ctx = await setup()
    try {
      assert.equal((await call(ctx, 'fable51.reasoning-deadline-propagation', { parentDeadline: 100, ownDeadline: 50 })).output.deadline, 50)
      assert.equal((await call(ctx, 'fable51.reasoning-deadline-propagation', { parentDeadline: 100, ownDeadline: null })).output.deadline, 100)
      assert.equal((await call(ctx, 'fable51.reasoning-deadline-propagation', { parentDeadline: null, ownDeadline: 70 })).output.deadline, 70)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('89 returns the weighted quality score', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.pass-quality-score', { evidence: 3, coherence: 2, coverage: 2, contradiction: 1 })
      assert.deepEqual(out.output, { evidence: 3, coherence: 2, coverage: 2, contradiction: 1, weighted: 6 })
      assert.equal(out.rerun, false)
      assert.equal((await call(ctx, 'fable51.pass-quality-score', { evidence: 3, coherence: 2, coverage: 2, contradiction: 1 })).rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('90 warms up deterministically', async () => {
    const ctx = await setup()
    try {
      const out = await call(ctx, 'fable51.reasoning-warmup', { passId: 'p1' })
      assert.deepEqual(out.output, { warmupMs: 250, calibrated: true })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
