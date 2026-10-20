/**
 * Unit: specs 4 and 55, progress reporting and reasoning bandwidth.
 *
 * spec 4: the bundle narrates a stage transition and a gate failure, and
 * nothing else. A line per step is the narration spam the spec kills.
 *
 * spec 55: the service caps how many passes run at once, and the excess is
 * QUEUED rather than denied.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { TOOL_RUNTIME_SCHEDULER, type ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { DEFAULT_SESSION } from '../../src/state/episode.ts'

interface Waterfall {
  waterfall(t: unknown, n: string, p: unknown, next: () => Promise<unknown>): Promise<unknown>
}

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy, config)
  return ctx
}

/** Drive the pre-step waterfall the way the agent loop does. */
async function preStep(ctx: Context, sessionId: string, turn: number, step: number): Promise<void> {
  await (ctx as unknown as Waterfall).waterfall(
    ctx,
    'agent/pre-step',
    { messages: [], turn, step, agent: { session: { id: sessionId } } },
    async () => ({ kind: 'enter' }),
  )
}

function progressLines(ctx: Context): string[] {
  return ctx.fable51.worklog.filter((entry) => entry.check === 'progress record').map((entry) => entry.output)
}

describe('spec 4, progress reporting', () => {
  it('narrates a stage transition once per turn, not once per step', async () => {
    const ctx = await setup()
    try {
      await preStep(ctx, 'A', 1, 1)
      await preStep(ctx, 'A', 1, 2)
      await preStep(ctx, 'A', 1, 3)

      const lines = progressLines(ctx)
      assert.equal(lines.length, 1, `expected one progress line for three steps of one turn, got ${lines.length}`)
      assert.ok(lines[0]?.includes('stage transition'), `expected a stage transition, got ${lines[0]}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('narrates a new stage when the run moves to another turn', async () => {
    const ctx = await setup()
    try {
      await preStep(ctx, 'A', 1, 1)
      await preStep(ctx, 'A', 2, 1)

      const lines = progressLines(ctx)
      assert.equal(lines.length, 2, 'a new turn is a new stage')
      assert.ok(lines.every((line) => line.includes('stage transition')))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('narrates a failed gate exactly once', async () => {
    const ctx = await setup()
    try {
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('g1'),
        name: 'fable51_verification-gates',
        arguments: { check: 'build', cmd: 'make', expected: 'PASS', actual: 'FAIL' },
        agent: { session: { id: 'A' } } as never,
      })
      await preStep(ctx, 'A', 1, 1)
      await preStep(ctx, 'A', 1, 2)

      const lines = progressLines(ctx)
      const gateLines = lines.filter((line) => line.includes('gate failure'))
      assert.equal(gateLines.length, 1, `a failed gate must be narrated once, got ${gateLines.length}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a passing gate out of the progress trail', async () => {
    const ctx = await setup()
    try {
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('g2'),
        name: 'fable51_verification-gates',
        arguments: { check: 'build', cmd: 'make', expected: 'PASS', actual: 'PASS' },
        agent: { session: { id: 'A' } } as never,
      })
      await preStep(ctx, 'A', 1, 1)

      const lines = progressLines(ctx)
      assert.equal(lines.filter((line) => line.includes('gate failure')).length, 0, 'a passing gate is not news')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not narrate another session’s gate failure', async () => {
    const ctx = await setup()
    try {
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('g3'),
        name: 'fable51_verification-gates',
        arguments: { check: 'build', cmd: 'make', expected: 'PASS', actual: 'FAIL' },
        agent: { session: { id: 'A' } } as never,
      })
      // Session B is a different run: A's failure is not B's news.
      await preStep(ctx, 'B', 1, 1)

      const lines = progressLines(ctx)
      assert.equal(lines.filter((line) => line.includes('gate failure')).length, 0, 'B must not narrate A’s gate failure')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shows the progress trail in the inspect output', async () => {
    const ctx = await setup()
    try {
      await preStep(ctx, 'A', 1, 1)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('i1'),
        name: 'fable51_inspect',
        arguments: { format: 'json' },
        agent: { session: { id: 'A' } } as never,
      })
      const value = result.value as { output: { progress: Array<{ kind: string; detail: string }> } }
      assert.equal(value.output.progress.length, 1)
      assert.equal(value.output.progress[0]?.kind, 'stage-transition')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 55, reasoning bandwidth', () => {
  /** A tool that blocks until the test lets it go, so calls really overlap. */
  function registerBlockingTool(ctx: Context, gate: Promise<void>): void {
    ctx.tools.register({
      name: 'fable51_test-block',
      description: 'test-only tool that blocks until released',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object' },
        render: () => [{ type: 'text', text: 'ok' }],
      },
      execute: async () => {
        await gate
        return { released: true }
      },
    })
  }

  it('caps parallel passes and queues the excess instead of denying it', async () => {
    const ctx = await setup({ reasoning: { maxConcurrentPasses: 2 } })
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      registerBlockingTool(ctx, gate)

      const started: number[] = []
      const calls = [0, 1, 2].map((index) => {
        started.push(index)
        return ctx.tools.execute({
          signal: new AbortController().signal,
          callId: ToolCallId(`b${index}`),
          name: 'fable51_test-block',
          arguments: {},
        })
      })

      // Let the pre-execute listeners run: two take slots, the third queues.
      await new Promise((resolve) => setTimeout(resolve, 10))
      const bandwidth = ctx.fable51.bandwidth(DEFAULT_SESSION)
      assert.equal(bandwidth.cap, 2)
      assert.equal(bandwidth.inFlight, 2, 'never more than the cap may run at once')
      assert.equal(bandwidth.queued, 1, 'the excess must be queued, not dropped')

      release()
      const results = await Promise.all(calls)
      for (const result of results) {
        assert.equal(result.isError, false, `a queued call must still run: ${JSON.stringify(result.content)}`)
      }
      assert.equal(ctx.fable51.bandwidth(DEFAULT_SESSION).inFlight, 0, 'every slot must be given back')
      assert.equal(started.length, 3, 'no call may be refused')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not deadlock a parallel group that outruns the cap', async () => {
    const ctx = await setup({ reasoning: { maxConcurrentPasses: 2 } })
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      registerBlockingTool(ctx, gate)

      // The agent loop drives a parallel group like this: it awaits each
      // call's prepare before starting the next, dispatches without
      // awaiting, and finalizes the results later in model order. The
      // scheduler is the host's own surface, used here because the bug it
      // guards is invisible through ctx.tools.execute.
      const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const prepareAll = (async () => {
        const prepared = []
        for (let i = 0; i < 3; i += 1) {
          prepared.push(await scheduler.prepare({
            signal: new AbortController().signal,
            callId: ToolCallId(`g${i}`),
            name: 'fable51_test-block',
            arguments: {},
          }))
        }
        return prepared
      })()
      // A prepare that waits for a slot would hang the host, so the wait
      // becomes a failure with a name instead of a stalled test.
      const prepared = await Promise.race([
        prepareAll,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error('prepare blocked: a slot is being held across the pre-execute gate')),
          3000,
        )),
      ])

      const dispatches = prepared.map((entry) => scheduler.dispatch(entry.exec))
      await new Promise((resolve) => setTimeout(resolve, 20))
      const bandwidth = ctx.fable51.bandwidth(DEFAULT_SESSION)
      assert.equal(bandwidth.inFlight, 2, 'the cap must bound the running bodies')
      assert.equal(bandwidth.queued, 1, 'the third body must wait for a slot')

      release()
      const outcomes = await Promise.all(dispatches)
      for (const [index, entry] of prepared.entries()) {
        const outcome = outcomes[index]!
        if (outcome.kind === 'post-result') await scheduler.finalize(entry.exec, outcome.result)
        else scheduler.finish(entry.exec, outcome.result)
      }
      assert.equal(
        ctx.fable51.bandwidth(DEFAULT_SESSION).inFlight,
        0,
        'every slot must be given back after the group finishes',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('frees the slot when a call finishes', async () => {
    const ctx = await setup({ reasoning: { maxConcurrentPasses: 1 } })
    try {
      await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('s1'),
        name: 'fable51_chain-vs-tree',
        arguments: { branchFactor: 2 },
      })
      const bandwidth = ctx.fable51.bandwidth(DEFAULT_SESSION)
      assert.equal(bandwidth.inFlight, 0, 'a finished call must not hold its slot')
      assert.equal(bandwidth.peak, 1, 'the peak must record that the slot was taken')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not make a nested call wait for a slot, that would deadlock', async () => {
    const ctx = await setup({ reasoning: { maxConcurrentPasses: 1 } })
    try {
      // A nested call is part of a pass already running: it takes no slot.
      const scheduler = ctx.tools[TOOL_RUNTIME_SCHEDULER]
      const prepared = await scheduler.prepare({
        signal: new AbortController().signal,
        callId: ToolCallId('n1'),
        name: 'fable51_chain-vs-tree',
        arguments: { branchFactor: 2 },
        // The parent token is opaque; any symbol marks the call as nested.
        parent: Symbol('outer') as ToolExecutionToken,
      })
      if (prepared.kind !== 'dispatch') throw new Error('the call must be dispatchable')
      const outcome = await scheduler.dispatch(prepared.exec)
      if (outcome.kind === 'post-result') await scheduler.finalize(prepared.exec, outcome.result)
      else scheduler.finish(prepared.exec, outcome.result)
      assert.equal(ctx.fable51.bandwidth(DEFAULT_SESSION).inFlight, 0, 'a nested call must not take a slot')
      assert.equal(ctx.fable51.bandwidth(DEFAULT_SESSION).queued, 0, 'a nested call must never queue')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('shows the bandwidth state in the inspect output', async () => {
    const ctx = await setup()
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('i2'),
        name: 'fable51_inspect',
        arguments: { format: 'json' },
      })
      const value = result.value as { output: { bandwidth: { inFlight: number; cap: number; queued: number; peak: number; saturated: boolean } } }
      assert.equal(typeof value.output.bandwidth.cap, 'number')
      assert.equal(typeof value.output.bandwidth.inFlight, 'number')
      assert.equal(typeof value.output.bandwidth.queued, 'number')
      assert.equal(typeof value.output.bandwidth.peak, 'number')
      assert.equal(typeof value.output.bandwidth.saturated, 'boolean')
      assert.equal(value.output.bandwidth.cap, ctx.fable51.config.reasoning.maxConcurrentPasses)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
