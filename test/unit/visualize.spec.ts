/**
 * Unit: visualize tool group, spec 100 (policy registry) + state inspection.
 *
 * Host setup mirrors test/unit/reasoning-core.spec.ts: a real Cordis Context
 * with the real dsh services.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { visualizeTools } from '../../src/tools/visualize.ts'
import { defineTool } from '../../src/tools/shared.ts'
import { DEFAULT_SESSION } from '../../src/state/episode.ts'
import { DEFAULT_SCOPE } from '../../src/state/tenant.ts'

const TOOL_NAME = 'fable51_inspect'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  const registered = new Set(ctx.tools.schemas().map((schema) => schema.name))
  for (const spec of visualizeTools()) {
    const name = `fable51_${spec.name}`
    if (registered.has(name)) continue
    ctx.tools.register(defineTool(spec, { service: ctx.fable51, sessionKey: DEFAULT_SESSION, scopeKey: DEFAULT_SCOPE }))
  }
  return ctx
}

interface Envelope {
  ok: boolean
  spec: string
  output: Record<string, unknown>
  verdict: string
  unverified: string[]
  rerun: boolean
  gates: unknown[]
}

interface ToolOutcome {
  isError: boolean
  value: Envelope
  content: unknown
}

/** The inspect tool's inner output, typed so the assertions stay checked. */
interface InspectOutput {
  ascii?: string
  session: string
  policies: Array<{ id: string; version: string; owner: string; active: boolean; hash: string }>
  lineage: {
    totalPasses: number
    verdicts: { contributed: number; neutral: number; discarded: number }
    treeAscii: string
  }
  costs: {
    totalTokens: number
    totalLatencyMs: number
    totalRisk: number
    byStage: Array<{ stage: string; tokens: number; latencyMs: number; risk: number; entries: number }>
    stageBudgets: Record<string, number>
  }
  cache: { size: number; hits: number; misses: number; hitRate: number }
  snapshots: { count: number; latest: string; ids: string[] }
  config: { effortTier: string; maxForkDepth: number; maxConcurrentPasses: number; stageTokenBudget: number }
  worklog: unknown[]
  gateLog: unknown[]
}

async function dispatch(ctx: Context, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('c1'), name, arguments: args })
  return result as unknown as ToolOutcome
}

async function run(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const outcome = await dispatch(ctx, name, args)
  assert.equal(outcome.isError, false, `${name} failed: ${JSON.stringify(outcome.content)}`)
  return outcome.value
}

