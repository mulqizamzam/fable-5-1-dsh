/**
 * Unit: escalation tools — specs 8, 14, 27, 28, 52, 72, 81 (Gate 4e).
 *
 * Runs against the real Cordis host and the real dsh tools registry (same
 * setup as test/integration/bundle.spec.ts). State-advancing tools (14, 28, 72)
 * are marked effectful: they bypass the content-addressed cache, so a repeated
 * identical call re-executes and advances service state again (spec 19).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { escalationTools } from '../../src/tools/escalation.ts'

interface Envelope {
  readonly spec: string
  readonly output: Record<string, unknown>
  readonly verdict: string
  readonly unverified: readonly string[]
  readonly rerun: boolean
  readonly gates: readonly unknown[]
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
    callId: ToolCallId('c1'),
    name: `fable51_${name}`,
    arguments: args,
  })
  assert.equal(result.isError, false, `fable51_${name} failed: ${JSON.stringify(result.content)}`)
  return (result as unknown as { value: Envelope }).value
}

describe('escalation group — namespace', () => {
  it('registers all seven escalation tools under the fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      const expected = [
        'spec-clarification',
        'replan-budget',
        'human-in-the-loop',
        'escalation-ladder',
        'abort-criteria',
        'pass-timeout',
        'pass-retry-policy',
      ]
      for (const name of expected) {
        assert.ok(names.includes(`fable51_${name}`), `expected fable51_${name} in ${names.join(',')}`)
      }
      for (const name of names) {
        assert.match(name, /^fable51_/, `tool ${name} must stay in the fable51 namespace`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 8 — spec-clarification', () => {
  it('proceeds on a single reading and halts on two or more readings', async () => {
    const ctx = await setup()
    try {
      const single = await call(ctx, 'spec-clarification', { readings: ['one reading'] })
      assert.equal(single.spec, '8')
      assert.equal(single.output.action, 'proceed')
      assert.equal(single.rerun, false)

      const competing = await call(ctx, 'spec-clarification', { readings: ['first', 'second'] })
      assert.equal(competing.output.action, 'ask')
      assert.match(String(competing.output.reason), /competing readings/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('halts on an explicit conflict or a third replan, but not on the second', async () => {
    const ctx = await setup()
    try {
      const conflict = await call(ctx, 'spec-clarification', { readings: ['one'], conflict: true })
      assert.equal(conflict.output.action, 'ask')
      assert.match(String(conflict.output.reason), /conflict/)

      const thirdReplan = await call(ctx, 'spec-clarification', { readings: ['one'], replanCount: 3 })
      assert.equal(thirdReplan.output.action, 'ask')
      assert.match(String(thirdReplan.output.reason), /replan count 3/)

      const secondReplan = await call(ctx, 'spec-clarification', { readings: ['one'], replanCount: 2 })
      assert.equal(secondReplan.output.action, 'proceed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('replays the cached halt on identical arguments', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'spec-clarification', { readings: ['a', 'b'] })
      assert.equal(first.rerun, false)
      const second = await call(ctx, 'spec-clarification', { readings: ['a', 'b'] })
      assert.equal(second.rerun, true)
      assert.equal(second.output.action, 'ask')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 14 — replan-budget', () => {
  it('allows replans up to the budget, escalates on the third, and advances the service counter', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'replan-budget', { replanCount: 1 })
      assert.equal(first.spec, '14')
      assert.equal(first.output.allowed, true)
      assert.equal(first.output.escalate, false)
      assert.equal(first.output.count, 1)
      assert.equal(first.rerun, false)

      const second = await call(ctx, 'replan-budget', { replanCount: 2 })
      assert.equal(second.output.allowed, true)
      assert.equal(second.output.escalate, false)
      assert.equal(second.output.count, 2)

      const third = await call(ctx, 'replan-budget', { replanCount: 3 })
      assert.equal(third.output.allowed, false)
      assert.equal(third.output.escalate, true)
      assert.equal(third.output.count, 3)
      assert.equal(ctx.fable51.replans, 3, 'each call must advance the service replan counter')

      const replay = await call(ctx, 'replan-budget', { replanCount: 3 })
      // Effectful: the old unconditional cache froze the budget at the first answer, so replans were never charged.
      assert.equal(replay.rerun, false)
      assert.equal(replay.output.count, 4)
      assert.equal(ctx.fable51.replans, 4, 'every call must advance the service replan counter')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 27 — human-in-the-loop', () => {
  it('requires approval for irreversible, external, or over-ceiling actions only', async () => {
    const ctx = await setup()
    try {
      const safe = await call(ctx, 'human-in-the-loop', { action: 'reason', irreversible: false, external: false, estimatedCost: 0 })
      assert.equal(safe.spec, '27')
      assert.equal(safe.output.required, false)
      assert.equal(safe.output.reason, 'within autonomous bounds')
      assert.equal(safe.rerun, false)

      const irreversible = await call(ctx, 'human-in-the-loop', { action: 'delete', irreversible: true, external: false, estimatedCost: 0 })
      assert.equal(irreversible.output.required, true)
      assert.equal(irreversible.output.reason, 'irreversible action')

      const external = await call(ctx, 'human-in-the-loop', { action: 'publish', irreversible: false, external: true, estimatedCost: 0 })
      assert.equal(external.output.required, true)
      assert.equal(external.output.reason, 'external effect')

      const costly = await call(ctx, 'human-in-the-loop', { action: 'fork', irreversible: false, external: false, estimatedCost: 500_001 })
      assert.equal(costly.output.required, true)
      assert.match(String(costly.output.reason), /above ceiling/)

      const atCeiling = await call(ctx, 'human-in-the-loop', { action: 'fork', irreversible: false, external: false, estimatedCost: 500_000 })
      assert.equal(atCeiling.output.required, false)

      const replay = await call(ctx, 'human-in-the-loop', { action: 'reason', irreversible: false, external: false, estimatedCost: 0 })
      assert.equal(replay.rerun, true)
      assert.equal(replay.output.required, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 28 — escalation-ladder', () => {
  it('advances exactly one rung per failure and never on a cached rerun', async () => {
    const ctx = await setup()
    try {
      const failed = await call(ctx, 'escalation-ladder', { failed: true })
      assert.equal(failed.spec, '28')
      assert.equal(failed.output.rung, 'retry')
      assert.deepEqual(failed.output.ladder, ['retry', 'replan', 'downgrade', 'ask'])
      assert.equal(failed.rerun, false)
      assert.equal(ctx.fable51.rung, 1)

      const replay = await call(ctx, 'escalation-ladder', { failed: true })
      // Effectful: the old unconditional cache replayed rung 1 forever, so a repeat failure never escalated.
      assert.equal(replay.rerun, false)
      assert.equal(replay.output.rung, 'replan')
      assert.equal(ctx.fable51.rung, 2, 'identical args must advance the ladder again, not replay it')

      const ok = await call(ctx, 'escalation-ladder', { failed: false })
      assert.equal(ok.output.rung, 'downgrade', 'a success reads the current rung without advancing')
      assert.equal(ctx.fable51.rung, 2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('walks the whole ladder in order and clamps at the last rung', async () => {
    const ctx = await setup()
    try {
      const spec = escalationTools().find((tool) => tool.name === 'escalation-ladder')
      assert.ok(spec, 'escalation-ladder spec must exist')
      const env = { service: ctx.fable51 }
      const walked: string[] = []
      for (let i = 0; i < 4; i += 1) {
        const out = (await spec.execute({ failed: true }, env)) as { rung: string }
        walked.push(out.rung)
      }
      assert.deepEqual(walked, ['retry', 'replan', 'downgrade', 'ask'])
      const clamped = (await spec.execute({ failed: true }, env)) as { rung: string }
      assert.equal(clamped.rung, 'ask', 'the ladder clamps at the last rung')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 52 — abort-criteria', () => {
  it('aborts on budget overrun or contradiction and proceeds on convergence', async () => {
    const ctx = await setup()
    try {
      const budget = await call(ctx, 'abort-criteria', { budgetExceeded: true, converged: false, contradiction: false })
      assert.equal(budget.spec, '52')
      assert.equal(budget.output.abort, true)
      assert.match(String(budget.output.reason), /budget exceeded/)
      assert.equal(budget.rerun, false)

      const contradiction = await call(ctx, 'abort-criteria', { budgetExceeded: false, converged: false, contradiction: true })
      assert.equal(contradiction.output.abort, true)
      assert.match(String(contradiction.output.reason), /contradiction/)

      const converged = await call(ctx, 'abort-criteria', { budgetExceeded: false, converged: true, contradiction: false })
      assert.equal(converged.output.abort, false)
      assert.equal(converged.output.reason, 'converged')

      const open = await call(ctx, 'abort-criteria', { budgetExceeded: false, converged: false, contradiction: false })
      assert.equal(open.output.abort, false)

      const replay = await call(ctx, 'abort-criteria', { budgetExceeded: true, converged: false, contradiction: false })
      assert.equal(replay.rerun, true)
      assert.equal(replay.output.abort, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 72 — pass-timeout', () => {
  it('passes within the deadline and snapshots an unverified verdict on breach', async () => {
    const ctx = await setup()
    try {
      const inTime = await call(ctx, 'pass-timeout', { passId: 'p1', elapsedMs: 1000 })
      assert.equal(inTime.spec, '72')
      assert.equal(inTime.output.passed, true)
      assert.equal(inTime.output.snapshotId, undefined)
      assert.equal(ctx.fable51.snapshots.get('p1-timeout'), undefined)
      assert.equal(inTime.rerun, false)

      const atDeadline = await call(ctx, 'pass-timeout', { passId: 'p1', elapsedMs: 120_000 })
      assert.equal(atDeadline.output.passed, true, 'exactly at the deadline still passes')

      const breached = await call(ctx, 'pass-timeout', { passId: 'p1', elapsedMs: 120_001 })
      assert.equal(breached.output.passed, false)
      assert.equal(breached.output.snapshotId, 'p1-timeout')

      const snapshot = ctx.fable51.snapshots.get('p1-timeout')
      assert.ok(snapshot, 'a timeout must snapshot the pass')
      assert.equal(snapshot.data.passId, 'p1')
      assert.equal(snapshot.data.elapsedMs, 120_001)
      assert.equal(snapshot.data.verdict, 'unverified')

      const entry = ctx.fable51.worklog.find((w) => w.stage === 'pass:p1')
      assert.ok(entry, 'a timeout must record a worklog line')
      assert.equal(entry.verdict, 'discarded')
      assert.ok(entry.unverified.some((line) => line.includes('p1')), 'the unverified list must name the pass')

      const replay = await call(ctx, 'pass-timeout', { passId: 'p1', elapsedMs: 120_001 })
      // Effectful: the old unconditional cache replayed the first answer, so a second breach was never recorded.
      assert.equal(replay.rerun, false)
      assert.equal(replay.output.snapshotId, 'p1-timeout')
      assert.equal(ctx.fable51.worklog.filter((w) => w.stage === 'pass:p1').length, 2, 'each breach must record its own worklog line')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 81 — pass-retry-policy', () => {
  it('retries twice with exponential backoff and aborts the third attempt', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'pass-retry-policy', { attempt: 1 })
      assert.equal(first.spec, '81')
      assert.equal(first.output.retry, true)
      assert.equal(first.output.backoffMs, 1000)
      assert.equal(first.output.abort, false)
      assert.equal(first.rerun, false)

      const second = await call(ctx, 'pass-retry-policy', { attempt: 2 })
      assert.equal(second.output.retry, true)
      assert.equal(second.output.backoffMs, 2000)
      assert.equal(second.output.abort, false)

      const third = await call(ctx, 'pass-retry-policy', { attempt: 3 })
      assert.equal(third.output.retry, false)
      assert.equal(third.output.backoffMs, null)
      assert.equal(third.output.abort, true)

      const replay = await call(ctx, 'pass-retry-policy', { attempt: 3 })
      assert.equal(replay.rerun, true)
      assert.equal(replay.output.abort, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
