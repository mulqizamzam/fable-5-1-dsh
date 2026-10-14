/**
 * Proof tests for the defect fixes (bugs + spec gaps) found in the audit.
 *
 * Each test names the spec it guards and is written to FAIL on the
 * pre-fix code: revert src/ and rerun this file to confirm.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { PolicyRegistry } from '../../src/state/registry.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

async function call(ctx: Context, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('fix'),
    name: `fable51.${name}`,
    arguments: args,
  })
}

describe('BUG 1 — spec 39 contradiction-detection must compare canonically', () => {
  it('does not report a contradiction for equal content with different key order', async () => {
    const ctx = await setup()
    try {
      const res = await call(ctx, 'contradiction-detection', {
        claims: [
          { id: 'a', value: { x: 1, y: 2 } },
          { id: 'b', value: { y: 2, x: 1 } },
        ],
      })
      assert.equal(res.isError, false)
      const out = (res as unknown as { value: { output: { contradictions: string[][] } } }).value.output
      assert.deepEqual(out.contradictions, [], 'canonical-equal values are not a contradiction')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still reports a genuine contradiction', async () => {
    const ctx = await setup()
    try {
      const res = await call(ctx, 'contradiction-detection', {
        claims: [
          { id: 'a', value: { x: 1 } },
          { id: 'b', value: { x: 2 } },
        ],
      })
      const out = (res as unknown as { value: { output: { contradictions: string[][] } } }).value.output
      assert.deepEqual(out.contradictions, [['a', 'b']])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('BUG 2 — spec 70 speculative-verify must compare canonically', () => {
  it('verifies a matching partial artifact regardless of key order', async () => {
    const ctx = await setup()
    try {
      const res = await call(ctx, 'speculative-verify', {
        partial: { ok: true, items: [1, 2] },
        expectation: { items: [1, 2], ok: true },
      })
      assert.equal(res.isError, false)
      const out = (res as unknown as { value: { output: { verdict: string; diverged: boolean } } }).value.output
      assert.equal(out.verdict, 'verified')
      assert.equal(out.diverged, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('BUG 3 — spec 5 verification-gates must be fail-loud, not forgeable', () => {
  it('rejects missing fields instead of recording a passing gate', async () => {
    const ctx = await setup()
    try {
      const forged = await call(ctx, 'verification-gates', {})
      // guard: a malformed gate is an ok:false envelope, never a host tool error that looks forgeable (spec 5)
      const forgedOut = (forged as unknown as { value: { ok: boolean; output: { error: string } } }).value
      assert.equal(forgedOut.ok, false, 'a gate with no expected/actual outcome must not pass')
      assert.equal(forgedOut.output.error, 'check must be a non-empty string')
      const before = ctx.fable51.gateLog.length
      const half = await call(ctx, 'verification-gates', { check: 'c', cmd: 'run', expected: 'A' })
      const halfOut = (half as unknown as { value: { ok: boolean; output: { error: string } } }).value
      assert.equal(halfOut.ok, false, 'a gate without an observed outcome must not pass')
      assert.equal(halfOut.output.error, 'actual must be a non-empty string')
      assert.equal(ctx.fable51.gateLog.length, before, 'no gate may be recorded from incomplete args')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('still records a well-formed passing gate and a failing one', async () => {
    const ctx = await setup()
    try {
      const pass = await call(ctx, 'verification-gates', { check: 'c', cmd: 'run', expected: 'A', actual: 'A' })
      assert.equal(pass.isError, false)
      const fail = await call(ctx, 'verification-gates', { check: 'c2', cmd: 'run', expected: 'A', actual: 'B' })
      const out = (fail as unknown as { value: { output: { pass: boolean } } }).value.output
      assert.equal(out.pass, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('BUG 4 — spec 14 replan-budget verdict must come from accounted state', () => {
  it('escalates on the service counter even when the caller under-reports', async () => {
    const ctx = await setup()
    try {
      await call(ctx, 'replan-budget', { replanCount: 1 })
      await call(ctx, 'replan-budget', { replanCount: 2 })
      const third = await call(ctx, 'replan-budget', { replanCount: 0 })
      const out = (third as unknown as { value: { output: { allowed: boolean; escalate: boolean; count: number } } }).value.output
      assert.equal(out.count, 3)
      assert.equal(out.allowed, false, 'the accounted count, not the caller number, decides')
      assert.equal(out.escalate, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('BUG 5 — policy registry must order versions numerically, not lexicographically', () => {
  it('sorts 1.10.0 after 1.9.0', () => {
    const registry = new PolicyRegistry()
    registry.register({ id: 'p', version: '1.9.0', owner: 'o', active: false, hash: 'h1' })
    registry.register({ id: 'p', version: '1.10.0', owner: 'o', active: false, hash: 'h2' })
    assert.deepEqual(registry.versions('p').map((v) => v.version), ['1.9.0', '1.10.0'])
  })

  it('keeps equal-width versions ordered and still forbids duplicates', () => {
    const registry = new PolicyRegistry()
    registry.register({ id: 'p', version: '1.2.0', owner: 'o', active: false, hash: 'h1' })
    registry.register({ id: 'p', version: '1.10.0', owner: 'o', active: false, hash: 'h2' })
    registry.register({ id: 'p', version: '1.9.0', owner: 'o', active: false, hash: 'h3' })
    assert.deepEqual(registry.versions('p').map((v) => v.version), ['1.2.0', '1.9.0', '1.10.0'])
    assert.throws(() => registry.register({ id: 'p', version: '1.9.0', owner: 'o', active: false, hash: 'h4' }), /mutation is forbidden/)
  })
})

describe('GAP 1 — spec 6 effort-escalation on search/multihop signals', () => {
  it('escalates the effort tier when the pre-step message carries an escalation signal', async () => {
    const ctx = await setup()
    try {
      const before = ctx.fable51.effortTier
      await (ctx as unknown as { waterfall(t: unknown, n: string, p: unknown, next: () => Promise<unknown>): Promise<unknown> })
        .waterfall(ctx, 'agent/pre-step', {
          messages: [{ role: 'user', content: 'this task needs a multihop search across sources' }],
          turn: 1,
          step: 1,
        }, async () => ({ kind: 'enter' }))
      assert.notEqual(ctx.fable51.effortTier, before, 'an escalation signal must raise the tier')
      assert.ok(ctx.fable51.worklog.some((w) => w.check === 'effort escalation'), 'the escalation must be observable')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('GAP 2 — spec 15 pass labeling: parallel, sequential, interleaved are distinct', () => {
  it('labels a multi-dependency pass parallel and a single-dependency pass sequential', async () => {
    const ctx = await setup()
    try {
      await call(ctx, 'reasoning-lineage', { passId: 'root' })
      await call(ctx, 'reasoning-lineage', { passId: 'other' })
      const res = await call(ctx, 'reasoning-dag', { passId: 'join', deps: ['root', 'other'] })
      assert.equal(res.isError, false, 'multi-dep recording is the service surface under test')
      assert.equal(ctx.fable51.passLabels.get('root'), 'sequential')
      assert.equal(ctx.fable51.passLabels.get('join'), 'parallel')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('labels reasoning between tool calls interleaved from the llm/stream hook', async () => {
    const ctx = await setup()
    try {
      async function* source() {
        yield { text: 'alpha' }
      }
      const stream = await (ctx as unknown as { waterfall(t: unknown, n: string, o: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> })
        .waterfall(ctx, 'llm/stream', { model: 'fix-test' }, source)
      for await (const chunk of stream) void chunk
      assert.equal(ctx.fable51.passLabels.get('llm:fix-test'), 'interleaved')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('GAP 3 — spec 58 convergence: small deltas for N turns AND no new evidence', () => {
  it('converges only after stable turns with no new evidence', async () => {
    const ctx = await setup()
    try {
      async function* source() {
        yield { text: 'alpha' }
        yield { text: 'beta' }
      }
      const drive = async () => {
        const stream = await (ctx as unknown as { waterfall(t: unknown, n: string, o: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> })
          .waterfall(ctx, 'llm/stream', { model: 'conv' }, source)
        for await (const chunk of stream) void chunk
      }
      await drive()
      assert.equal(ctx.fable51.converged().converged, false, 'one stable turn is not convergence')
      await drive()
      await drive()
      const stable = ctx.fable51.converged()
      assert.equal(stable.converged, true, 'N stable turns with no new evidence converge')
      ctx.emit('tools/result', { name: 'fable51.context-management', arguments: {} } as never, { content: [{ type: 'text', text: 'fresh artifact' }], isError: false } as never)
      assert.equal(ctx.fable51.converged().converged, false, 'new evidence blocks convergence')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('GAP 4 — spec 96 fork/merge budget is consumed per stage', () => {
  it('falls back to merge once the per-stage fork budget is spent', async () => {
    const ctx = await setup()
    try {
      const max = ctx.fable51.config.budget.maxForksPerStage
      // Distinct args per call: identical args replay the cached first output
      // instead of re-executing (spec 19 idempotency) — same convention as the
      // escalation suite's state-advancing tools.
      for (let i = 0; i < max; i += 1) {
        const res = await call(ctx, 'reasoning-forking', { candidateCount: 2, budgetLeft: 999, attempt: i })
        assert.equal((res as unknown as { value: { output: { decision: string } } }).value.output.decision, 'fork')
      }
      const spent = await call(ctx, 'reasoning-forking', { candidateCount: 2, budgetLeft: 999, attempt: 'spent' })
      assert.equal((spent as unknown as { value: { output: { decision: string } } }).value.output.decision, 'merge', 'the stage fork budget caps repeated forks')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('GAP 5 — specs 10/18 handoff + rollback to the last verified checkpoint', () => {
  it('writes a handoff snapshot with stage map and last hash on session disposal', async () => {
    const ctx = await setup()
    try {
      await call(ctx, 'reasoning-checkpoint', { passId: 'cp-1', state: { turn: 1 } })
      ctx.emit('session/disposed', {} as never)
      const handoffId = [...ctx.fable51.snapshots.ids()].reverse().find((id) => id.startsWith('session-handoff'))
      const handoff = handoffId ? ctx.fable51.snapshots.get(handoffId) : undefined
      assert.ok(handoff, 'session disposal must persist the handoff state')
      assert.ok(Array.isArray(handoff.data.stageMap), 'the handoff carries the stage map')
      assert.equal(typeof handoff.data.lastHash, 'string')
      assert.ok(String(handoff.data.lastHash).startsWith('sha256:'), 'the handoff carries the last checkpoint hash')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rolls back to the last verified checkpoint, skipping unverified timeout snapshots', async () => {
    const ctx = await setup()
    try {
      await call(ctx, 'reasoning-checkpoint', { passId: 'good', state: { turn: 1 } })
      const timeout = await call(ctx, 'pass-timeout', { passId: 'stuck', elapsedMs: 999_999 })
      assert.equal((timeout as unknown as { value: { output: { passed: boolean } } }).value.output.passed, false)
      const res = await call(ctx, 'reasoning-rollback', { passId: 'after-timeout' })
      const out = (res as unknown as { value: { output: { revertedTo: string | null } } }).value.output
      assert.equal(out.revertedTo, 'good', 'rollback must not revert to an unverified timeout snapshot')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('GAP 6 — spec 3 tool-call-batching partitions by dependency', () => {
  it('batches independent calls and serializes dependent ones', async () => {
    const ctx = await setup()
    try {
      const res = await call(ctx, 'tool-call-batching', {
        calls: [
          { name: 'read-a' },
          { name: 'read-b' },
          { name: 'join', deps: ['read-a'] },
        ],
      })
      assert.equal(res.isError, false, 'fable51.tool-call-batching must exist')
      const out = (res as unknown as { value: { output: { batches: string[][]; serialized: string[] } } }).value.output
      assert.deepEqual(out.batches, [['read-a', 'read-b'], ['join']])
      assert.deepEqual(out.serialized, ['join'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a cyclic call graph', async () => {
    const ctx = await setup()
    try {
      const res = await call(ctx, 'tool-call-batching', {
        calls: [
          { name: 'a', deps: ['b'] },
          { name: 'b', deps: ['a'] },
        ],
      })
      assert.equal(res.isError, false, 'a cycle is an answer, not a host throw')
      const out = (res as unknown as { value: { ok: boolean; output: { error: string } } }).value
      assert.equal(out.ok, false, 'a dependency cycle must not batch')
      // guard: the cycle still throws inside execute — the factory turns it into ok:false (spec 3)
      assert.equal(out.output.error, 'calls cannot batch: dependency cycle among a, b')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
