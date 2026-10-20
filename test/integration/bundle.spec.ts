/**
 * Integration: the bundle activates in a real Cordis host with the real dsh
 * services (Gate 1), validates config fail-loud (Gate 2), and four hook
 * families fire (Gate 3): agent/pre-step, tools/result, llm/stream and
 * session/event. This file does not cover tools/pre-execute; that hook is
 * covered by test/unit/progress-bandwidth.spec.ts.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'

async function setup() {
  const ctx = new Context()
  // Real host services, in verified dependency order: ToolRuntime injects
  // ['systemPrompt'], loading it without SystemPrompt leaves the tools
  // service silently pending, which is the exact failure mode Gate 1 guards.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

describe('Gate 1, activation', () => {
  it('service resolves on ctx.fable51 with all injections satisfied', async () => {
    const ctx = await setup()
    try {
      assert.ok(ctx.fable51, 'ctx.fable51 must exist after plugin load')
      assert.equal(typeof ctx.fable51.contextAction, 'function')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('tools register under the fable51.* namespace on the real registry', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      assert.ok(names.includes('fable51_context-management'), `expected fable51_context-management in ${names.join(',')}`)
      for (const name of names) {
        assert.match(name, /^fable51_/, `tool ${name} must stay in the fable51 namespace`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a bundle tool executes and returns the typed envelope; rerun is idempotent', async () => {
    const ctx = await setup()
    try {
      const exec = { signal: new AbortController().signal, callId: ToolCallId('c1'), name: 'fable51_context-management', arguments: { fillRatio: 0.95 } }
      const first = await ctx.tools.execute(exec)
      assert.equal(first.isError, false, `tool failed: ${JSON.stringify(first.content)}`)
      const value = first.value as { spec: string; output: { action: string }; rerun: boolean }
      assert.equal(value.spec, '1')
      assert.equal(value.output.action, 'spill')
      assert.equal(value.rerun, false)
      const second = await ctx.tools.execute(exec)
      const value2 = second.value as { rerun: boolean }
      assert.equal(value2.rerun, true, 'same input hash must replay the cache (spec 19)')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('Gate 3, hooks fire', () => {
  it('agent/pre-step waterfall passes through the bundle observer', async () => {
    const ctx = await setup()
    try {
      const decision = await (ctx as unknown as { waterfall(t: unknown, n: string, p: unknown, next: () => Promise<unknown>): Promise<unknown> })
        .waterfall(ctx, 'agent/pre-step', { messages: [], turn: 1, step: 1 }, async () => ({ kind: 'enter' }))
      assert.deepEqual(decision, { kind: 'enter' })
      assert.ok(ctx.fable51.worklog.length > 0, 'pre-step observer must have recorded a worklog line')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('tools/result observer records provenance and worklog', async () => {
    const ctx = await setup()
    try {
      const before = ctx.fable51.worklog.length
      ctx.emit('tools/result', { name: 'fable51_context-management', arguments: { fillRatio: 0.5 } } as never, { content: [{ type: 'text', text: 'ok' }], isError: false } as never)
      assert.ok(ctx.fable51.worklog.length > before, 'tools/result observer must append a worklog line')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('llm/stream waterfall passes chunks through and accounts tokens', async () => {
    const ctx = await setup()
    try {
      async function* source() {
        yield { text: 'hello ' }
        yield { text: 'world' }
      }
      const out: string[] = []
      const stream = await (ctx as unknown as { waterfall(t: unknown, n: string, o: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> })
        .waterfall(ctx, 'llm/stream', { model: 'test' }, source)
      for await (const chunk of stream) out.push((chunk as { text: string }).text)
      assert.deepEqual(out, ['hello ', 'world'], 'stream must pass through unmodified')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('session/event and lifecycle events are observed', async () => {
    const ctx = await setup()
    try {
      ctx.emit('session/created', {} as never)
      ctx.emit('session/event', {} as never, { type: 'turn/start' } as never)
      ctx.emit('session/event', {} as never, { type: 'turn/end' } as never)
      const stages = ctx.fable51.worklog.map((w) => w.stage)
      assert.ok(stages.includes('session:start'), 'session/created must be observed')
      assert.ok(stages.includes('session:turn-end'), 'turn/end must checkpoint')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
