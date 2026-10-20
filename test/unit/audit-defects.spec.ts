/**
 * Unit: defect twins from the 2026-10-15 audit — every test here FAILS on the
 * pre-fix code and passes after. Each encodes the exact reproducer that was
 * observed against the real host and the real modules.
 *
 * Grouped by responsible module so the fix and its proof live together:
 *   state/lineage, state/snapshots, state/cache, state/registry,
 *   policy-service (cost ledger, session state), and the tool modules whose
 *   argument validation failed open.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { PassLineage } from '../../src/state/lineage.ts'
import { SnapshotStore } from '../../src/state/snapshots.ts'
import { PolicyRegistry } from '../../src/state/registry.ts'
import { canonicalize, fingerprint } from '../../src/state/cache.ts'
import type { ReasoningPass } from '../../src/types/pass.ts'

interface Envelope {
  readonly ok: boolean
  readonly spec: string
  readonly output: Record<string, unknown>
  readonly verdict: string
  readonly unverified: readonly string[]
  readonly rerun: boolean
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`audit-${name}`),
    name: `fable51_${name}`,
    arguments: args,
  })
  assert.equal(result.isError, false, `tool fable51_${name} threw: ${JSON.stringify(result.value)}`)
  return result.value as unknown as Envelope
}

function pass(id: string, parentId: string | null = null): ReasoningPass {
  return {
    id, spec: 'test', parentId, inHash: `sha256:in-${id}`, outHash: `sha256:out-${id}`,
    deps: [], verdict: 'contributed',
    score: { evidence: 1, coherence: 1, coverage: 1, contradiction: 0, weighted: 3 },
    startedAt: 0, endedAt: 1, tokens: 10, latencyMs: 1, unverified: [],
  }
}

describe('audit — state/lineage (specs 94, 59)', () => {
  it('GC keeps the N most RECENT passes, not the lexicographically largest ids', () => {
    const lineage = new PassLineage()
    for (let i = 1; i <= 12; i += 1) lineage.record(pass(`p${i}`))
    const dropped = lineage.gc([], 3)
    assert.equal(lineage.size(), 3, 'keepLastN=3 must keep exactly 3 passes')
    for (const newest of ['p10', 'p11', 'p12']) {
      assert.ok(lineage.get(newest) !== undefined, `${newest} is one of the three newest and must survive`)
      assert.ok(dropped.includes(newest) === false, `${newest} must not be collected`)
    }
  })

  it('verdicts() ignores an out-of-contract verdict instead of counting NaN', () => {
    const lineage = new PassLineage()
    lineage.record(pass('good'))
    lineage.record({ ...pass('weird'), verdict: 'bogus' as ReasoningPass['verdict'] })
    const counts = lineage.verdicts()
    assert.equal(counts.contributed, 1)
    assert.ok(!('bogus' in counts), 'an unknown verdict must not add a phantom key')
    assert.ok(Object.values(counts).every((n) => Number.isFinite(n)), 'no count may be NaN')
  })
})

describe('audit — state/snapshots (specs 38, 77)', () => {
  it('a caller mutation after create cannot rewrite a stored snapshot', () => {
    const store = new SnapshotStore()
    const shared = { pass: { verdict: 'verified' } }
    const before = store.create('s1', { state: shared })
    const after = store.create('s2', { state: { pass: { verdict: 'unverified' } } })
    shared.pass.verdict = 'unverified'
    assert.equal(before.hash, fingerprint(before.data), 'hash must still describe the stored data')
    assert.deepEqual(store.diff('s1', 's2').changed, ['state'], 'a real change must be visible in the diff')
  })

  it('diff reports a removed key whose name shadows a prototype member', () => {
    const store = new SnapshotStore()
    store.create('with', { toString: 'shadowed', keep: 1 })
    store.create('without', { keep: 1 })
    assert.deepEqual(store.diff('with', 'without').removed, ['toString'])
  })
})

describe('audit — state/cache (spec 65)', () => {
  it('canonicalize distinguishes undefined from JSON null', () => {
    assert.notEqual(canonicalize({ v: undefined }), canonicalize({ v: null }))
    assert.notEqual(fingerprint(undefined), fingerprint(null), 'a fingerprint must not certify one artifact as another')
  })
})

describe('audit — state/registry (spec 100)', () => {
  it('a policy id carries exactly one active record and the highest active version wins', () => {
    const registry = new PolicyRegistry()
    registry.register({ id: 'p', version: '2.0.0', owner: 'o', active: true, hash: 'h2' })
    registry.register({ id: 'p', version: '1.0.0', owner: 'o', active: true, hash: 'h1' })
    assert.equal(registry.versions('p').filter((v) => v.active).length, 1, 'exactly one active record per id')
    assert.equal(registry.getActive('p')?.version, '2.0.0', 'the highest active version wins, not the last registered')
  })

  it('a registered policy is immune to caller mutation', () => {
    const registry = new PolicyRegistry()
    const record = { id: 'p', version: '1.0.0', owner: 'o', active: true, hash: 'original' }
    registry.register(record)
    record.hash = 'tampered'
    assert.equal(registry.getActive('p')?.hash, 'original')
  })
})

describe('audit — config (specs 14, 96)', () => {
  it('rejects a fractional counter instead of silently rounding the budget', async () => {
    const { resolveConfig } = await import('../../src/config/defaults.ts')
    for (const partial of [
      { budget: { maxReplans: 0.5 } },
      { budget: { maxMergesPerStage: 2.5 } },
      { reasoning: { convergenceTurns: 1.5 } },
    ]) {
      assert.throws(() => resolveConfig(partial), 'a fractional counter must fail loud with its field path')
    }
  })
})

describe('audit — hooks (spec 6)', () => {
  it('effort escalates once per task, not once per pre-step over the whole transcript', async () => {
    const ctx = await setup()
    try {
      const preStep = async (messages: unknown[]) =>
        (ctx as unknown as {
          waterfall(t: unknown, n: string, p: unknown, next: () => Promise<unknown>): Promise<unknown>
        }).waterfall(ctx, 'agent/pre-step', { messages, turn: 1, step: 1 }, async () => ({ kind: 'enter' }))
      await preStep([{ content: 'please research this topic' }])
      const once = ctx.fable51.effortTier
      await preStep([{ content: 'please research this topic' }, { content: 'still working' }])
      assert.equal(ctx.fable51.effortTier, once, 'one search signal escalates one rung, not one per step')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('audit — policy service (specs 95, 28)', () => {
  it('stageCost never shrinks when the cost-ledger ring evicts old bookings', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      for (let i = 0; i < 5000; i += 1) {
        svc.recordCost({ stage: 'pass:p1', tokens: 100, latencyMs: 10, riskWeight: 1, at: i })
      }
      const before = svc.stageCost('pass:p1')
      svc.recordCost({ stage: 'pass:other', tokens: 1, latencyMs: 1, riskWeight: 1, at: 5001 })
      const after = svc.stageCost('pass:p1')
      assert.ok(after.tokens >= before.tokens, 'running stage cost must never decrease')
      assert.ok(after.risk >= before.risk, 'booked risk must never decrease')
      assert.equal(after.tokens, before.tokens)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a new session starts its escalation ladder at retry, not at the previous session rung', async () => {
    const ctx = await setup()
    try {
      ctx.emit('session/created', { id: 'A' } as never)
      for (let i = 0; i < 4; i += 1) {
        const step = await call(ctx, 'escalation-ladder', { failed: true })
        assert.ok((step.output as { rung: string }).rung.length > 0)
      }
      ctx.emit('session/created', { id: 'B' } as never)
      const fresh = await call(ctx, 'escalation-ladder', { failed: true })
      assert.equal((fresh.output as { rung: string }).rung, 'retry', 'session B must not inherit session A rung')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('audit — tools/verification (specs 19, 47)', () => {
  it('idempotency reports firstSeen=false once the input has been fingerprinted', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'idempotency', { input: { stage: 'verify', files: 3 } })
      assert.equal((first.output as { firstSeen: boolean }).firstSeen, true)
      const replay = await call(ctx, 'idempotency', { input: { stage: 'verify', files: 3 } })
      assert.equal((replay.output as { firstSeen: boolean }).firstSeen, false, 'a replayed call is not a first sighting')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('chain-of-verification refuses to certify a chain of blank layers', async () => {
    const ctx = await setup()
    try {
      const chain = await call(ctx, 'chain-of-verification', { layers: ['', ' '] })
      assert.notEqual(chain.output.verdict, 'verified', 'two blank layers are not two verification layers')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('audit — tools that failed open on unvalidated arguments', () => {
  it('timeboxing records a distinct snapshot per expiry', async () => {
    const ctx = await setup()
    try {
      await call(ctx, 'timeboxing', { stage: 'extract', elapsedMs: 700_000 })
      await call(ctx, 'timeboxing', { stage: 'extract', elapsedMs: 900_000 })
      const ids = ctx.fable51.snapshots.ids().filter((id) => id.startsWith('extract-timebox'))
      assert.equal(ids.length, 2, 'the second expiry must not overwrite the first expiry record')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('observability rejects a non-numeric token count', async () => {
    const ctx = await setup()
    try {
      const line = await call(ctx, 'observability', { stage: 's', verdict: 'neutral', tokens: '10' })
      assert.equal(line.ok, false, 'a string must not be echoed into a verification trace')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('pass-sla rejects a missing passId instead of booking under a shared stage', async () => {
    const ctx = await setup()
    try {
      const sla = await call(ctx, 'pass-sla', { latencyMs: 10, tokens: 10, accuracy: 0.1 })
      assert.equal(sla.ok, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('spec-clarification rejects a non-numeric replan count', async () => {
    const ctx = await setup()
    try {
      const clarify = await call(ctx, 'spec-clarification', { readings: ['one'], replanCount: '3' })
      assert.equal(clarify.ok, false, 'a stringly-typed replan count must not read as zero replans')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('escalation-ladder rejects a non-boolean failure flag', async () => {
    const ctx = await setup()
    try {
      const rung = await call(ctx, 'escalation-ladder', { failed: 'yes' })
      assert.equal(rung.ok, false, 'a truthy non-boolean must not be read as a success')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('abort-criteria rejects non-boolean safety flags', async () => {
    const ctx = await setup()
    try {
      const abort = await call(ctx, 'abort-criteria', { budgetExceeded: 'yes', converged: false, contradiction: false })
      assert.equal(abort.ok, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('partial-delivery never ships an unverified prior under a verified envelope', async () => {
    const ctx = await setup()
    try {
      const delivery = await call(ctx, 'partial-delivery', { finalVerified: false, priorOutput: 'prev' })
      assert.equal(delivery.verdict, 'unverified', 'the envelope must not certify an unverified delivery')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('interleaved-budget reads live stage spend instead of replaying the first answer', async () => {
    const ctx = await setup()
    try {
      // Call once so the answer is cached, then spend: the second call must
      // re-read stageTokens instead of replaying the pre-spend headroom.
      const first = await call(ctx, 'interleaved-budget', { requested: 5_000 })
      assert.equal((first.output as { headroom: number }).headroom, 400_000)
      await call(ctx, 'token-budget-per-stage', { stage: 'reasoning', tokens: 399_000 })
      const budget = await call(ctx, 'interleaved-budget', { requested: 5_000 })
      assert.equal(budget.rerun, false, 'the tool is effectful: it must re-execute, not replay')
      assert.equal((budget.output as { headroom: number }).headroom, 1_000, 'headroom must reflect the booked stage spend')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reasoning-rollback re-reads the snapshot index on an identical query', async () => {
    const ctx = await setup()
    try {
      const none = await call(ctx, 'reasoning-rollback', { passId: 'p1' })
      assert.equal(none.output.revertedTo, null)
      await call(ctx, 'reasoning-checkpoint', { passId: 'cp', state: { turn: 1 } })
      const replayed = await call(ctx, 'reasoning-rollback', { passId: 'p1' })
      assert.equal(replayed.output.revertedTo, 'cp', 'an identical rollback must not replay a stale target')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('merge-strategy refuses once the per-stage merge budget is spent', async () => {
    const ctx = await setup()
    try {
      for (let i = 0; i < 8; i += 1) {
        const ok = await call(ctx, 'merge-strategy', { strategy: 'union', sets: [[`n${i}`]] })
        assert.equal(ok.ok, true, `merge ${i + 1} is inside the budget`)
      }
      const over = await call(ctx, 'merge-strategy', { strategy: 'union', sets: [['n9']] })
      assert.equal(over.ok, false, 'the ninth merge exceeds maxMergesPerStage and must be refused')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reasoning-replay refuses to match an artifact that was never supplied', async () => {
    const ctx = await setup()
    try {
      const { fingerprint } = await import('../../src/state/cache.ts')
      const replay = await call(ctx, 'reasoning-replay', { traceHash: fingerprint(null) })
      assert.equal(replay.ok, false, 'a missing actual must not match a null trace hash')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reasoning-dedup answers a malformed item inside the tool, not as a host error', async () => {
    const ctx = await setup()
    try {
      const dedup = await call(ctx, 'reasoning-dedup', { items: [1, 2] })
      assert.equal(dedup.ok, false)
      assert.match(String((dedup.output as { error: string }).error), /items must be an array of strings/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reasoning-garbage-collection rejects a negative keepLastN', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      for (const id of ['a', 'b', 'c']) svc.recordPass(pass(id))
      const gc = await call(ctx, 'reasoning-garbage-collection', { liveIds: [], keepLastN: -1 })
      assert.equal(gc.ok, false, 'a negative keep-last-N is a typo, not "keep none"')
      assert.equal(svc.lineage.size(), 3, 'no pass may be collected from an invalid call')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reasoning-garbage-collection rejects a non-array liveIds', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      svc.recordPass(pass('keep-me'))
      const gc = await call(ctx, 'reasoning-garbage-collection', { keepLastN: 0 })
      assert.equal(gc.ok, false, 'an omitted liveIds must not empty the whole lineage')
      assert.equal(svc.lineage.size(), 1, 'no pass may be collected from an invalid call')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stage-graph-dag rejects duplicate node ids', async () => {
    const ctx = await setup()
    try {
      const order = await call(ctx, 'stage-graph-dag', { nodes: ['a', 'a'], edges: [] })
      assert.equal(order.ok, false, 'a repeated id is not a stage')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
