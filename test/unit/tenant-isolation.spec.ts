/**
 * Unit: tenant isolation.
 *
 * One host serves many sessions, and before this the worklog, the gate log,
 * the cost ledger, the pass lineage, the snapshots and the cache were
 * host-wide. One tenant could read another's spend and another's history,
 * and the budget advisor computed a recommendation from bookings the caller
 * never made.
 *
 * A tenant is the boundary, and the working directory is the one the host
 * already draws. Two sessions in different directories are two tenants.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { DEFAULT_TENANT, scopeKeyOf } from '../../src/state/tenant.ts'

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy, config)
  return ctx
}

interface Envelope {
  readonly ok: boolean
  readonly spec: string
  readonly output: Record<string, unknown>
  readonly verdict: string
}

/** Call a tool the way the agent loop does: the execution carries the session. */
async function callAs(
  ctx: Context,
  session: { id: string; cwd?: string },
  name: string,
  args: Record<string, unknown> = {},
): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`t-${name}`),
    name: `fable51_${name}`,
    arguments: args,
    agent: { session } as never,
  })
  assert.equal(result.isError, false, `tool fable51_${name} threw: ${JSON.stringify(result.value)}`)
  return result.value as unknown as Envelope
}

describe('tenant isolation', () => {
  it('one tenant never sees another tenant cost ledger', async () => {
    const ctx = await setup()
    try {
      const alpha = scopeKeyOf('/work/alpha', 'A')
      const beta = scopeKeyOf('/work/beta', 'B')

      ctx.fable51.recordCost({ stage: 'alpha', tokens: 1000, latencyMs: 5, riskWeight: 0, at: Date.now() }, alpha)
      ctx.fable51.recordCost({ stage: 'beta', tokens: 2000, latencyMs: 5, riskWeight: 0, at: Date.now() }, beta)

      assert.equal(ctx.fable51.costLedgerOf(alpha).length, 1)
      assert.equal(ctx.fable51.costLedgerOf(beta).length, 1)
      assert.equal(ctx.fable51.costLedgerOf(alpha)[0]?.stage, 'alpha')
      assert.equal(ctx.fable51.costLedgerOf(beta)[0]?.stage, 'beta')
      assert.equal(ctx.fable51.stageCost('alpha', alpha).tokens, 1000)
      assert.equal(ctx.fable51.stageCost('alpha', beta).tokens, 0, 'a tenant must not pay for another tenant stage')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('one tenant never sees another tenant worklog or gate log', async () => {
    const ctx = await setup()
    try {
      const alpha = scopeKeyOf('/work/alpha', 'A')
      const beta = scopeKeyOf('/work/beta', 'B')

      ctx.fable51.recordWorklog({
        stage: 'alpha-only',
        output: 'a',
        check: 'c',
        verdict: 'neutral',
        unverified: [],
        at: Date.now(),
      }, alpha)
      ctx.fable51.recordGate({ gate: 'g', cmd: 'c', expected: 'x', actual: 'y', pass: false, at: Date.now() }, beta)

      assert.equal(ctx.fable51.worklogOf(alpha).filter((entry) => entry.stage === 'alpha-only').length, 1)
      assert.equal(ctx.fable51.worklogOf(beta).filter((entry) => entry.stage === 'alpha-only').length, 0)
      assert.equal(ctx.fable51.gateLogOf(beta).length, 1)
      assert.equal(ctx.fable51.gateLogOf(alpha).length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('one tenant never sees another tenant lineage', async () => {
    const ctx = await setup()
    try {
      const alpha = scopeKeyOf('/work/alpha', 'A')
      const beta = scopeKeyOf('/work/beta', 'B')
      const pass = {
        id: 'p1', spec: '69', parentId: null, inHash: 'i', outHash: 'o',
        deps: [], verdict: 'neutral' as const,
        score: { evidence: 0, coherence: 0, coverage: 0, contradiction: 0, weighted: 0 },
        startedAt: 0, endedAt: 0, tokens: 0, latencyMs: 0, unverified: [],
      }

      ctx.fable51.recordPass(pass, alpha)
      assert.equal(ctx.fable51.lineageOf(alpha).all().length, 1)
      assert.equal(ctx.fable51.lineageOf(beta).all().length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('two sessions of one tenant share the tenant state but not the episode', async () => {
    const ctx = await setup()
    try {
      const alpha = scopeKeyOf('/work/alpha', 'A')
      const alphaOther = scopeKeyOf('/work/alpha', 'A2')

      ctx.fable51.recordCost({ stage: 'shared', tokens: 500, latencyMs: 1, riskWeight: 0, at: Date.now() }, alpha)

      assert.equal(ctx.fable51.costLedgerOf(alphaOther).length, 1, 'the tenant state is shared')
      assert.notEqual(alpha, alphaOther, 'but the session is not')
      assert.equal(ctx.fable51.episode(alpha).stageTokens.size, 0)
      assert.equal(ctx.fable51.episode(alphaOther).stageTokens.size, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a tool call in one tenant does not charge the other tenant budget', async () => {
    const ctx = await setup()
    try {
      await callAs(ctx, { id: 'A', cwd: '/work/alpha' }, 'token-budget-per-stage', { stage: 'llm:x', tokens: 1000 })

      const alpha = scopeKeyOf('/work/alpha', 'A')
      const beta = scopeKeyOf('/work/beta', 'B')
      assert.equal(ctx.fable51.episode(alpha).stageTokens.get('llm:x'), 1000)
      assert.equal(ctx.fable51.episode(beta).stageTokens.get('llm:x'), undefined)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the budget advisor recommends from the caller tenant ledger only', async () => {
    const ctx = await setup()
    try {
      const alpha = scopeKeyOf('/work/alpha', 'A')
      const beta = scopeKeyOf('/work/beta', 'B')
      for (let i = 0; i < 10; i += 1) {
        ctx.fable51.recordCost({ stage: 'tool:heavy', tokens: 200_000, latencyMs: 100, riskWeight: 0, at: Date.now() }, beta)
      }

      const out = await callAs(ctx, { id: 'A', cwd: '/work/alpha' }, 'budget-advisor', { taskClass: 'open' })
      const advisor = out.output as { sampleSize: number; stageStats: unknown[]; recommended: { stageTokenBudget: number } }
      assert.equal(advisor.sampleSize, 0, 'the caller must not see the other tenant bookings')
      assert.equal(advisor.stageStats.length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the inspect output names the tenant it belongs to', async () => {
    const ctx = await setup()
    try {
      const out = await callAs(ctx, { id: 'A', cwd: '/work/alpha' }, 'inspect', { format: 'json' })
      const inspect = out.output as { tenant: string; session: string }
      assert.equal(inspect.tenant, '/work/alpha')
      assert.equal(inspect.session, scopeKeyOf('/work/alpha', 'A'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a session with no directory lands in the default tenant', async () => {
    const ctx = await setup()
    try {
      const out = await callAs(ctx, { id: 'A' }, 'inspect', { format: 'json' })
      const inspect = out.output as { tenant: string }
      assert.equal(inspect.tenant, DEFAULT_TENANT)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('session mode makes every session its own tenant', async () => {
    const ctx = await setup({ tenants: { mode: 'session' } })
    try {
      const out = await callAs(ctx, { id: 'A', cwd: '/work/alpha' }, 'inspect', { format: 'json' })
      const inspect = out.output as { tenant: string; session: string }
      assert.equal(inspect.tenant, 'A', 'the session id is the tenant')
      assert.equal(inspect.session, scopeKeyOf('A', 'A'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('none mode puts every session in one tenant', async () => {
    const ctx = await setup({ tenants: { mode: 'none' } })
    try {
      const first = await callAs(ctx, { id: 'A', cwd: '/work/alpha' }, 'inspect', { format: 'json' })
      const second = await callAs(ctx, { id: 'B', cwd: '/work/beta' }, 'inspect', { format: 'json' })
      assert.equal((first.output as { tenant: string }).tenant, DEFAULT_TENANT)
      assert.equal((second.output as { tenant: string }).tenant, DEFAULT_TENANT)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a tool call whose agent view names no directory still lands in the created session tenant', async () => {
    const ctx = await setup()
    try {
      // The session lifecycle sees the full session, directory included, and
      // records the tenant. The agent's live view of that session carries the
      // id but not the directory, so the call has to find the tenant there.
      ctx.emit('session/created', { id: 'A', cwd: '/work/alpha' } as never)
      const out = await callAs(ctx, { id: 'A' }, 'inspect', { format: 'json' })
      assert.equal((out.output as { tenant: string }).tenant, '/work/alpha')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reads the directory from the session header, the way the host does', async () => {
    const ctx = await setup()
    try {
      // The live session keeps the directory on its header, and the host reads
      // it from there too.
      ctx.emit('session/created', { id: 'A', header: { cwd: '/work/alpha' } } as never)
      const out = await callAs(ctx, { id: 'A' }, 'inspect', { format: 'json' })
      assert.equal((out.output as { tenant: string }).tenant, '/work/alpha')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the idle tenant does not grow without bound', async () => {
    const ctx = await setup({ tenants: { maxTenants: 4 } })
    try {
      for (let i = 0; i < 20; i += 1) {
        await callAs(ctx, { id: `S${i}`, cwd: `/work/project-${i}` }, 'inspect', { format: 'json' })
      }
      assert.ok(ctx.fable51.tenants.size <= 4, `the registry grew to ${ctx.fable51.tenants.size}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
