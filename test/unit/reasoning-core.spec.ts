/**
 * Unit: reasoning-core tool group — specs 31, 32, 35, 37, 38, 39, 40, 41, 42,
 * 44, 45, 46, 49 (PRD §4.3/§4.4, Gates 4g–4n).
 *
 * Host setup mirrors test/integration/bundle.spec.ts: a real Cordis Context
 * with the real dsh services. Fable51Policy injects ['tools','llm','sessions'],
 * so all four services must load or the plugin stays pending and ctx.fable51
 * never resolves.
 *
 * The parent-owned reasoningTools() registry does not wire this part yet, so
 * setup() registers the group's specs directly; names already on the registry
 * are skipped, which keeps this file valid once the parent wires
 * reasoning-core.ts in.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { reasoningCoreTools } from '../../src/tools/reasoning-core.ts'
import { defineTool } from '../../src/tools/shared.ts'
import { fingerprint } from '../../src/state/cache.ts'

const TOOL_NAMES = [
  'fable51.reasoning-forking',
  'fable51.hypothesis-pruning',
  'fable51.chain-vs-tree',
  'fable51.parallel-tool-feed',
  'fable51.reasoning-checkpoint',
  'fable51.contradiction-detection',
  'fable51.confidence-scoring',
  'fable51.speculative-execution',
  'fable51.early-exit',
  'fable51.divergence-control',
  'fable51.merge-strategy',
  'fable51.reasoning-rollback',
  'fable51.reasoning-trace-format',
]

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  const registered = new Set(ctx.tools.schemas().map((schema) => schema.name))
  for (const spec of reasoningCoreTools()) {
    const name = `fable51.${spec.name}`
    if (registered.has(name)) continue
    ctx.tools.register(defineTool(spec, { service: ctx.fable51 }))
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

async function dispatch(ctx: Context, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: 'c1', name, arguments: args })
  return result as unknown as ToolOutcome
}

async function run(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const outcome = await dispatch(ctx, name, args)
  assert.equal(outcome.isError, false, `${name} failed: ${JSON.stringify(outcome.content)}`)
  return outcome.value
}

async function runIdempotent(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const first = await run(ctx, name, args)
  assert.equal(first.ok, true, `${name} envelope must be ok`)
  assert.equal(first.verdict, 'verified', `${name} verdict must be verified`)
  assert.deepEqual(first.unverified, [], `${name} must carry no unverified list`)
  assert.deepEqual(first.gates, [], `${name} must declare no inline gates`)
  assert.equal(first.rerun, false, `${name} first call must not be a rerun (spec 19)`)
  const second = await run(ctx, name, args)
  assert.equal(second.rerun, true, `${name} second call must replay the cache (spec 19)`)
  assert.deepEqual(second.output, first.output, `${name} rerun must replay the same output`)
  return first
}

async function expectError(ctx: Context, name: string, args: Record<string, unknown>): Promise<void> {
  const outcome = await dispatch(ctx, name, args)
  assert.equal(outcome.isError, true, `${name} must reject ${JSON.stringify(args)}`)
}

describe('fable51 namespace', () => {
  it('registers all thirteen reasoning-core tools under fable51.* and none at root', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((schema) => schema.name)
      for (const expected of TOOL_NAMES) {
        assert.ok(names.includes(expected), `expected ${expected} in [${names.join(', ')}]`)
      }
      for (const name of names) {
        assert.match(name, /^fable51\./, `tool ${name} must stay in the fable51 namespace`)
      }
      for (const bare of TOOL_NAMES.map((name) => name.slice('fable51.'.length))) {
        assert.ok(!names.includes(bare), `no un-namespaced tool ${bare} may exist at the root`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('appends one tool:<name> worklog line per execution, counted by stage only', async () => {
    const ctx = await setup()
    try {
      await run(ctx, 'fable51.chain-vs-tree', { branchFactor: 2 })
      await run(ctx, 'fable51.reasoning-forking', { candidateCount: 3, budgetLeft: 1 })
      const forkLines = ctx.fable51.worklog.filter((entry) => entry.stage === 'tool:fable51.reasoning-forking')
      const chainLines = ctx.fable51.worklog.filter((entry) => entry.stage === 'tool:fable51.chain-vs-tree')
      assert.equal(forkLines.length, 1, 'one worklog line per execution for the forking stage')
      assert.equal(chainLines.length, 1, 'one worklog line per execution for the chain-vs-tree stage')
      assert.ok(ctx.fable51.worklog.length > forkLines.length, 'the worklog array holds other stages — never count it whole')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 31 — reasoning-forking', () => {
  it('forks with candidates and budget, merges without budget, keeps one, discards none', async () => {
    const ctx = await setup()
    try {
      const fork = await runIdempotent(ctx, 'fable51.reasoning-forking', { candidateCount: 3, budgetLeft: 2 })
      assert.equal(fork.spec, '31')
      assert.equal(fork.output.decision, 'fork')
      const merge = await run(ctx, 'fable51.reasoning-forking', { candidateCount: 3, budgetLeft: 0 })
      assert.equal(merge.output.decision, 'merge')
      const keep = await run(ctx, 'fable51.reasoning-forking', { candidateCount: 1, budgetLeft: 0 })
      assert.equal(keep.output.decision, 'keep')
      const discard = await run(ctx, 'fable51.reasoning-forking', { candidateCount: 0, budgetLeft: 9 })
      assert.equal(discard.output.decision, 'discard')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a negative candidate count or a negative budget', async () => {
    const ctx = await setup()
    try {
      await expectError(ctx, 'fable51.reasoning-forking', { candidateCount: -1, budgetLeft: 1 })
      await expectError(ctx, 'fable51.reasoning-forking', { candidateCount: 2, budgetLeft: -1 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 32 — hypothesis-pruning', () => {
  it('retains the top-k by score with id-ascending tie-break and reports the pruned tail', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.hypothesis-pruning', {
        hypotheses: [
          { id: 'h3', score: 1 },
          { id: 'h1', score: 5 },
          { id: 'h2', score: 5 },
          { id: 'h4', score: 0 },
        ],
        k: 2,
      })
      assert.equal(res.spec, '32')
      assert.deepEqual(res.output.kept, [
        { id: 'h1', score: 5 },
        { id: 'h2', score: 5 },
      ])
      assert.deepEqual(res.output.pruned, [
        { id: 'h3', score: 1 },
        { id: 'h4', score: 0 },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps every hypothesis when k exceeds the candidate count', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, 'fable51.hypothesis-pruning', { hypotheses: [{ id: 'a', score: 2 }], k: 5 })
      assert.deepEqual(res.output.kept, [{ id: 'a', score: 2 }])
      assert.deepEqual(res.output.pruned, [])
      await expectError(ctx, 'fable51.hypothesis-pruning', { hypotheses: [{ id: 'a', score: 2 }], k: -1 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 35 — chain-vs-tree', () => {
  it('selects a chain while the branch factor is at or below one and a tree above it', async () => {
    const ctx = await setup()
    try {
      const chain = await runIdempotent(ctx, 'fable51.chain-vs-tree', { branchFactor: 1 })
      assert.equal(chain.spec, '35')
      assert.equal(chain.output.topology, 'chain')
      const linear = await run(ctx, 'fable51.chain-vs-tree', { branchFactor: 0 })
      assert.equal(linear.output.topology, 'chain')
      const tree = await run(ctx, 'fable51.chain-vs-tree', { branchFactor: 2 })
      assert.equal(tree.output.topology, 'tree')
      assert.equal(tree.output.branchFactor, 2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 37 — parallel-tool-feed', () => {
  it('batches the independent calls into one feed', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.parallel-tool-feed', { calls: ['search', 'fetch', 'read'] })
      assert.equal(res.spec, '37')
      assert.equal(res.output.batched, 3)
      assert.equal(res.output.independent, true)
      const empty = await run(ctx, 'fable51.parallel-tool-feed', { calls: [] })
      assert.equal(empty.output.batched, 0)
      assert.equal(empty.output.independent, true)
      await expectError(ctx, 'fable51.parallel-tool-feed', { calls: ['ok', 7] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 38 — reasoning-checkpoint', () => {
  it('snapshots the pass state and reports its id and content hash', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.reasoning-checkpoint', { passId: 'p7', state: { turn: 2, note: 'boundary' } })
      assert.equal(res.spec, '38')
      assert.equal(res.output.snapshotId, 'p7')
      const snapshot = ctx.fable51.snapshots.get('p7')
      assert.ok(snapshot, 'the snapshot must live in the service snapshot index')
      assert.equal(snapshot?.hash, res.output.hash)
      assert.equal(snapshot?.hash, fingerprint({ turn: 2, note: 'boundary' }))
      assert.equal(ctx.fable51.snapshots.latest()?.id, 'p7')
      assert.deepEqual(ctx.fable51.snapshots.ids(), ['p7'], 'the idempotent rerun must not create a second snapshot')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a non-object state and an empty pass id', async () => {
    const ctx = await setup()
    try {
      await expectError(ctx, 'fable51.reasoning-checkpoint', { passId: 'p7', state: 'not-an-object' })
      await expectError(ctx, 'fable51.reasoning-checkpoint', { passId: '', state: {} })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 39 — contradiction-detection', () => {
  it('reports only the pairs whose values differ', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.contradiction-detection', {
        claims: [
          { id: 'a', value: 'yes' },
          { id: 'b', value: 'no' },
          { id: 'c', value: 'yes' },
        ],
      })
      assert.equal(res.spec, '39')
      assert.deepEqual(res.output.contradictions, [
        ['a', 'b'],
        ['b', 'c'],
      ])
      const agree = await run(ctx, 'fable51.contradiction-detection', {
        claims: [
          { id: 'a', value: { v: 1 } },
          { id: 'b', value: { v: 1 } },
        ],
      })
      assert.deepEqual(agree.output.contradictions, [])
      const single = await run(ctx, 'fable51.contradiction-detection', { claims: [{ id: 'a', value: 1 }] })
      assert.deepEqual(single.output.contradictions, [])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 40 — confidence-scoring', () => {
  it('merges by summed weight, not by majority', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.confidence-scoring', {
        votes: [
          { weight: 6, value: 'a' },
          { weight: 1, value: 'b' },
          { weight: 1, value: 'b' },
        ],
      })
      assert.equal(res.spec, '40')
      assert.equal(res.output.winner, 'a')
      assert.deepEqual(res.output.totals, [
        { value: 'a', weight: 6 },
        { value: 'b', weight: 2 },
      ])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('breaks a tie by first appearance and returns null for an empty vote set', async () => {
    const ctx = await setup()
    try {
      const tie = await run(ctx, 'fable51.confidence-scoring', {
        votes: [
          { weight: 2, value: 'x' },
          { weight: 2, value: 'y' },
        ],
      })
      assert.equal(tie.output.winner, 'x')
      const none = await run(ctx, 'fable51.confidence-scoring', { votes: [] })
      assert.equal(none.output.winner, null)
      assert.deepEqual(none.output.totals, [])
      await expectError(ctx, 'fable51.confidence-scoring', { votes: [{ weight: 'heavy', value: 'a' }] })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 41 — speculative-execution', () => {
  it('runs only while the reuse probability beats the wasted-work cost', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.speculative-execution', { reuseProb: 0.5, cost: 1000 })
      assert.equal(res.spec, '41')
      assert.equal(res.output.run, true)
      assert.equal(res.output.waste, false)
      const miss = await run(ctx, 'fable51.speculative-execution', { reuseProb: 0.0001, cost: 1000 })
      assert.equal(miss.output.run, false)
      assert.equal(miss.output.waste, true)
      const boundary = await run(ctx, 'fable51.speculative-execution', { reuseProb: 0.5, cost: 50_000 })
      assert.equal(boundary.output.run, false, 'reuseProb must strictly exceed cost/100000')
      assert.equal(boundary.output.waste, true)
      await expectError(ctx, 'fable51.speculative-execution', { reuseProb: 1.5, cost: 10 })
      await expectError(ctx, 'fable51.speculative-execution', { reuseProb: 0.5, cost: -10 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 42 — early-exit', () => {
  it('stops once the last n changes all fall below the threshold', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.early-exit', { changes: [0.5, 0.01, 0.02, 0.03], threshold: 0.04, n: 3 })
      assert.equal(res.spec, '42')
      assert.equal(res.output.stop, true)
      const diverged = await run(ctx, 'fable51.early-exit', { changes: [0.5, 0.01, 0.5, 0.03], threshold: 0.04, n: 3 })
      assert.equal(diverged.output.stop, false)
      const short = await run(ctx, 'fable51.early-exit', { changes: [0.01, 0.02], threshold: 0.04, n: 3 })
      assert.equal(short.output.stop, false, 'fewer than n observed changes cannot converge')
      await expectError(ctx, 'fable51.early-exit', { changes: [0.01], threshold: 0.04, n: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 44 — divergence-control', () => {
  it('caps the fork at the configured fork depth and flags the excess', async () => {
    const ctx = await setup()
    try {
      const cap = ctx.fable51.config.budget.maxForkDepth
      const res = await runIdempotent(ctx, 'fable51.divergence-control', { branches: cap + 3 })
      assert.equal(res.spec, '44')
      assert.equal(res.output.capped, cap)
      assert.equal(res.output.exceeded, true)
      const within = await run(ctx, 'fable51.divergence-control', { branches: cap })
      assert.equal(within.output.capped, cap)
      assert.equal(within.output.exceeded, false)
      await expectError(ctx, 'fable51.divergence-control', { branches: 1.5 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 45 — merge-strategy', () => {
  it('merges by union, intersection, and weighted concatenation in first-seen order', async () => {
    const ctx = await setup()
    try {
      const sets = [['a', 'b', 'c'], ['b', 'c'], ['c', 'b', 'a']]
      const union = await runIdempotent(ctx, 'fable51.merge-strategy', { strategy: 'union', sets })
      assert.equal(union.spec, '45')
      assert.deepEqual(union.output.merged, ['a', 'b', 'c'])
      assert.equal(union.output.strategy, 'union')
      const intersection = await run(ctx, 'fable51.merge-strategy', { strategy: 'intersection', sets })
      assert.deepEqual(intersection.output.merged, ['b', 'c'])
      const weighted = await run(ctx, 'fable51.merge-strategy', { strategy: 'weighted', sets: [['a', 'b'], ['b', 'a']] })
      assert.deepEqual(weighted.output.merged, ['a', 'b'])
      const empty = await run(ctx, 'fable51.merge-strategy', { strategy: 'intersection', sets: [] })
      assert.deepEqual(empty.output.merged, [])
      await expectError(ctx, 'fable51.merge-strategy', { strategy: 'majority', sets })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 46 — reasoning-rollback', () => {
  it('reverts to the latest checkpoint, or null when none exists', async () => {
    const ctx = await setup()
    try {
      const none = await runIdempotent(ctx, 'fable51.reasoning-rollback', { passId: 'p1' })
      assert.equal(none.spec, '46')
      assert.equal(none.output.revertedTo, null)
      await run(ctx, 'fable51.reasoning-checkpoint', { passId: 'p2', state: { turn: 1 } })
      // A distinct passId is used per query: the bundle cache (spec 19) replays
      // a recorded answer for identical arguments, which is the intended
      // no-double-write behaviour, not a stale read of the snapshot index.
      const reverted = await run(ctx, 'fable51.reasoning-rollback', { passId: 'rollback-after-p2' })
      assert.equal(reverted.output.revertedTo, 'p2')
      await run(ctx, 'fable51.reasoning-checkpoint', { passId: 'p3', state: { turn: 2 } })
      const newest = await run(ctx, 'fable51.reasoning-rollback', { passId: 'rollback-after-p3' })
      assert.equal(newest.output.revertedTo, 'p3')
      await expectError(ctx, 'fable51.reasoning-rollback', { passId: '' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 49 — reasoning-trace-format', () => {
  it('emits the trace record with input/output fingerprints and the weighted score', async () => {
    const ctx = await setup()
    try {
      const res = await runIdempotent(ctx, 'fable51.reasoning-trace-format', {
        id: 'pass-1',
        input: { q: 'why' },
        output: { a: 'because' },
        deps: ['root'],
        verdict: 'contributed',
      })
      assert.equal(res.spec, '49')
      assert.equal(res.output.id, 'pass-1')
      assert.equal(res.output.inHash, fingerprint({ q: 'why' }))
      assert.equal(res.output.outHash, fingerprint({ a: 'because' }))
      assert.deepEqual(res.output.deps, ['root'])
      assert.equal(res.output.verdict, 'contributed')
      assert.deepEqual(res.output.score, { evidence: 1, coherence: 1, coverage: 1, contradiction: 0, weighted: 3 })
      const discarded = await run(ctx, 'fable51.reasoning-trace-format', {
        id: 'pass-2',
        input: 1,
        output: 2,
        deps: [],
        verdict: 'discarded',
      })
      assert.equal(discarded.output.verdict, 'discarded')
      assert.deepEqual(discarded.output.deps, [])
      await expectError(ctx, 'fable51.reasoning-trace-format', { id: 'p', input: 1, output: 2, deps: [], verdict: 'maybe' })
      await expectError(ctx, 'fable51.reasoning-trace-format', { id: 'p', output: 2, deps: [], verdict: 'neutral' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
