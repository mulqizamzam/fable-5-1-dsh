/**
 * Arguments for a tool, derived from the tool's own declared schema.
 *
 * A generic generator can produce a well-typed but meaningless argument, so
 * the tools that check their own argument shape are listed explicitly rather
 * than hidden behind a fudge. A generator that quietly sent the wrong thing
 * would make a sweep prove nothing.
 *
 * This lives in `src/` and not in the test folder because the sweep is a
 * shipped command: `fable51 sweep` calls every tool in a real host, and it
 * needs arguments the tools accept.
 */
import { allToolSpecs } from './index.ts'

type Json = Record<string, unknown>

/** Minimal valid value for one schema property. */
export function valueFor(prop: Json | undefined): unknown {
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
export function minimalArgs(schema: Json): Json {
  const out: Json = {}
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
  const properties = (schema.properties ?? {}) as Json
  for (const key of required) {
    out[key] = valueFor(properties[key] as Json | undefined)
  }
  return out
}

/**
 * The pass ids one sweep run records.
 *
 * The pruning tools take a keep-set of pass ids that are still referenced.
 * A generic value matches no real pass, so the prune would drop everything
 * the sweep had recorded, and the sweep would then measure an empty lineage
 * it had emptied itself. Naming the sweep's own passes keeps them alive.
 *
 * The suffix keeps a second run in the same host from colliding with the
 * passes the first one recorded: the lineage is append-only, so the same id
 * would be refused with "already recorded".
 */
export function sweepPassIds(suffix = ''): string[] {
  return [`sweep-dag${suffix}`, `sweep-pass${suffix}`]
}

/**
 * Arguments for the tools whose schema cannot be satisfied by a generic
 * value: tuple arrays, nested objects, and the ones that check their own
 * argument shape.
 */
export const OVERRIDES: Record<string, Json> = {
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

/**
 * The arguments one call of this tool should use.
 *
 * The suffix identifies one sweep run. It reaches the two tools that record
 * a pass and the two that prune passes, because those four share one set of
 * pass ids and must not collide with an earlier run in the same host.
 */
export function argsFor(name: string, suffix = ''): Json {
  const spec = allToolSpecs().find((candidate) => candidate.name === name)
  if (spec === undefined) throw new Error(`no such tool: ${name}`)
  if (name === 'reasoning-dag') return { passId: `sweep-dag${suffix}`, deps: [] }
  if (name === 'reasoning-lineage') return { passId: `sweep-pass${suffix}` }
  if (name === 'pass-lineage-prune') return { liveIds: sweepPassIds(suffix) }
  if (name === 'reasoning-garbage-collection') return { liveIds: sweepPassIds(suffix), keepLastN: 2 }
  return OVERRIDES[name] ?? minimalArgs(spec.parameters as Json)
}
