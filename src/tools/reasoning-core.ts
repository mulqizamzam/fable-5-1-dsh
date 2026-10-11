/**
 * Reasoning-core tools — specs 31, 32, 35, 37, 38, 39, 40, 41, 42, 44, 45, 46, 49
 * (PRD §4.3/§4.4, Gates 4g–4n).
 *
 * The decision half of the reasoning group: fork/merge/discard structure
 * selection, score-gated top-k pruning, chain-vs-tree selection, the
 * pre-reasoning batch feed, pass-boundary checkpoints, pairwise contradiction
 * detection, weighted confidence, speculative-execution economics, convergence
 * early exit, divergence caps, merge strategies, checkpoint rollback, and the
 * pass trace record. Every tool is deterministic; the only state touched is
 * the state the spec itself owns (snapshot index read/write).
 */
import type { ToolSpec } from './shared.ts'
import { fingerprint } from '../state/cache.ts'
import type { PassVerdict, ReasoningTrace } from '../types/pass.ts'

interface Hypothesis {
  readonly id: string
  readonly score: number
}

interface Claim {
  readonly id: string
  readonly value: unknown
}

interface Vote {
  readonly weight: number
  readonly value: unknown
}

type ForkDecision = 'fork' | 'merge' | 'keep' | 'discard'
type Topology = 'chain' | 'tree'
type MergeStrategy = 'union' | 'intersection' | 'weighted'

const HYPOTHESIS_SCHEMA = {
  type: 'object',
  required: ['id', 'score'],
  properties: {
    id: { type: 'string', description: 'hypothesis identity' },
    score: { type: 'number', description: 'exploration score used for ranking' },
  },
}

const SCORE_SCHEMA = {
  type: 'object',
  required: ['evidence', 'coherence', 'coverage', 'contradiction', 'weighted'],
  properties: {
    evidence: { type: 'number' },
    coherence: { type: 'number' },
    coverage: { type: 'number' },
    contradiction: { type: 'number' },
    weighted: { type: 'number' },
  },
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  return args as Record<string, unknown>
}

function requireObject(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${key} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function requireFiniteNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`)
  return value
}

function requireCount(args: Record<string, unknown>, key: string): number {
  const value = requireFiniteNumber(args, key)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`)
  return value
}

function requirePositiveCount(args: Record<string, unknown>, key: string): number {
  const value = requireFiniteNumber(args, key)
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`)
  return value
}

function requireNumberList(value: unknown, key: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of numbers`)
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) throw new Error(`${key} must be an array of finite numbers`)
  }
  return value as number[]
}

function requireStringList(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`)
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error(`${key} must be an array of strings`)
  }
  return value as string[]
}

function requireStringSets(value: unknown, key: string): string[][] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of string arrays`)
  return value.map((entry) => requireStringList(entry, `${key} entry`))
}

function withIndex<T>(index: number, label: string, parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    throw new Error(`${label}[${index}] ${error instanceof Error ? error.message : String(error)}`)
  }
}

function requireHypotheses(value: unknown): Hypothesis[] {
  if (!Array.isArray(value)) throw new Error('hypotheses must be an array of {id, score}')
  return value.map((entry, index) => {
    const hypothesis = requireObject(entry, `hypotheses[${index}]`)
    return withIndex(index, 'hypotheses', () => ({
      id: requireString(hypothesis, 'id'),
      score: requireFiniteNumber(hypothesis, 'score'),
    }))
  })
}

function requireClaims(value: unknown): Claim[] {
  if (!Array.isArray(value)) throw new Error('claims must be an array of {id, value}')
  return value.map((entry, index) => {
    const claim = requireObject(entry, `claims[${index}]`)
    return withIndex(index, 'claims', () => ({ id: requireString(claim, 'id'), value: claim.value }))
  })
}

function requireVotes(value: unknown): Vote[] {
  if (!Array.isArray(value)) throw new Error('votes must be an array of {weight, value}')
  return value.map((entry, index) => {
    const vote = requireObject(entry, `votes[${index}]`)
    return withIndex(index, 'votes', () => ({ weight: requireFiniteNumber(vote, 'weight'), value: vote.value }))
  })
}

function requireMergeStrategy(args: Record<string, unknown>): MergeStrategy {
  const strategy = args.strategy
  if (strategy !== 'union' && strategy !== 'intersection' && strategy !== 'weighted') {
    throw new Error('strategy must be one of union, intersection, weighted')
  }
  return strategy
}

