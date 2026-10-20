/**
 * Unit: cost tool group, specs 11, 60, 95, 97 (PRD §4.2/§4.5/§4.9, Gate 4d).
 *
 * Host setup mirrors test/integration/bundle.spec.ts:
 * a real Cordis Context with the real dsh services. Fable51Policy injects
 * ['tools','llm','sessions'], so all four services must load or the plugin
 * stays pending and ctx.fable51 never resolves.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'

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
  isError: boolean
  value: {
    ok: boolean
    spec: string
    output: Record<string, unknown>
    verdict: string
    unverified: string[]
    rerun: boolean
    gates: unknown[]
  }
  content: unknown
}

async function exec(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c1'), name, arguments: args })
  return result as unknown as Envelope
}

describe('fable51_namespace', () => {
  it('registers all four cost tools under fable51.* and none at root', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      for (const expected of [
        'fable51_cost-accuracy-tradeoff',
        'fable51_reasoning-cost-model',
        'fable51_pass-cost-accounting',
        'fable51_pass-sla',
      ]) {
        assert.ok(names.includes(expected), `expected ${expected} in [${names.join(', ')}]`)
      }
      for (const name of names) {
        assert.match(name, /^fable51_/, `tool ${name} must stay in the fable51 namespace`)
      }
      assert.ok(!names.includes('cost-accuracy-tradeoff'), 'no un-namespaced tool at the root')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 11, cost-accuracy-tradeoff', () => {
  it('maps task class to tier, the deterministic cost curve, and accuracy', async () => {
    const ctx = await setup()
    try {
      const search = await exec(ctx, 'fable51_cost-accuracy-tradeoff', { taskClass: 'search' })
      assert.equal(search.isError, false, JSON.stringify(search.content))
      assert.equal(search.value.spec, '11')
      assert.equal(search.value.output.tier, 'mid')
      assert.equal(search.value.output.expectedCost, 100_000)
      assert.equal(search.value.output.accuracy, 0.85)

      const open = await exec(ctx, 'fable51_cost-accuracy-tradeoff', { taskClass: 'open' })
      assert.equal(open.value.output.tier, 'max')
      assert.equal(open.value.output.expectedCost, 2_000_000)
      assert.equal(open.value.output.accuracy, 0.99)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('bounded maps to the low tier and rerun replays the same output (spec 19)', async () => {
    const ctx = await setup()
    try {
      const first = await exec(ctx, 'fable51_cost-accuracy-tradeoff', { taskClass: 'bounded' })
      assert.equal(first.value.rerun, false)
      assert.equal(first.value.output.tier, 'low')
      assert.equal(first.value.output.expectedCost, 10_000)
      const second = await exec(ctx, 'fable51_cost-accuracy-tradeoff', { taskClass: 'bounded' })
      assert.equal(second.value.rerun, true)
      assert.equal(second.value.output.tier, 'low')
      assert.equal(second.value.output.expectedCost, 10_000)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 60, reasoning-cost-model', () => {
  it('computes cost = tokens*0.000002 + latencyMs*0.000001 + riskWeight*1000 exactly', async () => {
    const ctx = await setup()
    try {
      const res = await exec(ctx, 'fable51_reasoning-cost-model', { tokens: 1_000_000, latencyMs: 1_000_000, riskWeight: 3 })
      assert.equal(res.isError, false, JSON.stringify(res.content))
      assert.equal(res.value.spec, '60')
      const expected = 1_000_000 * 0.000002 + 1_000_000 * 0.000001 + 3 * 1000
      assert.equal(res.value.output.cost, expected)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('zero inputs cost 0 and each riskWeight unit adds exactly 1000', async () => {
    const ctx = await setup()
    try {
      const zero = await exec(ctx, 'fable51_reasoning-cost-model', { tokens: 0, latencyMs: 0, riskWeight: 0 })
      assert.equal(zero.value.output.cost, 0)
      const one = await exec(ctx, 'fable51_reasoning-cost-model', { tokens: 0, latencyMs: 0, riskWeight: 1 })
      const two = await exec(ctx, 'fable51_reasoning-cost-model', { tokens: 0, latencyMs: 0, riskWeight: 2 })
      assert.equal(one.value.output.cost, 1000)
      assert.equal(two.value.output.cost, 2000)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rerun replays the same output (idempotent, spec 19)', async () => {
    const ctx = await setup()
    try {
      const first = await exec(ctx, 'fable51_reasoning-cost-model', { tokens: 123, latencyMs: 456, riskWeight: 1 })
      assert.equal(first.value.rerun, false)
      const second = await exec(ctx, 'fable51_reasoning-cost-model', { tokens: 123, latencyMs: 456, riskWeight: 1 })
      assert.equal(second.value.rerun, true)
      assert.equal(second.value.output.cost, first.value.output.cost)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 95, pass-cost-accounting', () => {
  it('books producer+verifier latency and retries as risk, then reports the stage cost', async () => {
    const ctx = await setup()
    try {
      const res = await exec(ctx, 'fable51_pass-cost-accounting', { passId: 'p1', tokens: 5000, latencyMs: 100, retries: 1, verifierMs: 40 })
      assert.equal(res.isError, false, JSON.stringify(res.content))
      assert.equal(res.value.spec, '95')
      assert.equal(res.value.output.tokens, 5000)
      assert.equal(res.value.output.latencyMs, 140)
      assert.equal(res.value.output.risk, 1)
      const booked = ctx.fable51.costLedger.filter((e) => e.stage === 'pass:p1')
      assert.equal(booked.length, 1)
      assert.equal(booked[0]!.latencyMs, 140)
      assert.equal(booked[0]!.riskWeight, 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-executes on an identical rerun and books the pass twice (spec 19)', async () => {
    const ctx = await setup()
    try {
      const args = { passId: 'p1', tokens: 5000, latencyMs: 100, retries: 1, verifierMs: 40 }
      const first = await exec(ctx, 'fable51_pass-cost-accounting', args)
      assert.equal(first.value.rerun, false)
      assert.equal(ctx.fable51.costLedger.filter((e) => e.stage === 'pass:p1').length, 1)
      const second = await exec(ctx, 'fable51_pass-cost-accounting', args)
      // Effectful: the old unconditional cache replayed the first answer, so the second booking never happened.
      assert.equal(second.value.rerun, false)
      assert.equal(ctx.fable51.costLedger.filter((e) => e.stage === 'pass:p1').length, 2, 'each call must book its own ledger entry')
      assert.deepEqual(second.value.output, { tokens: 10_000, latencyMs: 280, risk: 2 }, 'the running stage cost must include both bookings')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 97, pass-sla', () => {
  it('passes cleanly within config defaults and records no breach worklog', async () => {
    const ctx = await setup()
    try {
      const res = await exec(ctx, 'fable51_pass-sla', { passId: 'sla-ok', latencyMs: 1000, tokens: 1000, accuracy: 0.95 })
      assert.equal(res.isError, false, JSON.stringify(res.content))
      assert.equal(res.value.spec, '97')
      assert.deepEqual(res.value.output.breaches, [])
      assert.equal(res.value.output.action, 'ok')
      assert.equal(ctx.fable51.worklog.filter((w) => w.stage === 'pass:sla-ok').length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('detects latency/token/accuracy breaches, logs one worklog line, and degrades', async () => {
    const ctx = await setup()
    try {
      const res = await exec(ctx, 'fable51_pass-sla', { passId: 'sla-bad', latencyMs: 200000, tokens: 500000, accuracy: 0.5 })
      assert.equal(res.value.spec, '97')
      assert.deepEqual(res.value.output.breaches, ['latency', 'tokens', 'accuracy'])
      assert.equal(res.value.output.action, 'log+degrade')
      const lines = ctx.fable51.worklog.filter((w) => w.stage === 'pass:sla-bad')
      assert.equal(lines.length, 1, 'a breach must record exactly one worklog line')
      assert.ok(lines[0]!.unverified.includes('latency'), 'breach must be listed as unverified evidence')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('honors per-target overrides and records a second breach line on an identical rerun', async () => {
    const ctx = await setup()
    try {
      const args = { passId: 'sla-acc', latencyMs: 100, tokens: 100, accuracy: 0.85, targets: { accuracy: 0.95 } }
      const first = await exec(ctx, 'fable51_pass-sla', args)
      assert.equal(first.value.rerun, false)
      assert.deepEqual(first.value.output.breaches, ['accuracy'])
      assert.equal(first.value.output.action, 'log+degrade')
      const second = await exec(ctx, 'fable51_pass-sla', args)
      // Effectful: the old unconditional cache replayed the first answer, so the second breach was never logged.
      assert.equal(second.value.rerun, false)
      assert.deepEqual(second.value.output.breaches, ['accuracy'])
      const lines = ctx.fable51.worklog.filter((w) => w.stage === 'pass:sla-acc')
      assert.equal(lines.length, 2, 'each breach must record its own worklog line')
      assert.ok(lines.every((l) => l.unverified.includes('accuracy')), 'both lines must name the breached dimension')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
