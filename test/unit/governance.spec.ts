/**
 * Unit: governance tools — specs 13, 20, 91, 92, 94, 98, 99 (Gate 4o).
 *
 * Runs against a real Cordis host with the real dsh tool registry, so the
 * envelope, idempotency, and namespace guarantees are the registry's, not a
 * mock's.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { governanceTools } from '../../src/tools/governance.ts'
import { fingerprint } from '../../src/state/cache.ts'
import type { PassScore, ReasoningPass } from '../../src/types/pass.ts'

interface Envelope {
  readonly ok: boolean
  readonly spec: string
  readonly output: Record<string, unknown>
  readonly verdict: string
  readonly unverified: readonly string[]
  readonly rerun: boolean
  readonly gates: readonly unknown[]
}

async function setup() {
  const ctx = new Context()
  // Fable51Policy injects ['tools', 'llm', 'sessions']: a host missing llm or
  // sessions leaves the service PENDING, so its constructor — which registers
  // every tool — never runs. Load the full host from bundle.spec.ts instead.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

async function run(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${name}`),
    name: `fable51_${name}`,
    arguments: args,
  })
  assert.equal(result.isError, false, `tool fable51_${name} failed: ${JSON.stringify(result.content)}`)
  return result.value as unknown as Envelope
}

function line(id: string, parentId: string | null): ReasoningPass {
  const score: PassScore = { evidence: 0, coherence: 0, coverage: 0, contradiction: 0, weighted: 0 }
  return {
    id,
    spec: '94',
    parentId,
    inHash: `sha256:${id}-in`,
    outHash: `sha256:${id}-out`,
    deps: [],
    verdict: 'neutral',
    score,
    startedAt: 0,
    endedAt: 1,
    tokens: 1,
    latencyMs: 1,
    unverified: [],
  }
}

/** The tools/result observer logs a `tool:<name>` line per call, so worklog assertions are stage-scoped. */
function worklogAt(ctx: Context, stage: string): readonly (typeof ctx.fable51.worklog)[number][] {
  return ctx.fable51.worklog.filter((entry) => entry.stage === stage)
}

