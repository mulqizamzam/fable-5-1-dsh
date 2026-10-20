/**
 * Reasoning-flow tools — specs 51, 53, 54, 56, 57, 59, 61–69, 71
 * (PRD §4.5/§4.6, Gates 4g–4n).
 *
 * The scheduling and topology half of the reasoning group: priority order,
 * dedup fingerprints, hypothesis scoring, failure isolation, replay hash
 * comparison, audit classification, topology selection, adaptive branching,
 * contribution heatmaps, cross-pass drift, canonical fingerprints, pass
 * scheduling, bounded windows, merge-conflict escalation, lineage recording,
 * and backpressure. All deterministic; only spec-owned state is touched.
 */
import type { ToolSpec } from './shared.ts'
import { fingerprint } from '../state/cache.ts'
import type { PassVerdict } from '../types/pass.ts'

type TaskKind = 'verify' | 'critical' | 'explore'
type Topology = 'star' | 'chain' | 'mesh' | 'ring'
type ScheduleOrder = 'FIFO' | 'priority' | 'SJF'

interface Task {
  readonly id: string
  readonly kind: TaskKind
}

interface PassRef {
  readonly id: string
  readonly priority?: number
  readonly size?: number
}

interface FactGroup {
  readonly fact: string
  readonly values: readonly string[]
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

export function reasoningFlowTools(): ToolSpec[] {
  return [
    {
      spec: '51',
      name: 'reasoning-priority',
      description: 'Order reasoning passes by precedence verify > critical-path > explore, stable within a kind (spec 51).',
      parameters: {
        type: 'object',
        required: ['tasks'],
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'kind'],
              properties: { id: { type: 'string' }, kind: { type: 'string', enum: ['verify', 'critical', 'explore'] } },
            },
          },
        },
      },
      outputSchema: { type: 'object', required: ['order'], properties: { order: stringArray } },
      execute(args) {
        const record = asRecord(args)
        const rank: Record<TaskKind, number> = { verify: 0, critical: 1, explore: 2 }
        const items = requireArray(record, 'tasks') as unknown as Task[]
        const ordered = items
          .map((task, index) => ({ task, index }))
          .sort((a, b) => rank[a.task.kind] - rank[b.task.kind] || a.task.id.localeCompare(b.task.id) || a.index - b.index)
        return { order: ordered.map((entry) => entry.task.id) }
      },
    },
    {
      spec: '53',
      name: 'reasoning-dedup',
      description: 'Deduplicate reasoning content by canonical fingerprint (spec 53).',
      parameters: { type: 'object', required: ['items'], properties: { items: stringArray } },
      outputSchema: { type: 'object', required: ['unique', 'duplicates'], properties: { unique: stringArray, duplicates: stringArray } },
      execute(args) {
        const record = asRecord(args)
        const seen = new Set<string>()
        const unique: string[] = []
        const duplicates: string[] = []
        const items = requireArray(record, 'items')
        // A non-string item reached the envelope and the host rejected the whole
        // call: a malformed argument is a tool-level answer, never a host throw.
        if (items.some((item: unknown) => typeof item !== 'string')) throw new Error('items must be an array of strings')
        for (const item of items as string[]) {
          if (seen.has(item)) duplicates.push(item)
          else { seen.add(item); unique.push(item) }
        }
        return { unique, duplicates }
      },
    },
    {
      spec: '54',
      name: 'hypothesis-scoring',
      description: 'Score a hypothesis before pruning: w1·evidence − w2·contradiction + w3·coverage (spec 54).',
      parameters: {
        type: 'object',
        required: ['evidence', 'contradiction', 'coverage'],
        properties: {
          evidence: { type: 'number' },
          contradiction: { type: 'number' },
          coverage: { type: 'number' },
          weights: { type: 'array', items: { type: 'number' } },
        },
      },
      outputSchema: { type: 'object', required: ['score'], properties: { score: { type: 'number' } } },
      execute(args) {
        const record = asRecord(args)
        const evidence = requireNumber(record, 'evidence')
        const contradiction = requireNumber(record, 'contradiction')
        const coverage = requireNumber(record, 'coverage')
        const weights = record.weights === undefined ? [1, 1, 1] : (requireArray(record, 'weights') as number[])
        // A non-numeric weight makes every product NaN, and the declared score is a number.
        for (const [index, weight] of weights.entries()) {
          if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new Error(`weights[${index}] must be a finite number`)
        }
        const [w1 = 1, w2 = 1, w3 = 1] = weights
        return { score: w1 * evidence - w2 * contradiction + w3 * coverage }
      },
    },
    {
      spec: '56',
      name: 'failure-isolation',
      description: 'A failed pass never fails the pipeline; it is isolated (spec 56).',
      parameters: { type: 'object', required: ['failedPass', 'pipelineSize'], properties: { failedPass: { type: 'string' }, pipelineSize: { type: 'number' } } },
      outputSchema: { type: 'object', required: ['pipelineFailed', 'isolated'], properties: { pipelineFailed: { type: 'boolean' }, isolated: { type: 'string' } } },
      execute(args) {
        const record = asRecord(args)
        return { pipelineFailed: false, isolated: requireString(record, 'failedPass') }
      },
    },
    {
      spec: '57',
      name: 'reasoning-replay',
      description: 'Replay a pass from its trace and compare the output hash (spec 57).',
      parameters: { type: 'object', required: ['traceHash', 'actual'], properties: { traceHash: { type: 'string' }, actual: {} } },
      outputSchema: { type: 'object', required: ['match', 'actualHash'], properties: { match: { type: 'boolean' }, actualHash: { type: 'string' } } },
      execute(args) {
        const record = asRecord(args)
        // Without this guard a missing `actual` fingerprints as null, so a
        // traceHash of null "matches" an artifact nobody produced.
        if (!Object.hasOwn(record, 'actual')) throw new Error('actual is required')
        const actualHash = fingerprint(record.actual)
        return { match: actualHash === requireString(record, 'traceHash'), actualHash }
      },
    },
    {
      spec: '59',
      name: 'reasoning-audit',
      description: 'Classify a pass as contributed, neutral, or discarded from its weighted score (spec 59).',
      parameters: {
        type: 'object',
        properties: {
          weighted: { type: 'number' },
          evidence: { type: 'number' },
          coherence: { type: 'number' },
          coverage: { type: 'number' },
          contradiction: { type: 'number' },
        },
      },
      outputSchema: { type: 'object', required: ['verdict', 'weighted'], properties: { verdict: { type: 'string', enum: ['contributed', 'neutral', 'discarded'] }, weighted: { type: 'number' } } },
      execute(args, { service }) {
        const record = asRecord(args)
        let weighted: number
        if (typeof record.weighted === 'number') {
          // `typeof NaN === 'number'`, so only a finiteness check keeps NaN out of
          // the declared number field; a NaN weight would also fall through to 'discarded'.
          if (!Number.isFinite(record.weighted)) throw new Error('weighted must be a finite number')
          weighted = record.weighted
        } else {
          const score = service.score({
            evidence: requireNumber(record, 'evidence', -1e9, 1e9),
            coherence: requireNumber(record, 'coherence', -1e9, 1e9),
            coverage: requireNumber(record, 'coverage', -1e9, 1e9),
            contradiction: requireNumber(record, 'contradiction', -1e9, 1e9),
          })
          weighted = score.weighted
        }
        const verdict: PassVerdict = weighted > 0 ? 'contributed' : weighted === 0 ? 'neutral' : 'discarded'
        return { verdict, weighted }
      },
    },
    {
      spec: '61',
      name: 'reasoning-topology',
      description: 'Select the reasoning topology from the task shape: fan-out→star, linear→chain, all-to-all→mesh, cyclic→ring (spec 61).',
      parameters: { type: 'object', required: ['taskShape'], properties: { taskShape: { type: 'string', enum: ['fan-out', 'linear', 'all-to-all', 'cyclic'] } } },
      outputSchema: { type: 'object', required: ['topology'], properties: { topology: { type: 'string', enum: ['star', 'chain', 'mesh', 'ring'] } } },
      execute(args) {
        const record = asRecord(args)
        const shape = requireEnum(record, 'taskShape', ['fan-out', 'linear', 'all-to-all', 'cyclic'] as const)
        const topology: Topology = shape === 'fan-out' ? 'star' : shape === 'linear' ? 'chain' : shape === 'all-to-all' ? 'mesh' : 'ring'
        return { topology }
      },
    },
    {
      spec: '62',
      name: 'adaptive-branching',
      description: 'Branch count adapts to the ambiguity score against the fork-depth budget (spec 62).',
      parameters: { type: 'object', required: ['ambiguity'], properties: { ambiguity: { type: 'number' } } },
      outputSchema: { type: 'object', required: ['branches', 'maxForkDepth'], properties: { branches: { type: 'number' }, maxForkDepth: { type: 'number' } } },
      execute(args, { service }) {
        const record = asRecord(args)
        const ambiguity = requireNumber(record, 'ambiguity', 0, 1)
        const max = service.config.budget.maxForkDepth
        return { branches: Math.ceil(ambiguity * max), maxForkDepth: max }
      },
    },
    {
      spec: '63',
      name: 'reasoning-heatmap',
      description: 'Map pass token spend against contribution and flag waste (spec 63).',
      parameters: {
        type: 'object',
        required: ['passes'],
        properties: {
          passes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'tokens', 'contribution'],
              properties: { id: { type: 'string' }, tokens: { type: 'number' }, contribution: { type: 'number' } },
            },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['ranked', 'waste'],
        properties: {
          ranked: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, tokens: { type: 'number' }, contribution: { type: 'number' }, waste: { type: 'boolean' } } } },
          waste: stringArray,
        },
      },
      execute(args) {
        const record = asRecord(args)
        const passes = requireArray(record, 'passes').map((entry, index) => {
          const pass = entry as Record<string, unknown>
          // tokens and contribution are echoed into the ranked schema as numbers and feed the median.
          for (const key of ['tokens', 'contribution']) {
            if (typeof pass[key] !== 'number' || !Number.isFinite(pass[key])) {
              throw new Error(`passes[${index}].${key} must be a finite number`)
            }
          }
          return pass as unknown as { id: string; tokens: number; contribution: number }
        })
        const tokenMedian = median(passes.map((p) => p.tokens))
        const contributionMedian = median(passes.map((p) => p.contribution))
        const ranked = passes
          .map((p) => ({ ...p, waste: p.tokens > tokenMedian && p.contribution < contributionMedian }))
          .sort((a, b) => b.contribution - a.contribution || a.id.localeCompare(b.id))
        return { ranked, waste: ranked.filter((p) => p.waste).map((p) => p.id) }
      },
    },
    {
      spec: '64',
      name: 'cross-pass-consistency',
      description: 'Flag shared-fact drift across parallel passes before merge (spec 64).',
      parameters: {
        type: 'object',
        required: ['facts'],
        properties: {
          facts: {
            type: 'array',
            items: {
              type: 'object',
              required: ['fact', 'values'],
              properties: { fact: { type: 'string' }, values: stringArray },
            },
          },
        },
      },
      outputSchema: { type: 'object', required: ['drifts'], properties: { drifts: stringArray } },
      execute(args) {
        const record = asRecord(args)
        const groups = requireArray(record, 'facts') as unknown as FactGroup[]
        // A fact whose values were never supplied has not been compared, so it
        // must not read as agreeing.
        for (const group of groups) {
          if (typeof group?.fact !== 'string' || group.fact.length === 0 || !Array.isArray(group.values)
            || group.values.some((value: unknown) => typeof value !== 'string')) {
            throw new Error('each fact requires a non-empty fact and an array of string values')
          }
        }
        return { drifts: groups.filter((group) => new Set(group.values).size > 1).map((group) => group.fact).sort() }
      },
    },
    {
      spec: '65',
      name: 'reasoning-fingerprint',
      description: 'Canonical content fingerprint used for dedup and cache hits (spec 65).',
      parameters: { type: 'object', required: ['content'], properties: { content: {} } },
      outputSchema: { type: 'object', required: ['fingerprint'], properties: { fingerprint: { type: 'string' } } },
      execute(args) {
        const record = asRecord(args)
        if (!('content' in record)) throw new Error('content is required')
        return { fingerprint: fingerprint(record.content) }
      },
    },
    {
      spec: '66',
      name: 'pass-scheduling',
      description: 'Schedule passes by the declared policy: FIFO, priority (desc), or SJF (spec 66).',
      parameters: {
        type: 'object',
        required: ['order', 'passes'],
        properties: {
          order: { type: 'string', enum: ['FIFO', 'priority', 'SJF'] },
          passes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id'],
              properties: { id: { type: 'string' }, priority: { type: 'number' }, size: { type: 'number' } },
            },
          },
        },
      },
      outputSchema: { type: 'object', required: ['order', 'scheduled'], properties: { order: { type: 'string' }, scheduled: stringArray } },
      execute(args) {
        const record = asRecord(args)
        const order = requireEnum(record, 'order', ['FIFO', 'priority', 'SJF'] as const)
        const passes = requireArray(record, 'passes') as unknown as PassRef[]
        const withIndex = passes.map((pass, index) => ({ pass, index }))
        const sorted = withIndex.slice().sort((a, b) => {
          if (order === 'priority') return (b.pass.priority ?? 0) - (a.pass.priority ?? 0) || a.pass.id.localeCompare(b.pass.id) || a.index - b.index
          if (order === 'SJF') return (a.pass.size ?? 0) - (b.pass.size ?? 0) || a.pass.id.localeCompare(b.pass.id) || a.index - b.index
          return a.index - b.index
        })
        return { order, scheduled: sorted.map((entry) => entry.pass.id) }
      },
    },
    {
      spec: '67',
      name: 'reasoning-window',
      description: 'Check a pass against its bounded window: turns ≤ 10, tokens ≤ stage budget, tool calls ≤ 20 (spec 67).',
      parameters: {
        type: 'object',
        required: ['turns', 'tokens', 'toolCalls'],
        properties: { turns: { type: 'number' }, tokens: { type: 'number' }, toolCalls: { type: 'number' } },
      },
      outputSchema: {
        type: 'object',
        required: ['withinBounds', 'bounds'],
        properties: {
          withinBounds: { type: 'boolean' },
          bounds: { type: 'object', properties: { maxTurns: { type: 'number' }, maxTokens: { type: 'number' }, maxToolCalls: { type: 'number' } } },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const turns = requireNumber(record, 'turns')
        const tokens = requireNumber(record, 'tokens')
        const toolCalls = requireNumber(record, 'toolCalls')
        const bounds = { maxTurns: 10, maxTokens: service.config.budget.stageTokenBudget, maxToolCalls: 20 }
        return { withinBounds: turns <= bounds.maxTurns && tokens <= bounds.maxTokens && toolCalls <= bounds.maxToolCalls, bounds }
      },
    },
    {
      spec: '68',
      name: 'merge-conflict-resolution',
      description: 'Resolve a merge conflict by severity: vote below 0.4, weighted below 0.8, escalate otherwise (spec 68).',
      parameters: { type: 'object', required: ['conflictScore'], properties: { conflictScore: { type: 'number' } } },
      outputSchema: { type: 'object', required: ['strategy'], properties: { strategy: { type: 'string', enum: ['vote', 'weight', 'escalate'] } } },
      execute(args) {
        const record = asRecord(args)
        const score = requireNumber(record, 'conflictScore', 0, 1)
        const strategy = score < 0.4 ? 'vote' : score < 0.8 ? 'weight' : 'escalate'
        return { strategy }
      },
    },
    {
      spec: '69',
      effectful: true,
      name: 'reasoning-lineage',
      description: 'Record a pass and its parent edge in the lineage tree; a pass without parentId is a root (spec 69).',
      parameters: {
        type: 'object',
        required: ['passId'],
        properties: { passId: { type: 'string' }, parentId: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
      },
      outputSchema: { type: 'object', required: ['recorded', 'ancestors'], properties: { recorded: { type: 'boolean' }, ancestors: stringArray } },
      execute(args, { service, sessionKey }) {
        const record = asRecord(args)
        const passId = requireString(record, 'passId')
        const parentId = record.parentId === undefined || record.parentId === null ? null : requireString(record, 'parentId')
        service.recordPass({
          id: passId,
          spec: '69',
          parentId,
          inHash: fingerprint(passId),
          outHash: fingerprint(parentId),
          deps: parentId === null ? [] : [parentId],
          verdict: 'neutral',
          score: service.score({ evidence: 0, coherence: 0, coverage: 0, contradiction: 0 }),
          startedAt: 0,
          endedAt: 0,
          tokens: 0,
          latencyMs: 0,
          unverified: [],
        })
        // Spec 15: a lineage pass is a chain link (sequential); parallel
        // structure is labeled where branches join (dag tool, spec 34).
        service.labelPass(sessionKey, passId, 'sequential')
        return { recorded: true, ancestors: service.lineage.ancestors(passId) }
      },
    },
    {
      spec: '71',
      name: 'reasoning-backpressure',
      description: 'Throttle forks when the queue depth exceeds max concurrent passes (spec 71).',
      parameters: { type: 'object', required: ['queueDepth'], properties: { queueDepth: { type: 'number' } } },
      outputSchema: { type: 'object', required: ['throttle', 'threshold'], properties: { throttle: { type: 'boolean' }, threshold: { type: 'number' } } },
      execute(args, { service }) {
        const record = asRecord(args)
        const queueDepth = requireNumber(record, 'queueDepth')
        const threshold = service.config.reasoning.maxConcurrentPasses
        return { throttle: queueDepth > threshold, threshold }
      },
    },
  ]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

export type { ScheduleOrder, TaskKind, Topology }
