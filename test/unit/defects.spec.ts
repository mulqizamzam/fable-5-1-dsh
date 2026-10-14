/**
 * Unit: defect twins — every test here FAILS on the pre-fix code and passes
 * after. Each encodes the exact reproducer observed against the live bundle.
 *
 * Context: the plugin was already installed and firing on every agent turn
 * when these defects were found. The names carry the defect, not the method.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { resolveConfig } from '../../src/config/defaults.ts'

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

async function raw(ctx: Context, name: string, args: Record<string, unknown>): Promise<{
  isError: boolean
  value: unknown
}> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${name}`),
    name: `fable51.${name}`,
    arguments: args,
  })
  return { isError: result.isError, value: result.value }
}

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await raw(ctx, name, args)
  assert.equal(result.isError, false, `tool fable51.${name} threw: ${JSON.stringify(result.value)}`)
  return result.value as Envelope
}

const waterfall = (ctx: Context, name: string, payload: unknown, next: () => Promise<unknown>) =>
  (ctx as unknown as {
    waterfall(t: unknown, n: string, p: unknown, next: () => Promise<unknown>): Promise<unknown>
  }).waterfall(ctx, name, payload, next)

describe('defect: cache replay froze every counter', () => {
  it('DEFECT-1 token-budget-per-stage accumulates on an identical repeated call', async () => {
    const ctx = await setup()
    try {
      const args = { stage: 'proof-1', tokens: 250 }
      const first = await call(ctx, 'token-budget-per-stage', args)
      const second = await call(ctx, 'token-budget-per-stage', args)
      assert.equal(first.output.used, 250)
      assert.equal(second.output.used, 500, 'an effectful tool must re-run, not replay a cached total')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('DEFECT-2 escalation-ladder advances one rung per failure', async () => {
    const ctx = await setup()
    try {
      const rungs: string[] = []
      for (let i = 0; i < 4; i += 1) rungs.push(String((await call(ctx, 'escalation-ladder', { failed: true })).output.rung))
      assert.deepEqual(rungs, ['retry', 'replan', 'downgrade', 'ask'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('defect: the envelope asserted verified unconditionally', () => {
  it('DEFECT-3 anti-introspection surfaces its own unverified verdict in the envelope', async () => {
    const ctx = await setup()
    try {
      const value = await call(ctx, 'anti-introspection', { claim: 'verified', artifact: '', command: '', output: '' })
      assert.equal(value.output.verdict, 'unverified')
      assert.equal(value.verdict, 'unverified', 'envelope must not certify what the tool rejected')
      assert.ok(value.unverified.length > 0, 'the missing evidence must be listed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('DEFECT-4 a failed verification gate does not certify', async () => {
    const ctx = await setup()
    try {
      const value = await call(ctx, 'verification-gates', {
        check: 'build', cmd: 'tsc -b', expected: 'exit 0', actual: 'FAIL',
      })
      assert.equal(value.output.pass, false)
      assert.equal(value.verdict, 'unverified')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('DEFECT-5 a throwing tool returns an ok:false envelope instead of killing the call', async () => {
    const ctx = await setup()
    try {
      const result = await raw(ctx, 'chain-of-verification', { layers: 'not-an-array' })
      assert.equal(result.isError, false, 'a malformed argument must not surface as a host-level tool error')
      const value = result.value as Envelope
      assert.equal(value.ok, false)
      assert.equal(value.verdict, 'unverified')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('defect: misconfiguration fell back silently', () => {
  it('DEFECT-6 a non-object config is rejected instead of becoming 100% defaults', () => {
    for (const bad of [null, 42, 'x', [], false]) {
      assert.throws(() => resolveConfig(bad), /config/, `resolveConfig(${JSON.stringify(bad)}) must throw`)
    }
  })

  it('DEFECT-7 an unknown config key is rejected, not dropped', () => {
    assert.throws(() => resolveConfig({ totallyUnknown: 1 }), /totallyUnknown/)
    assert.throws(() => resolveConfig({ sandbox: { allowlist: ['/tmp'] } }), /allowlist/)
  })

  it('DEFECT-8 allow-list values must be string arrays', () => {
    assert.throws(() => resolveConfig({ sandbox: { allowList: { read: 'not-an-array' } } }), /allowList/)
  })
})

describe('defect: safety gates failed open', () => {
  it('DEFECT-9 human-in-the-loop requires approval when the flags are omitted', async () => {
    const ctx = await setup()
    try {
      const value = await call(ctx, 'human-in-the-loop', { action: 'delete production database' })
      assert.equal(value.output.required, true, 'an omitted flag must fail closed, never to "no approval needed"')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('DEFECT-10 an independent replication is not correlated with its source pass', async () => {
    const ctx = await setup()
    try {
      const a = await call(ctx, 'independent-replication', { passId: 'proof-a', input: { v: 1 } })
      const b = await call(ctx, 'independent-replication', { passId: 'proof-b', input: { v: 1 } })
      assert.notEqual(a.output.seed, b.output.seed, 'a replica derived from a constant seed is the same run twice')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('defect: state grew for the lifetime of the host', () => {
  it('DEFECT-11 the worklog is bounded', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      for (let i = 0; i < 20000; i += 1) {
        svc.recordWorklog({ stage: 's', output: `entry ${i}`, check: 'c', verdict: 'neutral', unverified: [], at: i })
      }
      assert.ok(svc.worklog.length <= 5000, `worklog grew unbounded to ${svc.worklog.length}`)
      assert.equal(svc.worklog.at(-1)?.output, 'entry 19999', 'the newest entries must be the ones kept')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('DEFECT-12 the cache is bounded', async () => {
    const ctx = await setup()
    try {
      const cache = ctx.fable51.cache
      for (let i = 0; i < 20000; i += 1) cache.set(cache.key({ i }, '99', 'sha256:none'), i)
      assert.ok(cache.size <= 2000, `cache grew unbounded to ${cache.size}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('DEFECT-13 the stage token budget is a per-turn budget, not a lifetime one', async () => {
    const ctx = await setup()
    try {
      ctx.fable51.addStageTokens('llm:proof', 500_000)
      assert.equal(ctx.fable51.stageTokens.get('llm:proof'), 500_000)
      // 'session/event' is declared with a scoped `this`, so its published arity counts a
      // receiver cordis never passes at runtime; reach it through cordis like the waterfall helper.
      const internals = ctx as unknown as { emit(n: string, s: unknown, e: unknown): void }
      internals.emit('session/event', {} as never, { type: 'turn/start' } as never)
      assert.equal(ctx.fable51.stageTokens.get('llm:proof'), undefined, 'a new turn must not inherit the previous turn’s exhausted budget')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('defect: a plugin error could kill the agent step', () => {
  it('DEFECT-14 agent/pre-step still admits the step when the service throws', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      svc.recordWorklog = () => { throw new Error('boom') }
      let admitted = false
      const decision = await waterfall(ctx, 'agent/pre-step', { messages: [], turn: 9, step: 9 }, async () => {
        admitted = true
        return { kind: 'enter' }
      })
      assert.equal(admitted, true, 'a plugin fault must not veto the step')
      assert.deepEqual(decision, { kind: 'enter' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
