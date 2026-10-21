/**
 * Unit: every tool, called twice.
 *
 * The first sweep called each tool once, which cannot see a stale answer:
 * a tool that served its second call from the cache looked exactly like a
 * tool that recomputed. That bug shipped twice, in the inspector and in the
 * budget advisor, and both times it was invisible to a one-call sweep.
 *
 * So every tool is called twice with the same arguments, and both directions
 * are checked.
 *
 * A pure tool must answer the same for the same input. Its second call may
 * come from the idempotency cache, and that is the point of the cache: the
 * answer is the same either way.
 *
 * A tool that touches state must never serve a cached answer, because a
 * replay would skip the mutation as well. Its second call must recompute,
 * and the state must show the effect happened twice.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { allToolSpecs } from '../../src/tools/index.ts'
import { DEFAULT_SCOPE } from '../../src/state/tenant.ts'
import { argsFor } from '../helpers/tool-args.ts'

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
  readonly rerun: boolean
}

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`twice-${name}`),
    name: `fable51_${name}`,
    arguments: args,
  })
  assert.equal(result.isError, false, `tool fable51_${name} threw: ${JSON.stringify(result.content)}`)
  return result.value as unknown as Envelope
}

describe('every tool, called twice', () => {
  it('a pure tool answers the same for the same input', async () => {
    const ctx = await setup()
    try {
      for (const spec of allToolSpecs()) {
        if (spec.effectful === true) continue
        const args = argsFor(spec.name)
        const first = await call(ctx, spec.name, args)
        const second = await call(ctx, spec.name, args)
        assert.deepEqual(
          second.output,
          first.output,
          `${spec.name} is a pure tool and must answer the same for the same input`,
        )
        assert.equal(second.verdict, first.verdict, `${spec.name} changed its verdict on a repeat call`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a tool that touches state never serves a cached answer', async () => {
    const ctx = await setup()
    try {
      for (const spec of allToolSpecs()) {
        if (spec.effectful !== true) continue
        const args = argsFor(spec.name)
        const first = await call(ctx, spec.name, args)
        const second = await call(ctx, spec.name, args)
        assert.equal(first.rerun, false, `${spec.name} must not report a replay on its first call`)
        assert.equal(
          second.rerun,
          false,
          `${spec.name} touches state, so a replayed answer would skip the mutation`,
        )
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the effect of a stateful tool happens twice, not once', async () => {
    const ctx = await setup()
    try {
      // The gates: a second call must record a second gate, not replay the
      // first answer and leave one gate behind.
      const gateArgs = { check: 'twice', cmd: 'true', expected: 'PASS', actual: 'PASS' }
      await call(ctx, 'verification-gates', gateArgs)
      await call(ctx, 'verification-gates', gateArgs)
      assert.equal(
        ctx.fable51.gateLogOf(DEFAULT_SCOPE).filter((gate) => gate.gate === 'twice').length,
        2,
        'two calls must record two gates',
      )

      // The stage budget: two calls must spend it twice.
      const budgetArgs = { stage: 'llm:twice', tokens: 500 }
      await call(ctx, 'token-budget-per-stage', budgetArgs)
      await call(ctx, 'token-budget-per-stage', budgetArgs)
      assert.equal(
        ctx.fable51.episode(DEFAULT_SCOPE).stageTokens.get('llm:twice'),
        1000,
        'two calls must spend the stage budget twice',
      )

      // The cost ledger: two calls must book two entries.
      const costArgs = { passId: 'twice', tokens: 25, latencyMs: 1, retries: 0, verifierMs: 0 }
      await call(ctx, 'pass-cost-accounting', costArgs)
      await call(ctx, 'pass-cost-accounting', costArgs)
      assert.equal(
        ctx.fable51.costLedgerOf(DEFAULT_SCOPE).filter((entry) => entry.stage === 'pass:twice').length,
        2,
        'two calls must book two ledger entries',
      )

      // The fork allowance: two calls must consume two forks.
      const forkArgs = { candidateCount: 2, budgetLeft: 5000 }
      await call(ctx, 'reasoning-forking', forkArgs)
      await call(ctx, 'reasoning-forking', forkArgs)
      assert.equal(
        ctx.fable51.episode(DEFAULT_SCOPE).forksThisStage,
        2,
        'two calls must consume two forks',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('the audit trail says which call ran and which was a replay', async () => {
    const ctx = await setup()
    try {
      // Two calls leave two trail lines, because two calls happened. What the
      // trail must show is which of them actually ran the body: without the
      // mark, a replayed call is indistinguishable from a real execution.
      const args = argsFor('chain-vs-tree')
      await call(ctx, 'chain-vs-tree', args)
      await call(ctx, 'chain-vs-tree', args)

      const lines = ctx.fable51.worklogOf(DEFAULT_SCOPE).filter((entry) => entry.stage === 'tool:fable51_chain-vs-tree')
      assert.equal(lines.length, 2, 'two calls must leave two trail lines')
      const replays = lines.filter((entry) => entry.check.includes('cache replay'))
      assert.equal(replays.length, 1, 'exactly one of the two calls was a replay')
      assert.equal(lines.filter((entry) => entry.check === 'tools/result observed').length, 1, 'the other call really ran')
      assert.equal(replays[0]?.verdict, 'neutral', 'a replay contributes nothing')
      assert.deepEqual(
        replays[0]?.unverified,
        ['the answer was replayed from the cache, the body did not run'],
        'a replay must say why it is not evidence',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
