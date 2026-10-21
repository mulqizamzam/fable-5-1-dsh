/**
 * Sweep every registered tool once, in a real host.
 *
 * The registry, the hooks and the dsh services are the real ones, so a tool
 * that misbehaves here misbehaves in production. Each tool gets one call
 * with arguments derived from its own declared schema, and the tool must
 * accept them: a tool that refuses the arguments its own schema promises is
 * broken.
 *
 * This is the sweep that found the two live-state readers serving stale
 * cached answers, and it is here to catch the next one.
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

type Json = Record<string, unknown>

/** Minimal valid value for one schema property. */
function valueFor(prop: Json | undefined): unknown {
  if (prop === undefined) return 'x'
  const enumValues = prop.enum
  if (Array.isArray(enumValues) && enumValues.length > 0) return enumValues[0]
  const type = prop.type
  if (type === 'number' || type === 'integer') return 1
  if (type === 'boolean') return false
  if (type === 'array') return [valueFor(prop.items as Json | undefined)]
  if (type === 'object') return minimalArgs(prop)
  return 'x'
}

/** Minimal valid arguments for a tool schema. */
function minimalArgs(schema: Json): Json {
  const out: Json = {}
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const properties = (schema.properties ?? {}) as Json
  for (const key of required) {
    out[key] = valueFor(properties[key] as Json | undefined)
  }
  return out
}

/**
 * Arguments for the tools whose schema cannot be satisfied by a generic
 * value: tuple arrays, nested objects, and the ones that check their own
 * argument shape.
 */
const OVERRIDES: Record<string, Json> = {
  'sandbox-boundaries': { operation: 'read', path: '/tmp/fable51-sweep.txt' },
  'verification-gates': { check: 'sweep', cmd: 'true', expected: 'PASS', actual: 'PASS' },
  'context-management': { fillRatio: 0.5 },
  'token-budget-per-stage': { stage: 'sweep', tokens: 10 },
  'interleaved-budget': { requested: 10 },
  'reasoning-forking': { candidateCount: 2, budgetLeft: 1 },
  'hypothesis-pruning': { hypotheses: [{ id: 'a', score: 1 }], k: 1 },
  'reasoning-topology': { taskShape: 'fan-out' },
  'reasoning-lineage': { passId: 'sweep-pass' },
  'stage-graph-dag': { nodes: ['a', 'b'], edges: [['a', 'b']] },
  'reasoning-dag': { passId: 'sweep-dag', deps: [] },
  'artifact-contracts': { path: 'p', shape: 's', schema: '{}', data: { x: 1 } },
  'verifier-forking': { spec: 's', producerOutput: 'o' },
  'cold-verifier-isolation': { spec: 's', artifact: 'a' },
  'anti-introspection': { claim: 'verified', artifact: 'a', command: 'cmd', output: 'o' },
  'research-provenance': { claim: 'c', tag: { kind: 'inf' } },
  'chain-of-verification': { layers: ['layer-1', 'layer-2'] },
  'partial-delivery': { finalVerified: true, unverified: [] },
  'worklog-format': { stage: 's', output: 'o', check: 'c', verdict: 'neutral', unverified: [] },
  'reasoning-trace-format': { id: 'p', input: 1, output: 2, deps: [], verdict: 'neutral' },
  'pass-cost-accounting': { passId: 'p', tokens: 10, latencyMs: 1, retries: 0, verifierMs: 0 },
  'deadlock-detection': { waits: [['a', 'b']] },
  'pass-dependency-inference': { declaredEdges: [['a', 'b']], sharedFacts: [['fact', 'value']] },
  'reasoning-audit': { weighted: 1, evidence: 1, coherence: 1, coverage: 1, contradiction: 0 },
  'reasoning-deadline-propagation': { parentDeadline: null, ownDeadline: null },
  'budget-advisor': { taskClass: 'bounded' },
  'inspect': { format: 'json' },
}

interface SweepResult {
  name: string
  hostError: boolean
  rejected: boolean
  verdict: string
  detail: string
}

async function sweep(ctx: Context): Promise<SweepResult[]> {
  const results: SweepResult[] = []
  for (const spec of allToolSpecs()) {
    const toolName = `fable51_${spec.name}`
    const args = OVERRIDES[spec.name] ?? minimalArgs(spec.parameters as Json)
    let hostError = false
    let rejected = false
    let verdict = 'unknown'
    let detail = ''
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`sweep-${spec.name}`),
        name: toolName,
        arguments: args,
      })
      if (result.isError) {
        hostError = true
        detail = JSON.stringify(result.content).slice(0, 200)
      } else {
        const envelope = result.value as unknown as {
          ok?: boolean
          verdict?: string
          output?: unknown
          unverified?: string[]
        }
        verdict = String(envelope.verdict)
        if (envelope.ok === false) {
          rejected = true
          detail = String((envelope.output as { error?: string } | undefined)?.error ?? '').slice(0, 200)
        } else if (verdict === 'unverified') {
          detail = (envelope.unverified ?? []).join('; ').slice(0, 200)
        }
      }
    } catch (error) {
      hostError = true
      detail = String(error).slice(0, 200)
    }
    results.push({ name: spec.name, hostError, rejected, verdict, detail })
  }
  return results
}

describe('tool sweep in a real host', () => {
  it('every tool accepts the arguments its own schema promises', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(Fable51Policy)

      const results = await sweep(ctx)
      assert.equal(results.length, allToolSpecs().length, 'every registered tool must be swept')

      const hostErrors = results.filter((r) => r.hostError)
      const rejections = results.filter((r) => r.rejected)
      assert.deepEqual(
        hostErrors.map((r) => `${r.name}: ${r.detail}`),
        [],
        'no tool may fail at the host level',
      )
      assert.deepEqual(
        rejections.map((r) => `${r.name}: ${r.detail}`),
        [],
        'no tool may refuse arguments its own schema declares',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('every tool answers with a verdict the envelope allows', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(Fable51Policy)

      for (const result of await sweep(ctx)) {
        assert.ok(
          result.verdict === 'verified' || result.verdict === 'unverified',
          `${result.name} returned verdict ${result.verdict}, which is not one the envelope allows`,
        )
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
