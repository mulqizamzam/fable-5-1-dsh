/**
 * Reasoning-ops tools — specs 73, 74, 75, 76, 77, 78, 79, 80, 82, 83, 84, 85,
 * 86, 87, 88, 89, 90 (PRD §4.7/§4.8/§4.9, Gates 4g–4n).
 *
 * The flow-control and operations half of the reasoning group: quorum,
 * diversity injection, decay weighting, prioritization context, snapshot
 * diffing, federation merge, per-pass observability, budget pooling,
 * quarantine, checkpoint strategy, lane routing, cancellation, affinity,
 * lineage prune, deadline propagation, quality scoring, and warmup.
 */
import type { ToolSpec } from './shared.ts'
import { fingerprint } from '../state/cache.ts'

type Lane = 'fast' | 'slow' | 'verify'
type CheckpointMode = 'turn' | 'bulk' | 'long'
type PriorityContext = 'risk' | 'uncertainty' | 'cost'

interface PassInput {
  readonly id: string
  readonly risk?: number
  readonly uncertainty?: number
  readonly cost?: number
}

interface WorkerOutput {
  readonly id: string
  readonly output: unknown
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('arguments must be an object')
  return args as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function requireNumber(args: Record<string, unknown>, key: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  if (value < min || value > max) throw new Error(`${key} must be within [${min}, ${max}]`)
  return value
}

function requireArray(args: Record<string, unknown>, key: string): unknown[] {
  const value = args[key]
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`)
  return value
}

function requireEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = args[key]
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${key} must be one of ${allowed.join('|')}`)
  return value as T
}

const stringArray = { type: 'array', items: { type: 'string' } }