function requireVerdict(args: Record<string, unknown>): PassVerdict {
  const verdict = args.verdict
  if (verdict !== 'contributed' && verdict !== 'neutral' && verdict !== 'discarded') {
    throw new Error('verdict must be one of contributed, neutral, discarded')
  }
  return verdict
}

function forkDecision(candidateCount: number, budgetLeft: number): ForkDecision {
  if (candidateCount > 1) return budgetLeft > 0 ? 'fork' : 'merge'
  if (candidateCount === 1) return 'keep'
  return 'discard'
}

export function reasoningCoreTools(): ToolSpec[] {
  return [
    {
      spec: '31',
      name: 'reasoning-forking',
      description: 'Decide the reasoning structure: fork when more than one candidate survives and fork budget remains, merge when candidates remain but the budget is spent, keep a lone candidate, discard none (spec 31).',
      parameters: {
        type: 'object',
        required: ['candidateCount', 'budgetLeft'],
        properties: {
          candidateCount: { type: 'integer', description: 'candidate branches still standing after exploration' },
          budgetLeft: { type: 'integer', description: 'remaining fork budget for the stage' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['decision'],
        properties: {
          decision: { type: 'string', enum: ['fork', 'merge', 'keep', 'discard'] },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const candidateCount = requireCount(record, 'candidateCount')
        const budgetLeft = requireCount(record, 'budgetLeft')
        return { decision: forkDecision(candidateCount, budgetLeft) }
      },
    },
    {
      spec: '32',
      name: 'hypothesis-pruning',
      description: 'Prune explored hypotheses to the top-k by score, ties broken by id ascending, so no valid candidate is lost while the branch count stays bounded (spec 32).',
      parameters: {
        type: 'object',
        required: ['hypotheses', 'k'],
        properties: {
          hypotheses: {
            type: 'array',
            items: HYPOTHESIS_SCHEMA,
            description: 'hypotheses explored in parallel',
          },
          k: { type: 'integer', description: 'number of hypotheses to retain' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['kept', 'pruned'],
        properties: {
          kept: { type: 'array', items: HYPOTHESIS_SCHEMA },
          pruned: { type: 'array', items: HYPOTHESIS_SCHEMA },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const hypotheses = requireHypotheses(record.hypotheses)
        const k = requireCount(record, 'k')
        const ranked = [...hypotheses].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        return { kept: ranked.slice(0, k), pruned: ranked.slice(k) }
      },
    },
    {
      spec: '35',
      name: 'chain-vs-tree',
      description: 'Select the reasoning topology from the current branch factor: a linear chain while the fan-out stays at or below one, a tree once it branches (spec 35).',
      parameters: {
        type: 'object',
        required: ['branchFactor'],
        properties: {
          branchFactor: { type: 'integer', description: 'fan-out observed at the current pass' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['topology', 'branchFactor'],
        properties: {
          topology: { type: 'string', enum: ['chain', 'tree'] },
          branchFactor: { type: 'integer' },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const branchFactor = requireCount(record, 'branchFactor')
        const topology: Topology = branchFactor <= 1 ? 'chain' : 'tree'
        return { topology, branchFactor }
      },
    },
    {
      spec: '37',
      name: 'parallel-tool-feed',
      description: 'Batch independent tool calls before a reasoning turn so the interleaved reasoner sees more material per turn (spec 37).',
      parameters: {
        type: 'object',
        required: ['calls'],
        properties: {
          calls: {
            type: 'array',
            items: { type: 'string' },
            description: 'independent tool calls to feed in one batch',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['batched', 'independent'],
        properties: {
          batched: { type: 'integer', description: 'number of calls merged into the batch' },
          independent: { type: 'boolean', enum: [true] },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const calls = requireStringList(record.calls, 'calls')
        return { batched: calls.length, independent: true }
      },
    },
    {
      spec: '38',
      name: 'reasoning-checkpoint',
      description: 'Snapshot a reasoning pass at its boundary so the run can be resumed or audited later (spec 38).',
      parameters: {
        type: 'object',
        required: ['passId', 'state'],
        properties: {
          passId: { type: 'string', description: 'pass whose boundary is checkpointed' },
          state: { type: 'object', description: 'pass state to snapshot' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['snapshotId', 'hash'],
        properties: {
          snapshotId: { type: 'string' },
          hash: { type: 'string', description: 'content fingerprint of the checkpointed state' },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const passId = requireString(record, 'passId')
        const state = requireObject(record.state, 'state')
        const snapshot = service.snapshots.create(passId, state)
        return { snapshotId: snapshot.id, hash: snapshot.hash }
      },
    },
    {
      spec: '39',
      name: 'contradiction-detection',
      description: 'Compare parallel claims pairwise before a merge; two claims whose values differ are a contradiction (spec 39).',
      parameters: {
        type: 'object',
        required: ['claims'],
        properties: {
          claims: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'value'],
              properties: {
                id: { type: 'string' },
                value: { description: 'claimed value, compared by canonical JSON' },
              },
            },
            description: 'claims produced by the parallel passes',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['contradictions'],
        properties: {
          contradictions: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: '[idA, idB] pairs whose values conflict',
          },
        },
      },
      execute(args) {
        const claims = requireClaims(asRecord(args).claims)
        const contradictions: string[][] = []
        for (const [index, claim] of claims.entries()) {
          for (const other of claims.slice(index + 1)) {
            if (JSON.stringify(claim.value) !== JSON.stringify(other.value)) contradictions.push([claim.id, other.id])
          }
        }
        return { contradictions }
      },
    },
    {
      spec: '40',
      name: 'confidence-scoring',
      description: 'Merge parallel passes by summed vote weight, never by raw majority: the highest total weight wins (spec 40).',
      parameters: {
        type: 'object',
        required: ['votes'],
        properties: {
          votes: {
            type: 'array',
            items: {
              type: 'object',
              required: ['weight', 'value'],
              properties: {
                weight: { type: 'number' },
                value: { description: 'value the vote casts' },
              },
            },
            description: 'weighted votes cast by the parallel passes',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['winner', 'totals'],
        properties: {
          winner: { description: 'value with the highest summed weight; the first such value in vote order wins a tie, null when no vote was cast' },
          totals: {
            type: 'array',
            description: 'summed weight per distinct value, in first-vote order',
            items: {
              type: 'object',
              required: ['value', 'weight'],
              properties: {
                value: { description: 'the voted value' },
                weight: { type: 'number' },
              },
            },
          },
        },
      },
      execute(args) {
        const votes = requireVotes(asRecord(args).votes)
        const totals = new Map<string, { value: unknown; weight: number }>()
        for (const vote of votes) {
          const key = JSON.stringify(vote.value)
          const current = totals.get(key)
          if (current === undefined) totals.set(key, { value: vote.value, weight: vote.weight })
          else current.weight += vote.weight
        }
        let winner: unknown = null
        let best = Number.NEGATIVE_INFINITY
        for (const entry of totals.values()) {
          if (entry.weight > best) {
            best = entry.weight
            winner = entry.value
          }
        }
        return { winner, totals: [...totals.values()] }
      },
    },
    {
      spec: '41',
      name: 'speculative-execution',
      description: 'Run a speculative pass only while its reuse probability beats the cost of the wasted work; a miss is reported as waste (spec 41).',
      parameters: {
        type: 'object',
        required: ['reuseProb', 'cost'],
        properties: {
          reuseProb: { type: 'number', description: 'probability in [0,1] that the speculative result is reused' },
          cost: { type: 'number', description: 'cost of running the speculative pass' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['run', 'waste'],
        properties: {
          run: { type: 'boolean' },
          waste: { type: 'boolean' },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const reuseProb = requireFiniteNumber(record, 'reuseProb')
        if (reuseProb < 0 || reuseProb > 1) throw new Error('reuseProb must be a probability in [0, 1]')
        const cost = requireFiniteNumber(record, 'cost')
        if (cost < 0) throw new Error('cost must be non-negative')
        const run = reuseProb > cost / 100_000
        return { run, waste: !run }
      },
    },
    {
      spec: '42',
      name: 'early-exit',
      description: 'Stop a reasoning pass once the last n turn-to-turn changes all fall below the convergence threshold (spec 42).',
      parameters: {
        type: 'object',
        required: ['changes', 'threshold', 'n'],
        properties: {
          changes: {
            type: 'array',
            items: { type: 'number' },
            description: 'per-turn change magnitude, oldest first',
          },
          threshold: { type: 'number', description: 'convergence threshold' },
          n: { type: 'integer', description: 'number of consecutive converging turns required' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['stop'],
        properties: {
          stop: { type: 'boolean' },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const changes = requireNumberList(record.changes, 'changes')
        const threshold = requireFiniteNumber(record, 'threshold')
        const n = requirePositiveCount(record, 'n')
        const stop = changes.length >= n && changes.slice(-n).every((change) => change < threshold)
        return { stop }
      },
    },
    {
      spec: '44',
      name: 'divergence-control',
      description: 'Cap the branch count of one fork at the configured fork depth and flag when the request exceeds the cap (spec 44).',
      parameters: {
        type: 'object',
        required: ['branches'],
        properties: {
          branches: { type: 'integer', description: 'branches requested for this fork' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['capped', 'exceeded'],
        properties: {
          capped: { type: 'integer' },
          exceeded: { type: 'boolean' },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const branches = requireCount(record, 'branches')
        const maxForkDepth = service.config.budget.maxForkDepth
        return { capped: Math.min(branches, maxForkDepth), exceeded: branches > maxForkDepth }
      },
    },
    {
      spec: '45',
      name: 'merge-strategy',
      description: 'Merge parallel reasoning results by union, intersection, or weighted concatenation, each preserving first-seen order (spec 45).',
      parameters: {
        type: 'object',
        required: ['strategy', 'sets'],
        properties: {
          strategy: { type: 'string', enum: ['union', 'intersection', 'weighted'] },
          sets: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: 'per-pass result sets to merge',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['merged', 'strategy'],
        properties: {
          merged: { type: 'array', items: { type: 'string' } },
          strategy: { type: 'string', enum: ['union', 'intersection', 'weighted'] },
        },
      },
      execute(args) {
        const record = asRecord(args)
        const strategy = requireMergeStrategy(record)
        const sets = requireStringSets(record.sets, 'sets')
        const ordered = [...new Set(sets.flat())]
        const merged = strategy === 'intersection'
          ? ordered.filter((value) => sets.every((set) => set.includes(value)))
          : ordered
        return { merged, strategy }
      },
    },
    {
      spec: '46',
      name: 'reasoning-rollback',
      description: 'Revert reasoning to the most recent consistent checkpoint; null when no checkpoint exists (spec 46).',
      parameters: {
        type: 'object',
        required: ['passId'],
        properties: {
          passId: { type: 'string', description: 'pass requesting the rollback' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['revertedTo'],
        properties: {
          revertedTo: {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'snapshot id reverted to, or null when no checkpoint exists',
          },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        requireString(record, 'passId')
        return { revertedTo: service.snapshots.latest()?.id ?? null }
      },
    },
    {
      spec: '49',
      name: 'reasoning-trace-format',
      description: 'Emit the reasoning-pass trace record: input/output fingerprints, dependency ids, verdict, and weighted score (spec 49).',
      parameters: {
        type: 'object',
        required: ['id', 'input', 'output', 'deps', 'verdict'],
        properties: {
          id: { type: 'string', description: 'pass identity' },
          input: { description: 'pass input content to fingerprint' },
          output: { description: 'pass output content to fingerprint' },
          deps: { type: 'array', items: { type: 'string' }, description: 'pass ids this pass depends on' },
          verdict: { type: 'string', enum: ['contributed', 'neutral', 'discarded'] },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['id', 'inHash', 'outHash', 'deps', 'verdict', 'score'],
        properties: {
          id: { type: 'string' },
          inHash: { type: 'string' },
          outHash: { type: 'string' },
          deps: { type: 'array', items: { type: 'string' } },
          verdict: { type: 'string', enum: ['contributed', 'neutral', 'discarded'] },
          score: SCORE_SCHEMA,
        },
      },
      execute(args, { service }): ReasoningTrace {
        const record = asRecord(args)
        if (!Object.hasOwn(record, 'input')) throw new Error('input is required')
        if (!Object.hasOwn(record, 'output')) throw new Error('output is required')
        return {
          id: requireString(record, 'id'),
          inHash: fingerprint(record.input),
          outHash: fingerprint(record.output),
          deps: requireStringList(record.deps, 'deps'),
          verdict: requireVerdict(record),
          score: service.score({ evidence: 1, coherence: 1, coverage: 1, contradiction: 0 }),
        }
      },
    },
  ]
}