describe('spec 13 — worklog-format', () => {
  it('records the stage/output/check/verdict/unverified entry and echoes it', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, 'worklog-format', {
        stage: 'verify',
        output: 'artifact checksum matches',
        check: 'ran gate g1',
        verdict: 'contributed',
        unverified: ['schema drift'],
      })
      assert.equal(first.spec, '13')
      assert.equal(first.rerun, false)
      assert.equal(first.output.stage, 'verify')
      assert.equal(first.output.output, 'artifact checksum matches')
      assert.equal(first.output.check, 'ran gate g1')
      assert.equal(first.output.verdict, 'contributed')
      assert.deepEqual(first.output.unverified, ['schema drift'])
      assert.equal(typeof first.output.at, 'number')
      assert.equal(worklogAt(ctx, 'verify').length, 1)
      assert.equal(worklogAt(ctx, 'verify')[0]?.output, 'artifact checksum matches')

      const second = await run(ctx, 'worklog-format', {
        stage: 'verify',
        output: 'artifact checksum matches',
        check: 'ran gate g1',
        verdict: 'contributed',
        unverified: ['schema drift'],
      })
      assert.equal(second.rerun, false, 'worklog-format is effectful: a replayed call would hide a real event')
      assert.equal(second.output.stage, first.output.stage)
      assert.deepEqual(second.output.unverified, first.output.unverified)
      assert.equal(worklogAt(ctx, 'verify').length, 2, 'each call records its own worklog line')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('defaults the unverified list to empty rather than omitting the field', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'worklog-format', {
        stage: 'ship',
        output: 'readme written',
        check: 'diff reviewed',
        verdict: 'neutral',
      })
      assert.deepEqual(result.output.unverified, [])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 20 — partial-delivery', () => {
  it('ships the final output only when it is verified', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'partial-delivery', { finalVerified: true, unverified: ['none'] })
      assert.equal(result.spec, '20')
      assert.equal(result.rerun, false)
      assert.deepEqual(result.output, { shipped: 'final' })

      const again = await run(ctx, 'partial-delivery', { finalVerified: true, unverified: ['none'] })
      assert.equal(again.rerun, true)
      assert.deepEqual(again.output, { shipped: 'final' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ships the prior output plus the explicit unverified list when the final is unverified', async () => {
    const ctx = await setup()
    try {
      const prior = { readme: 'written', gates: 5 }
      const result = await run(ctx, 'partial-delivery', {
        finalVerified: false,
        priorOutput: prior,
        unverified: ['gate 4o', 'e2e run'],
      })
      assert.equal(result.output.shipped, 'prior')
      assert.deepEqual(result.output.priorOutput, prior)
      assert.deepEqual(result.output.unverified, ['gate 4o', 'e2e run'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 91 — pass-merge-idempotency', () => {
  it('merges the union of keys, independent of input order', async () => {
    const ctx = await setup()
    try {
      const a = { changed: 'a.ts', tests: 'a.spec.ts' }
      const b = { changed: 'b.ts', readme: 'README.md' }
      const forward = await run(ctx, 'pass-merge-idempotency', { outputs: [a, b] })
      const backward = await run(ctx, 'pass-merge-idempotency', { outputs: [b, a] })
      assert.equal(forward.spec, '91')
      assert.equal(forward.rerun, false)
      assert.equal(forward.output.orderIndependent, true)
      assert.deepEqual(forward.output.merged, backward.output.merged)
      const merged = forward.output.merged as Record<string, unknown>
      assert.deepEqual(Object.keys(merged).sort(), ['changed', 'readme', 'tests'])
      const replayed = await run(ctx, 'pass-merge-idempotency', { outputs: [a, b] })
      assert.equal(replayed.rerun, true)
      assert.deepEqual(replayed.output.merged, forward.output.merged)
      assert.equal(ctx.fable51.cache.size, 2, 'two distinct input orders are two distinct cache keys')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves a key collision by fingerprint order, not by input order', async () => {
    const ctx = await setup()
    try {
      const first = { verdict: 'first' }
      const second = { verdict: 'second' }
      const winner = fingerprint(first) < fingerprint(second) ? 'second' : 'first'
      const forward = await run(ctx, 'pass-merge-idempotency', { outputs: [first, second] })
      const backward = await run(ctx, 'pass-merge-idempotency', { outputs: [second, first] })
      assert.equal((forward.output.merged as Record<string, unknown>).verdict, winner)
      assert.deepEqual(forward.output.merged, backward.output.merged)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('merges an empty list to an empty object', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'pass-merge-idempotency', { outputs: [] })
      assert.deepEqual(result.output.merged, {})
      assert.equal(result.output.orderIndependent, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 92 — reasoning-drift-detection', () => {
  it('reports no drift when the output matches the anchor', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'reasoning-drift-detection', {
        anchor: 'implement governance tools and run the gate',
        output: 'implement governance tools and run the gate',
      })
      assert.equal(result.spec, '92')
      assert.equal(result.rerun, false)
      assert.equal(result.output.drift, 0)
      assert.equal(result.output.drifted, false)
      assert.equal(result.output.epsilon, ctx.fable51.config.reasoning.convergenceDelta)
      const replayed = await run(ctx, 'reasoning-drift-detection', {
        anchor: 'implement governance tools and run the gate',
        output: 'implement governance tools and run the gate',
      })
      assert.equal(replayed.rerun, true)
      assert.equal(replayed.output.drift, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports full drift when the output shares nothing with the anchor', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'reasoning-drift-detection', {
        anchor: 'implement governance tools',
        output: 'rewrite the css grid layout',
      })
      assert.equal(result.output.drift, 1)
      assert.equal(result.output.drifted, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies the ε threshold: above it drifts, below it does not', async () => {
    const ctx = await setup()
    try {
      const args = { anchor: 'alpha beta gamma delta', output: 'alpha beta' }
      const tight = await run(ctx, 'reasoning-drift-detection', { ...args, epsilon: 0.4 })
      const loose = await run(ctx, 'reasoning-drift-detection', { ...args, epsilon: 0.6 })
      assert.equal(tight.output.drift, 0.5)
      assert.equal(tight.output.drifted, true)
      assert.equal(loose.output.drifted, false)
      assert.equal(loose.output.epsilon, 0.6)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 94 — reasoning-garbage-collection', () => {
  it('drops passes no live id or keepLastN retains', async () => {
    const ctx = await setup()
    try {
      ctx.fable51.lineage.record(line('a', null))
      ctx.fable51.lineage.record(line('b', 'a'))
      ctx.fable51.lineage.record(line('c', 'b'))
      ctx.fable51.lineage.record(line('z', null))
      const result = await run(ctx, 'reasoning-garbage-collection', { liveIds: ['c'], keepLastN: 0 })
      assert.equal(result.spec, '94')
      assert.equal(result.rerun, false)
      assert.deepEqual(result.output.dropped, ['z'])
      assert.equal(result.output.kept, 3)
      assert.equal(ctx.fable51.lineage.get('z'), undefined)
      const replayed = await run(ctx, 'reasoning-garbage-collection', { liveIds: ['c'], keepLastN: 0 })
      assert.equal(replayed.rerun, false, 'gc is effectful: each call re-evaluates the lineage instead of replaying')
      assert.deepEqual(replayed.output.dropped, [], 'the second run has nothing left to drop')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the last N passes when nothing is live', async () => {
    const ctx = await setup()
    try {
      ctx.fable51.lineage.record(line('p1', null))
      ctx.fable51.lineage.record(line('p2', null))
      ctx.fable51.lineage.record(line('p3', null))
      const result = await run(ctx, 'reasoning-garbage-collection', { liveIds: [], keepLastN: 1 })
      assert.deepEqual(result.output.dropped, ['p1', 'p2'])
      assert.equal(result.output.kept, 1)
      assert.equal(ctx.fable51.lineage.size(), 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 98 — reasoning-ab-test', () => {
  it('picks the higher score even when it costs more', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'reasoning-ab-test', {
        input: { task: 'merge two passes' },
        policyA: { score: 0.9, cost: 100 },
        policyB: { score: 0.5, cost: 1 },
      })
      assert.equal(result.spec, '98')
      assert.equal(result.rerun, false)
      assert.equal(result.output.winner, 'A')
      assert.match(String(result.output.reason), /policy A scored 0\.9 over 0\.5/)
      const replayed = await run(ctx, 'reasoning-ab-test', {
        input: { task: 'merge two passes' },
        policyA: { score: 0.9, cost: 100 },
        policyB: { score: 0.5, cost: 1 },
      })
      assert.equal(replayed.rerun, true)
      assert.equal(replayed.output.winner, 'A')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('breaks a score tie on the lower cost', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'reasoning-ab-test', {
        input: { task: 'merge two passes' },
        policyA: { score: 0.8, cost: 40 },
        policyB: { score: 0.8, cost: 4 },
      })
      assert.equal(result.output.winner, 'B')
      assert.match(String(result.output.reason), /tie at 0\.8/)

      const flipped = await run(ctx, 'reasoning-ab-test', {
        input: { task: 'merge two passes' },
        policyA: { score: 0.8, cost: 4 },
        policyB: { score: 0.8, cost: 40 },
      })
      assert.equal(flipped.output.winner, 'A')

      const identical = await run(ctx, 'reasoning-ab-test', {
        input: { task: 'merge two passes' },
        policyA: { score: 0.8, cost: 4 },
        policyB: { score: 0.8, cost: 4 },
      })
      assert.equal(identical.output.winner, 'A')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 99 — pass-migration', () => {
  it('reports no divergence and logs nothing when the output survives migration', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, 'pass-migration', {
        passId: 'p-1',
        fromModel: 'deepseek-reasoner',
        toModel: 'deepseek-reasoner-v2',
        outputBefore: { answer: 'ship the prior output' },
        outputAfter: { answer: 'ship the prior output' },
      })
      assert.equal(first.spec, '99')
      assert.equal(first.rerun, false)
      assert.deepEqual(first.output, {
        migrated: true,
        divergence: false,
        fromModel: 'deepseek-reasoner',
        toModel: 'deepseek-reasoner-v2',
      })
      assert.equal(worklogAt(ctx, 'pass-migration:p-1').length, 0)

      const second = await run(ctx, 'pass-migration', {
        passId: 'p-1',
        fromModel: 'deepseek-reasoner',
        toModel: 'deepseek-reasoner-v2',
        outputBefore: { answer: 'ship the prior output' },
        outputAfter: { answer: 'ship the prior output' },
      })
      assert.equal(second.rerun, false)
      assert.equal(second.output.divergence, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('flags divergence and records a worklog line for it', async () => {
    const ctx = await setup()
    try {
      const result = await run(ctx, 'pass-migration', {
        passId: 'p-9',
        fromModel: 'model-a',
        toModel: 'model-b',
        outputBefore: { steps: 3 },
        outputAfter: { steps: 4 },
      })
      assert.equal(result.output.divergence, true)
      assert.equal(result.output.migrated, true)
      assert.equal(result.output.fromModel, 'model-a')
      assert.equal(result.output.toModel, 'model-b')
      const migration = worklogAt(ctx, 'pass-migration:p-9')
      assert.equal(migration.length, 1)
      const entry = migration[0]
      assert.equal(entry?.verdict, 'discarded')
      assert.deepEqual(entry?.unverified, ['pass p-9 equivalence across model-a → model-b'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('governance namespace', () => {
  it('registers every governance tool once under the fable51.* namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      for (const spec of governanceTools()) {
        assert.ok(names.includes(`fable51_${spec.name}`), `expected fable51_${spec.name} in ${names.join(',')}`)
      }
      for (const name of names) {
        assert.match(name, /^fable51_/, `tool ${name} must stay in the fable51 namespace`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('registers exactly the seven governance specs', async () => {
    const specs = governanceTools().map((tool) => tool.spec)
    assert.deepEqual(specs, ['13', '20', '91', '92', '94', '98', '99'])
    const names = governanceTools().map((tool) => tool.name)
    assert.deepEqual(names, [
      'worklog-format',
      'partial-delivery',
      'pass-merge-idempotency',
      'reasoning-drift-detection',
      'reasoning-garbage-collection',
      'reasoning-ab-test',
      'pass-migration',
    ])
  })
})
