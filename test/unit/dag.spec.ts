/**
 * Unit: the DAG tool group — specs 17, 34, 50, 93 (Gate 4c).
 *
 * Host setup follows test/integration/bundle.spec.ts, but loads every service
 * the policy injects: Fable51Policy declares inject ['tools','llm','sessions'],
 * so without LlmRuntime and SessionStore the service stays pending and
 * ctx.fable51 never resolves (verified before writing this file).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'

interface Envelope {
  readonly ok: boolean
  readonly spec: string
  readonly verdict: 'verified' | 'unverified'
  readonly unverified: readonly unknown[]
  readonly output: Record<string, unknown>
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

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; value?: Envelope; content?: unknown }> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${name}-${Math.random().toString(36).slice(2)}`),
    name: `fable51_${name}`,
    arguments: args,
  })
  return result as { isError: boolean; value?: Envelope; content?: unknown }
}

async function run(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await call(ctx, name, args)
  assert.equal(result.isError, false, `fable51_${name} failed: ${JSON.stringify(result.content)}`)
  assert.ok(result.value, `fable51_${name} returned no value`)
  assert.equal(result.value.ok, true)
  return result.value
}

async function runFails(ctx: Context, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await call(ctx, name, args)
  // A rejected argument is a tool-level answer now, never a host-level throw.
  assert.equal(result.isError, false, `fable51_${name} must not surface a host-level tool error`)
  const value = result.value
  assert.ok(value, `fable51_${name} returned no envelope for ${JSON.stringify(args)}`)
  assert.equal(value.ok, false, `fable51_${name} must reject ${JSON.stringify(args)}`)
  assert.equal(value.verdict, 'unverified')
  const { error } = value.output as { error?: unknown }
  assert.equal(typeof error, 'string', 'a rejected call must carry a reason in output.error')
  const message = error as string
  assert.match(message, /\S/)
  assert.deepEqual(value.unverified, [message], 'the envelope must name the failure as unverified')
  return message
}

function order(value: Record<string, unknown>): string[] {
  return value.order as string[]
}

describe('spec 17 — stage-graph-dag', () => {
  const nodes = ['a', 'b', 'c', 'd']
  const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']] as const

  it('topo-sorts a diamond DAG so every prerequisite precedes its stage', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'stage-graph-dag', { nodes, edges })
      assert.equal(value.spec, '17')
      const sorted = order(value.output)
      assert.deepEqual(sorted, ['a', 'b', 'c', 'd'])
      assert.deepEqual(value.output.cycle, [])
      for (const [from, to] of edges) {
        assert.ok(sorted.indexOf(from) < sorted.indexOf(to), `${from} must precede ${to} in ${sorted.join(',')}`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('treats a cycle as a hard fail: null order plus the offending cycle path', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'stage-graph-dag', {
        nodes: ['a', 'b', 'c'],
        edges: [['a', 'b'], ['b', 'c'], ['c', 'b']],
      })
      assert.equal(value.output.order, null, 'a cyclic graph must never produce an order')
      const cycle = value.output.cycle as string[]
      assert.deepEqual(cycle, ['b', 'c', 'b'])
      assert.equal(cycle[0], cycle[cycle.length - 1], 'the cycle walk is closed')
      assert.deepEqual([...new Set(cycle)].sort(), ['b', 'c'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sorts a self-dependent stage as a cycle of length one', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'stage-graph-dag', { nodes: ['a', 'b'], edges: [['b', 'b'], ['a', 'b']] })
      assert.equal(value.output.order, null)
      assert.deepEqual(value.output.cycle, ['b', 'b'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an edge that references an undeclared stage', async () => {
    const ctx = await setup()
    try {
      const reason = await runFails(ctx, 'stage-graph-dag', { nodes: ['a'], edges: [['a', 'b']] })
      assert.match(reason, /undeclared node b/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is idempotent: a rerun replays the same order (spec 19)', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, 'stage-graph-dag', { nodes, edges })
      assert.equal(first.rerun, false)
      const second = await run(ctx, 'stage-graph-dag', { nodes, edges })
      assert.equal(second.rerun, true)
      assert.deepEqual(second.output, first.output)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 34 — reasoning-dag', () => {
  it('records a pass chain and reports ancestors nearest-first', async () => {
    const ctx = await setup()
    try {
      const root = await run(ctx, 'reasoning-dag', { passId: 'root', deps: [] })
      assert.equal(root.spec, '34')
      assert.deepEqual(root.output, { recorded: true, ancestors: [] })

      const mid = await run(ctx, 'reasoning-dag', { passId: 'mid', deps: ['root'] })
      assert.deepEqual(mid.output, { recorded: true, ancestors: ['root'] })

      const leaf = await run(ctx, 'reasoning-dag', { passId: 'leaf', deps: ['mid', 'root'] })
      assert.deepEqual(leaf.output, { recorded: true, ancestors: ['mid', 'root'] })

      const recorded = ctx.fable51.lineage.get('leaf')
      assert.ok(recorded, 'the pass must be in the lineage')
      assert.equal(recorded.verdict, 'contributed')
      assert.equal(recorded.parentId, 'mid', 'the first dep carries the parent edge')
      assert.deepEqual(recorded.deps, ['mid', 'root'], 'every dep stays recorded as an edge')
      assert.equal(recorded.score.weighted, recorded.score.evidence + recorded.score.coherence + recorded.score.coverage - recorded.score.contradiction)
      assert.deepEqual(ctx.fable51.lineage.children('mid'), ['leaf'])
      assert.deepEqual(ctx.fable51.lineage.ancestors('leaf'), ['mid', 'root'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('re-runs on an identical call and the lineage still refuses the duplicate', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, 'reasoning-dag', { passId: 'root', deps: [] })
      assert.equal(first.rerun, false)
      const before = ctx.fable51.lineage.size()
      // Effectful: the old unconditional cache replayed the first answer, so the append-only guard was never reached.
      const reason = await runFails(ctx, 'reasoning-dag', { passId: 'root', deps: [] })
      assert.match(reason, /pass root is already recorded/)
      assert.equal(ctx.fable51.lineage.size(), before, 'a rejected duplicate must not double-record (spec 19)')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('blocks a pass whose dependency is not recorded yet', async () => {
    const ctx = await setup()
    try {
      const reason = await runFails(ctx, 'reasoning-dag', { passId: 'orphan', deps: ['missing'] })
      assert.match(reason, /unrecorded passes: missing/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses to record the same pass id twice', async () => {
    const ctx = await setup()
    try {
      await run(ctx, 'reasoning-dag', { passId: 'p', deps: [] })
      // A different dependency list is a different input hash, so the call is
      // not an idempotent replay and must reach the append-only guard.
      const reason = await runFails(ctx, 'reasoning-dag', { passId: 'p', deps: ['other'] })
      assert.match(reason, /already recorded/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 50 — deadlock-detection', () => {
  it('detects mutual wait and reports the closed cycle', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'deadlock-detection', { waits: [['a', 'b'], ['b', 'a']] })
      assert.equal(value.spec, '50')
      assert.equal(value.output.deadlock, true)
      assert.deepEqual(value.output.cycle, ['a', 'b', 'a'])

      const threeWay = await run(ctx, 'deadlock-detection', { waits: [['a', 'b'], ['b', 'c'], ['c', 'a']] })
      assert.equal(threeWay.output.deadlock, true)
      const cycle = threeWay.output.cycle as string[]
      assert.equal(cycle[0], cycle[cycle.length - 1])
      assert.deepEqual([...new Set(cycle)].sort(), ['a', 'b', 'c'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports no deadlock for an acyclic wait-for graph', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'deadlock-detection', {
        waits: [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']],
      })
      assert.equal(value.output.deadlock, false)
      assert.deepEqual(value.output.cycle, [])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is idempotent: a rerun replays the same verdict (spec 19)', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, 'deadlock-detection', { waits: [['a', 'b'], ['b', 'a']] })
      assert.equal(first.rerun, false)
      const second = await run(ctx, 'deadlock-detection', { waits: [['a', 'b'], ['b', 'a']] })
      assert.equal(second.rerun, true)
      assert.deepEqual(second.output, first.output)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 93 — pass-dependency-inference', () => {
  it('infers shared-fact edges minus the declared ones', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'pass-dependency-inference', {
        declaredEdges: [['a', 'b']],
        sharedFacts: [['a', 'b'], ['b', 'c'], ['c', 'd']],
      })
      assert.equal(value.spec, '93')
      assert.deepEqual(value.output.inferred, [['b', 'c'], ['c', 'd']])
      assert.deepEqual(value.output.declared, [['a', 'b']])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('compares edges by direction and drops repeated inferences', async () => {
    const ctx = await setup()
    try {
      const value = await run(ctx, 'pass-dependency-inference', {
        declaredEdges: [['b', 'a']],
        sharedFacts: [['a', 'b'], ['a', 'b'], ['b', 'a']],
      })
      assert.deepEqual(value.output.inferred, [['a', 'b']], 'the reverse edge is not the declared one, and duplicates collapse')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is idempotent: a rerun replays the same inference (spec 19)', async () => {
    const ctx = await setup()
    try {
      const args = { declaredEdges: [['a', 'b']], sharedFacts: [['a', 'b'], ['b', 'c']] }
      const first = await run(ctx, 'pass-dependency-inference', args)
      assert.equal(first.rerun, false)
      const second = await run(ctx, 'pass-dependency-inference', args)
      assert.equal(second.rerun, true)
      assert.deepEqual(second.output, first.output)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('fable51.* namespace', () => {
  it('keeps every registered tool inside the namespace and carries the DAG group specs', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((schema) => schema.name)
      assert.ok(names.length > 0, 'the bundle must register tools')
      for (const name of names) {
        assert.match(name, /^fable51_/, `tool ${name} must stay in the fable51 namespace`)
      }
      assert.equal(new Set(names).size, names.length, 'a tool name must be registered once')
      for (const [name, spec] of [
        ['stage-graph-dag', '17'],
        ['reasoning-dag', '34'],
        ['deadlock-detection', '50'],
        ['pass-dependency-inference', '93'],
      ] as const) {
        assert.ok(names.includes(`fable51_${name}`), `fable51_${name} must be registered — registered: ${names.join(', ')}`)
        const value = await run(ctx, name, name === 'reasoning-dag'
          ? { passId: 'ns-pass', deps: [] }
          : name === 'deadlock-detection'
            ? { waits: [['a', 'b']] }
            : name === 'pass-dependency-inference'
              ? { declaredEdges: [['a', 'b']], sharedFacts: [['b', 'c']] }
              : { nodes: ['a', 'b'], edges: [['a', 'b']] })
        assert.equal(value.spec, spec)
        assert.equal(value.verdict, 'verified', 'the envelope verdict must be verified')
        assert.deepEqual(value.unverified, [], 'nothing unverified may be left implicit')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a malformed DAG payload instead of guessing', async () => {
    const ctx = await setup()
    try {
      const reason = await runFails(ctx, 'stage-graph-dag', { nodes: ['a', 'b'], edges: [['a']] })
      assert.match(reason, /\[from, to\] pair/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
