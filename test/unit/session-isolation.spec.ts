/**
 * Unit: per-session episode isolation.
 *
 * The bundle's budget counters describe ONE run. Before this store existed
 * they lived on the host-wide service, so two sessions in one host shared
 * them: one session's turn/start reset the other's stage budget, and one
 * session's creation reset the other's escalation ladder. The reproducer
 * below is the observed failure, kept as the regression guard.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { DEFAULT_SESSION } from '../../src/state/episode.ts'
import { DEFAULT_SCOPE, DEFAULT_TENANT, scopeKeyOf } from '../../src/state/tenant.ts'

/** The scope of a session id: the default tenant, that session. */
const scopeOf = (sessionId: string): string => scopeKeyOf(DEFAULT_TENANT, sessionId)

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
  readonly ok: boolean
  readonly spec: string
  readonly output: Record<string, unknown>
  readonly verdict: string
}

/** Call a tool the way the agent loop does: the execution carries the session. */
async function callAs(ctx: Context, sessionId: string, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`iso-${name}`),
    name: `fable51_${name}`,
    arguments: args,
    agent: { session: { id: sessionId } } as never,
  })
  assert.equal(result.isError, false, `tool fable51_${name} threw: ${JSON.stringify(result.value)}`)
  return result.value as unknown as Envelope
}

describe('per-session episode isolation', () => {
  it('one session turn/start does not clear another session stage budget', async () => {
    const ctx = await setup()
    try {
      const svc = ctx.fable51
      // Session B is mid-run: it charged against its own stage budget.
      await callAs(ctx, 'B', 'token-budget-per-stage', { stage: 'stage-B', tokens: 5000 })
      assert.equal(svc.episode(scopeOf('B')).stageTokens.get('stage-B'), 5000)

      // Session A starts a turn. A is not B.
      ctx.emit('session/event', { id: 'A' } as never, { type: 'turn/start' } as never)

      assert.equal(
        svc.episode(scopeOf('B')).stageTokens.get('stage-B'),
        5000,
        "session A's turn/start must not reset session B's stage budget",
      )
      assert.equal(
        svc.episode(scopeOf('A')).stageTokens.size,
        0,
        "session A's turn/start starts A's own budget empty",
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('one session creation does not reset another session escalation ladder', async () => {
    const ctx = await setup()
    try {
      ctx.emit('session/created', { id: 'A' } as never)
      for (let i = 0; i < 3; i += 1) {
        await callAs(ctx, 'A', 'escalation-ladder', { failed: true })
      }
      assert.equal(ctx.fable51.episode(scopeOf('A')).rung, 3, 'session A advanced its own ladder')

      ctx.emit('session/created', { id: 'B' } as never)
      assert.equal(
        ctx.fable51.episode(scopeOf('A')).rung,
        3,
        "session B's creation must not reset session A's ladder",
      )
      assert.equal(ctx.fable51.episode(scopeOf('B')).rung, 0, "session B starts at rung zero")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('each session spends its own stage budget', async () => {
    const ctx = await setup()
    try {
      await callAs(ctx, 'A', 'token-budget-per-stage', { stage: 'llm:m', tokens: 1000 })
      await callAs(ctx, 'B', 'token-budget-per-stage', { stage: 'llm:m', tokens: 2000 })

      assert.equal(ctx.fable51.episode(scopeOf('A')).stageTokens.get('llm:m'), 1000)
      assert.equal(ctx.fable51.episode(scopeOf('B')).stageTokens.get('llm:m'), 2000)
      assert.equal(
        ctx.fable51.episode(DEFAULT_SCOPE).stageTokens.size,
        0,
        'an attributed call must not charge the unattributed bucket',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('each session gets its own fork allowance', async () => {
    const ctx = await setup()
    try {
      const maxForks = ctx.fable51.config.budget.maxForksPerStage
      for (let i = 0; i < maxForks; i += 1) {
        const forked = await callAs(ctx, 'A', 'reasoning-forking', { candidateCount: 2, budgetLeft: 1 })
        assert.equal(forked.output.decision, 'fork')
      }
      // A has spent its allowance; B must still be able to fork.
      const spent = await callAs(ctx, 'A', 'reasoning-forking', { candidateCount: 2, budgetLeft: 1 })
      assert.equal(spent.output.decision, 'merge', "session A's own fork budget is spent")

      const fresh = await callAs(ctx, 'B', 'reasoning-forking', { candidateCount: 2, budgetLeft: 1 })
      assert.equal(fresh.output.decision, 'fork', "session B must not inherit session A's fork budget")
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('an unattributed call is its own bucket, not a wildcard', async () => {
    const ctx = await setup()
    try {
      await callAs(ctx, 'A', 'token-budget-per-stage', { stage: 'llm:m', tokens: 1000 })
      // A session's turn must not clear the unattributed bucket either.
      ctx.emit('session/event', { id: 'A' } as never, { type: 'turn/start' } as never)
      assert.equal(
        ctx.fable51.episode(DEFAULT_SCOPE).stageTokens.size,
        0,
        'no session turn may reset the unattributed bucket',
      )
      assert.equal(ctx.fable51.episode(scopeOf('A')).stageTokens.size, 0, "session A's own turn did reset A")
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