export function reasoningOpsTools(): ToolSpec[] {
  return [
    {
      spec: '73',
      name: 'reasoning-quorum',
      description: 'Commit only when agreement meets the quorum threshold (spec 73).',
      parameters: {
        type: 'object',
        required: ['agree', 'total'],
        properties: { agree: { type: 'number' }, total: { type: 'number' }, threshold: { type: 'number' } },
      },
      outputSchema: {
        type: 'object',
        required: ['quorum', 'ratio', 'threshold'],
        properties: { quorum: { type: 'boolean' }, ratio: { type: 'number' }, threshold: { type: 'number' } },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const agree = requireNumber(record, 'agree')
        const total = requireNumber(record, 'total')
        if (total <= 0) throw new Error('total must be positive')
        const threshold = record.threshold === undefined ? service.config.reasoning.quorumThreshold : requireNumber(record, 'threshold', 0, 1)
        const ratio = agree / total
        return { quorum: ratio >= threshold, ratio, threshold }
      },
    },
    {
      spec: '74',
      name: 'diversity-injection',
      description: 'Derive a deterministic variant seed per pass to avoid echo chambers (spec 74).',
      parameters: { type: 'object', required: ['passId'], properties: { passId: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['variantSeed'], properties: { variantSeed: { type: 'number' } } },
      execute(args, { service }) {
        const record = asRecord(args)
        const passId = requireString(record, 'passId')
        const offset = parseInt(fingerprint(passId).slice(7, 15), 16) % 1000
        return { variantSeed: service.seed() + offset }
      },
    },
    {
      spec: '75',
      name: 'reasoning-decay',
      description: 'Decay a pass weight by age: w ∝ exp(−λ·age) (spec 75).',
      parameters: { type: 'object', required: ['ageMs'], properties: { ageMs: { type: 'number' } } },
      outputSchema: { type: 'object', required: ['weight', 'lambda'], properties: { weight: { type: 'number' }, lambda: { type: 'number' } } },
      execute(args, { service }) {
        const record = asRecord(args)
        const ageMs = requireNumber(record, 'ageMs')
        return { weight: service.decayWeight(ageMs), lambda: service.config.reasoning.decayLambda }
      },
    },
    {
      spec: '76',
      name: 'pass-prioritization',
      description: 'Order passes by the declared context: risk-first, uncertainty-first, or cost-first (spec 76).',
      parameters: {
        type: 'object',
        required: ['context', 'passes'],
        properties: {
          context: { type: 'string', enum: ['risk', 'uncertainty', 'cost'] },
          passes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, risk: { type: 'number' }, uncertainty: { type: 'number' }, cost: { type: 'number' } },
            },
          },
        },
      },
      outputSchema: { type: 'object', required: ['order'], properties: { order: stringArray } },
      execute(args) {
        const record = asRecord(args)
        const context = requireEnum(record, 'context', ['risk', 'uncertainty', 'cost'] as const)
        const passes = requireArray(record, 'passes') as unknown as PassInput[]
        const ordered = passes
          .map((pass, index) => ({ pass, index }))
          .sort((a, b) => (b.pass[context] ?? 0) - (a.pass[context] ?? 0) || a.pass.id.localeCompare(b.pass.id) || a.index - b.index)
        return { order: ordered.map((entry) => entry.pass.id) }
      },
    },
    {
      spec: '77',
      effectful: true,
      name: 'reasoning-snapshot-diff',
      description: 'Create both snapshots and diff them for drift or regression (spec 77).',
      parameters: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'object', required: ['id', 'data'], properties: { id: { type: 'string' }, data: { type: 'object' } } },
          to: { type: 'object', required: ['id', 'data'], properties: { id: { type: 'string' }, data: { type: 'object' } } },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['added', 'removed', 'changed'],
        properties: { added: stringArray, removed: stringArray, changed: stringArray },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const from = record.from as Record<string, unknown> | undefined
        const to = record.to as Record<string, unknown> | undefined
        if (typeof from !== 'object' || from === null || typeof to !== 'object' || to === null) throw new Error('from and to must be objects')
        const fromData = from.data
        const toData = to.data
        if (typeof fromData !== 'object' || fromData === null || typeof toData !== 'object' || toData === null) throw new Error('from.data and to.data must be objects')
        service.snapshots.create(requireString(from, 'id'), fromData as Record<string, unknown>)
        service.snapshots.create(requireString(to, 'id'), toData as Record<string, unknown>)
        return service.snapshots.diff(requireString(from, 'id'), requireString(to, 'id'))
      },
    },
    {
      spec: '78',
      name: 'reasoning-federation',
      description: 'Merge federated worker outputs under the union contract (spec 78).',
      parameters: {
        type: 'object',
        required: ['workers'],
        properties: {
          workers: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'output'],
              properties: { id: { type: 'string' }, output: { type: 'object' } },
            },
          },
        },
      },
      outputSchema: { type: 'object', required: ['merged', 'workerCount'], properties: { merged: { type: 'object' }, workerCount: { type: 'number' } } },
      execute(args) {
        const record = asRecord(args)
        const workers = requireArray(record, 'workers') as unknown as WorkerOutput[]
        // A null prototype keeps a worker-supplied `__proto__` an ordinary own key
        // instead of an Object.assign that silently repoints the union's prototype.
        const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        for (const worker of workers.slice().sort((a, b) => a.id.localeCompare(b.id))) {
          const output = worker.output
          if (typeof output !== 'object' || output === null) throw new Error(`worker ${worker.id} output must be an object`)
          Object.assign(merged, output)
        }
        return { merged, workerCount: workers.length }
      },
    },
    {
      spec: '79',
      effectful: true,
      name: 'pass-observability',
      description: 'Emit the one-line per-pass trace record (spec 79).',
      parameters: {
        type: 'object',
        required: ['passId', 'tokens', 'verdict'],
        properties: { passId: { type: 'string' }, tokens: { type: 'number' }, verdict: { type: 'string', enum: ['contributed', 'neutral', 'discarded'] } },
      },
      outputSchema: { type: 'object', required: ['traceId'], properties: { traceId: { type: 'string' } } },
      execute(args, { service }) {
        const record = asRecord(args)
        const passId = requireString(record, 'passId')
        const tokens = requireNumber(record, 'tokens')
        const verdict = requireEnum(record, 'verdict', ['contributed', 'neutral', 'discarded'] as const)
        const traceId = fingerprint({ passId, tokens, verdict })
        service.recordWorklog({
          stage: `pass:${passId}`,
          output: `trace ${traceId} tokens=${tokens} verdict=${verdict}`,
          check: 'pass observability',
          verdict,
          unverified: [],
          at: Date.now(),
        })
        return { traceId }
      },
    },
    {
      spec: '80',
      name: 'reasoning-budget-pool',
      description: 'Grant from the shared budget pool with a per-pass cap so no pass monopolizes (spec 80).',
      parameters: {
        type: 'object',
        required: ['pool', 'requested', 'activePasses'],
        properties: { pool: { type: 'number' }, requested: { type: 'number' }, activePasses: { type: 'number' } },
      },
      outputSchema: { type: 'object', required: ['granted', 'perPassCap'], properties: { granted: { type: 'number' }, perPassCap: { type: 'number' } } },
      execute(args) {
        const record = asRecord(args)
        const pool = requireNumber(record, 'pool')
        const requested = requireNumber(record, 'requested')
        const active = requireNumber(record, 'activePasses')
        const perPassCap = Math.floor(pool / Math.max(1, active))
        return { granted: Math.min(requested, perPassCap), perPassCap }
      },
    },
    {
      spec: '82',
      name: 'reasoning-quarantine',
      description: 'Quarantine a suspect pass before it can enter a merge (spec 82).',
      parameters: { type: 'object', required: ['passId', 'suspect'], properties: { passId: { type: 'string' }, suspect: { type: 'boolean' } } },
      outputSchema: { type: 'object', required: ['quarantined', 'passId'], properties: { quarantined: { type: 'boolean' }, passId: { type: 'string' } } },
      execute(args) {
        const record = asRecord(args)
        const suspect = record.suspect
        if (typeof suspect !== 'boolean') throw new Error('suspect must be a boolean')
        return { quarantined: suspect, passId: requireString(record, 'passId') }
      },
    },
    {
      spec: '83',
      name: 'pass-checkpoint-strategy',
      description: 'Declare the checkpoint interval for the pass mode: turn, N-token bulk, or milestone (spec 83).',
      parameters: { type: 'object', required: ['mode'], properties: { mode: { type: 'string', enum: ['turn', 'bulk', 'long'] } } },
      outputSchema: { type: 'object', required: ['mode', 'interval'], properties: { mode: { type: 'string' }, interval: {} } },
      execute(args) {
        const record = asRecord(args)
        const mode = requireEnum(record, 'mode', ['turn', 'bulk', 'long'] as const)
        const interval: CheckpointMode extends never ? never : number | string = mode === 'turn' ? 1 : mode === 'bulk' ? 50000 : 'milestone'
        return { mode, interval }
      },
    },
    {
      spec: '84',
      name: 'reasoning-lane',
      description: 'Route a pass to the fast, slow, or verify lane by complexity (spec 84).',
      parameters: { type: 'object', required: ['complexity'], properties: { complexity: { type: 'number' } } },
      outputSchema: { type: 'object', required: ['lane'], properties: { lane: { type: 'string', enum: ['fast', 'slow', 'verify'] } } },
      execute(args) {
        const record = asRecord(args)
        const complexity = requireNumber(record, 'complexity', 0, 1)
        const lane: Lane = complexity < 0.33 ? 'fast' : complexity > 0.66 ? 'verify' : 'slow'
        return { lane }
      },
    },
    {
      spec: '85',
      name: 'pass-cancellation',
      description: 'Cancel a pass and its descendants when its premise is invalidated (spec 85).',
      parameters: {
        type: 'object',
        required: ['premiseInvalidated', 'passId', 'descendants'],
        properties: { premiseInvalidated: { type: 'boolean' }, passId: { type: 'string' }, descendants: stringArray },
      },
      outputSchema: { type: 'object', required: ['cancelled'], properties: { cancelled: stringArray } },
      execute(args) {
        const record = asRecord(args)
        const invalidated = record.premiseInvalidated
        if (typeof invalidated !== 'boolean') throw new Error('premiseInvalidated must be a boolean')
        const passId = requireString(record, 'passId')
        const descendants = requireArray(record, 'descendants') as string[]
        return { cancelled: invalidated ? [passId, ...descendants] : [] }
      },
    },
    {
      spec: '86',
      name: 'reasoning-affinity',
      description: 'Route similar passes to the same worker by content fingerprint (spec 86).',
      parameters: { type: 'object', required: ['passA', 'passB'], properties: { passA: {}, passB: {} } },
      outputSchema: { type: 'object', required: ['sameWorker'], properties: { sameWorker: { type: 'boolean' } } },
      execute(args) {
        const record = asRecord(args)
        if (!('passA' in record) || !('passB' in record)) throw new Error('passA and passB are required')
        return { sameWorker: fingerprint(record.passA) === fingerprint(record.passB) }
      },
    },
    {
      spec: '87',
      effectful: true,
      name: 'pass-lineage-prune',
      description: 'Prune unreferenced ancestry, keeping live passes and audit-protected ids (spec 87).',
      parameters: { type: 'object', required: ['liveIds'], properties: { liveIds: stringArray } },
      outputSchema: { type: 'object', required: ['dropped'], properties: { dropped: stringArray } },
      execute(args, { service }) {
        const record = asRecord(args)
        const liveIds = requireArray(record, 'liveIds') as string[]
        return { dropped: service.lineage.prune(liveIds) }
      },
    },
    {
      spec: '88',
      name: 'reasoning-deadline-propagation',
      description: 'A child deadline is the minimum of the parent deadline and its own (spec 88).',
      parameters: {
        type: 'object',
        required: ['parentDeadline', 'ownDeadline'],
        properties: {
          parentDeadline: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          ownDeadline: { oneOf: [{ type: 'number' }, { type: 'null' }] },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['deadline'],
        properties: { deadline: { oneOf: [{ type: 'number' }, { type: 'null' }] } },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const parent = deadlineOrNull(record.parentDeadline, 'parentDeadline')
        const own = deadlineOrNull(record.ownDeadline, 'ownDeadline')
        return { deadline: service.childDeadline(parent, own) }
      },
    },
    {
      spec: '89',
      name: 'pass-quality-score',
      description: 'Weighted pass quality: w1·evidence + w2·coherence + w3·coverage − w4·contradiction (spec 89).',
      parameters: {
        type: 'object',
        required: ['evidence', 'coherence', 'coverage', 'contradiction'],
        properties: {
          evidence: { type: 'number' },
          coherence: { type: 'number' },
          coverage: { type: 'number' },
          contradiction: { type: 'number' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['evidence', 'coherence', 'coverage', 'contradiction', 'weighted'],
        properties: {
          evidence: { type: 'number' },
          coherence: { type: 'number' },
          coverage: { type: 'number' },
          contradiction: { type: 'number' },
          weighted: { type: 'number' },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const evidence = requireNumber(record, 'evidence', -1e9, 1e9)
        const coherence = requireNumber(record, 'coherence', -1e9, 1e9)
        const coverage = requireNumber(record, 'coverage', -1e9, 1e9)
        const contradiction = requireNumber(record, 'contradiction', -1e9, 1e9)
        return service.score({ evidence, coherence, coverage, contradiction })
      },
    },
    {
      spec: '90',
      name: 'reasoning-warmup',
      description: 'Short calibration pass before a large pass (spec 90).',
      parameters: { type: 'object', required: ['passId'], properties: { passId: { type: 'string' } } },
      outputSchema: { type: 'object', required: ['warmupMs', 'calibrated'], properties: { warmupMs: { type: 'number' }, calibrated: { type: 'boolean' } } },
      execute(args) {
        const record = asRecord(args)
        requireString(record, 'passId')
        return { warmupMs: 250, calibrated: true }
      },
    },
  ]
}

function deadlineOrNull(value: unknown, key: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number or null`)
  return value
}

export type { CheckpointMode, Lane, PriorityContext }