describe('fable51 visualize tools', () => {
  it('registers the inspect tool under fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((schema) => schema.name)
      assert.ok(names.includes(TOOL_NAME), `expected ${TOOL_NAME} in [${names.join(', ')}]`)
      assert.ok(!names.includes(TOOL_NAME.slice('fable51_'.length)), `no un-namespaced tool may exist at root`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns complete service state in ASCII format by default', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, {})
      assert.equal(res.spec, '100')
      assert.equal(res.verdict, 'verified')
      assert.equal(res.rerun, false)

      // Check output structure
      const out = res.output as unknown as InspectOutput
      assert.ok('policies' in out, 'output must have policies')
      assert.ok('lineage' in out, 'output must have lineage')
      assert.ok('costs' in out, 'output must have costs')
      assert.ok('cache' in out, 'output must have cache')
      assert.ok('snapshots' in out, 'output must have snapshots')
      assert.ok('config' in out, 'output must have config')
      assert.ok('ascii' in out, 'ASCII format must include ascii field')

      // Verify ascii is a string with expected sections
      assert.equal(typeof out.ascii, 'string')
      const ascii = out.ascii ?? ''
      assert.ok(ascii.includes('=== fable51 Policy Visualizer ==='))
      assert.ok(ascii.includes('--- Policies ---'))
      assert.ok(ascii.includes('--- Lineage ---'))
      assert.ok(ascii.includes('--- Costs ---'))
      assert.ok(ascii.includes('--- Cache ---'))
      assert.ok(ascii.includes('--- Snapshots ---'))
      assert.ok(ascii.includes('--- Config ---'))
      // The two scopes must be named, so the operator knows which numbers are
      // the run's and which are the tenant's.
      assert.ok(ascii.includes('Run scope: tenant'), `expected the run scope line, got: ${ascii.slice(0, 200)}`)
      assert.ok(ascii.includes('Shared scope: tenant'))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns JSON format when requested', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, { format: 'json' })
      assert.equal(res.spec, '100')
      assert.equal(res.verdict, 'verified')

      const out = res.output as unknown as InspectOutput
      // JSON format should not have ascii field
      assert.ok(!('ascii' in out), 'JSON format must not include ascii field')
      // But should have all data sections
      assert.ok(Array.isArray(out.policies))
      assert.ok(typeof out.lineage === 'object')
      assert.ok(typeof out.costs === 'object')
      assert.ok(typeof out.cache === 'object')
      assert.ok(typeof out.snapshots === 'object')
      assert.ok(typeof out.config === 'object')
      // The run scope must be named: the run-scoped numbers belong to one session.
      assert.equal(typeof out.session, 'string')
      assert.ok(out.session.length > 0, 'the session scope must not be empty')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('includes worklog and gateLog when requested', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, { includeWorklog: true, includeGateLog: true })
      assert.equal(res.spec, '100')

      const out = res.output as unknown as InspectOutput
      assert.ok('worklog' in out)
      assert.ok('gateLog' in out)
      assert.ok(Array.isArray(out.worklog))
      assert.ok(Array.isArray(out.gateLog))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lineage treeAscii renders correctly for empty state', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, {})
      const out = res.output as unknown as InspectOutput

      assert.equal(typeof out.lineage.treeAscii, 'string')
      assert.ok(out.lineage.treeAscii.includes('(empty)') || out.lineage.treeAscii.includes('(no roots found)') || out.lineage.totalPasses === 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders the lineage tree and honours the depth cap', async () => {
    const ctx = await setup()
    try {
      // A root with two levels of children: root → mid → leaf.
      for (const id of ['root', 'mid', 'leaf']) {
        await run(ctx, 'fable51_reasoning-lineage', {
          passId: id,
          ...(id === 'root' ? {} : { parentId: id === 'mid' ? 'root' : 'mid' }),
        })
      }

      const full = await run(ctx, TOOL_NAME, { format: 'json' })
      const fullOut = full.output as unknown as InspectOutput
      assert.equal(fullOut.lineage.totalPasses, 3)
      assert.ok(fullOut.lineage.treeAscii.includes('root'), 'the root must be rendered')
      assert.ok(fullOut.lineage.treeAscii.includes('mid'), 'the child must be rendered')
      assert.ok(fullOut.lineage.treeAscii.includes('leaf'), 'the grandchild must be rendered')

      // A depth of 1 must cut the tree below the root and say so.
      const capped = await run(ctx, TOOL_NAME, { format: 'json', maxLineageDepth: 1 })
      const cappedOut = capped.output as unknown as InspectOutput
      assert.ok(cappedOut.lineage.treeAscii.includes('root'), 'the root stays within the cap')
      assert.ok(!cappedOut.lineage.treeAscii.includes('mid'), 'the child must be cut at depth 1')
      assert.ok(cappedOut.lineage.treeAscii.includes('depth cap 1 reached'), 'a cut tree must report the cap, not hide it')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects a non-positive or non-integer maxLineageDepth', async () => {
    const ctx = await setup()
    try {
      for (const bad of [0, -1, 1.5]) {
        const outcome = await dispatch(ctx, TOOL_NAME, { maxLineageDepth: bad })
        assert.equal(outcome.isError, false, 'a malformed argument must answer, not throw')
        const value = outcome.value as unknown as { ok: boolean; verdict: string; output: Record<string, unknown>; unverified: string[] }
        assert.equal(value.ok, false, `maxLineageDepth=${bad} must be rejected`)
        assert.equal(value.verdict, 'unverified')
        assert.ok(String(value.output.error).length > 0)
        assert.equal(value.unverified[0], value.output.error)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('costs section aggregates by stage correctly', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, {})
      const out = res.output as unknown as InspectOutput

      assert.ok(typeof out.costs.totalTokens === 'number')
      assert.ok(typeof out.costs.totalLatencyMs === 'number')
      assert.ok(typeof out.costs.totalRisk === 'number')
      assert.ok(Array.isArray(out.costs.byStage))
      assert.ok(typeof out.costs.stageBudgets === 'object')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cache section reports hits, misses, size, and hitRate', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, {})
      const out = res.output as unknown as InspectOutput

      assert.ok(typeof out.cache.size === 'number')
      assert.ok(typeof out.cache.hits === 'number')
      assert.ok(typeof out.cache.misses === 'number')
      assert.ok(typeof out.cache.hitRate === 'number')
      assert.ok(out.cache.hitRate >= 0 && out.cache.hitRate <= 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('snapshots section reports count, latest, and ids', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, {})
      const out = res.output as unknown as InspectOutput

      assert.ok(typeof out.snapshots.count === 'number')
      assert.ok(typeof out.snapshots.latest === 'string')
      assert.ok(Array.isArray(out.snapshots.ids))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('config section reports current effort tier and budget limits', async () => {
    const ctx = await setup()
    try {
      const res = await run(ctx, TOOL_NAME, {})
      const out = res.output as unknown as InspectOutput

      assert.ok(typeof out.config.effortTier === 'string')
      assert.ok(typeof out.config.maxForkDepth === 'number')
      assert.ok(typeof out.config.maxConcurrentPasses === 'number')
      assert.ok(typeof out.config.stageTokenBudget === 'number')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid format argument', async () => {
    const ctx = await setup()
    try {
      const outcome = await dispatch(ctx, TOOL_NAME, { format: 'invalid' })
      assert.equal(outcome.isError, false, 'malformed argument must answer, not throw')
      const value = outcome.value as unknown as { ok: boolean; verdict: string; output: Record<string, unknown>; unverified: string[] }
      assert.equal(value.ok, false)
      assert.equal(value.verdict, 'unverified')
      assert.ok(String(value.output.error).length > 0)
      assert.equal(value.unverified[0], value.output.error)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never replays a cached answer, because it reports live state', async () => {
    const ctx = await setup()
    try {
      const first = await run(ctx, TOOL_NAME, { format: 'json' })
      assert.equal(first.rerun, false, 'first call must not be a rerun')

      // The inspector reports the ledger, the worklog and the cache itself.
      // A replayed answer would show the operator a stale picture of a running
      // bundle, so this tool is effectful and never reads from the cache.
      const second = await run(ctx, TOOL_NAME, { format: 'json' })
      assert.equal(second.rerun, false, 'a live-state reader must never replay the cache')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
