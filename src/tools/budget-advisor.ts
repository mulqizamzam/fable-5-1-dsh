/**
 * Budget Advisor tool: spec 11 (cost-accuracy-tradeoff) + spec 60 (reasoning-cost-model).
 *
 * Analyzes historical cost ledger to recommend stageTokenBudget, maxForkDepth, effortTier
 * for a given task class. Pure heuristics: quantiles of observed costs per task class.
 */
import type { ToolSpec } from './shared.ts'

type TaskClass = 'bounded' | 'search' | 'multihop' | 'open'

interface CostEntry {
  readonly stage: string
  readonly tokens: number
  readonly latencyMs: number
  readonly riskWeight: number
  readonly at: number
}

interface StageStats {
  readonly stage: string
  readonly count: number
  readonly p50Tokens: number
  readonly p90Tokens: number
  readonly p50LatencyMs: number
  readonly p90LatencyMs: number
  readonly avgRisk: number
}

interface Recommendation {
  readonly taskClass: TaskClass
  readonly recommended: {
    readonly stageTokenBudget: number
    readonly maxForkDepth: number
    readonly effortTier: 'low' | 'mid' | 'high' | 'max'
  }
  readonly confidence: 'high' | 'medium' | 'low'
  readonly rationale: string
  readonly stageStats: readonly StageStats[]
  readonly sampleSize: number
}

const TASK_CLASS_ORDER: readonly TaskClass[] = ['bounded', 'search', 'multihop', 'open']
const EFFORT_TIERS = ['low', 'mid', 'high', 'max'] as const

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  return args as Record<string, unknown>
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function requireTaskClass(args: Record<string, unknown>): TaskClass {
  const taskClass = requireString(args, 'taskClass')
  if (!TASK_CLASS_ORDER.includes(taskClass as TaskClass)) {
    throw new Error(`taskClass must be one of: ${TASK_CLASS_ORDER.join(', ')}`)
  }
  return taskClass as TaskClass
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil(p / 100 * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]!
}

function computeStageStats(entries: readonly CostEntry[]): StageStats[] {
  const byStage = new Map<string, CostEntry[]>()

  for (const entry of entries) {
    const arr = byStage.get(entry.stage) ?? []
    arr.push(entry)
    byStage.set(entry.stage, arr)
  }

  const stats: StageStats[] = []
  for (const [stage, stageEntries] of byStage) {
    const tokens = stageEntries.map((e) => e.tokens).sort((a, b) => a - b)
    const latency = stageEntries.map((e) => e.latencyMs).sort((a, b) => a - b)
    const riskSum = stageEntries.reduce((sum, e) => sum + e.riskWeight, 0)

    stats.push({
      stage,
      count: stageEntries.length,
      p50Tokens: percentile(tokens, 50),
      p90Tokens: percentile(tokens, 90),
      p50LatencyMs: percentile(latency, 50),
      p90LatencyMs: percentile(latency, 90),
      avgRisk: stageEntries.length > 0 ? riskSum / stageEntries.length : 0,
    })
  }

  return stats.sort((a, b) => b.p90Tokens - a.p90Tokens)
}

function recommendConfig(taskClass: TaskClass, stageStats: readonly StageStats[], sampleSize: number): Recommendation['recommended'] {
  // Total p90 tokens across all stages as baseline budget
  const totalP90Tokens = stageStats.reduce((sum, s) => sum + s.p90Tokens, 0)
  const totalP50Tokens = stageStats.reduce((sum, s) => sum + s.p50Tokens, 0)

  // Task class multipliers (heuristics based on spec 11 cost-accuracy curves)
  const multipliers: Record<TaskClass, { budget: number; forkDepth: number; effortTier: number }> = {
    bounded: { budget: 1.2, forkDepth: 1, effortTier: 0 },      // low effort, shallow forks
    search: { budget: 2.0, forkDepth: 2, effortTier: 1 },       // mid effort, moderate forks
    multihop: { budget: 3.5, forkDepth: 3, effortTier: 2 },     // high effort, deeper forks
    open: { budget: 5.0, forkDepth: 4, effortTier: 3 },         // max effort, max forks
  }

  const m = multipliers[taskClass]

  // Budget: use p90 * multiplier, clamp to reasonable range
  const baseBudget = totalP90Tokens > 0 ? totalP90Tokens : totalP50Tokens > 0 ? totalP50Tokens * 2 : 400_000
  const stageTokenBudget = Math.min(Math.max(Math.round(baseBudget * m.budget), 50_000), 2_000_000)

  // Fork depth: base from task class, adjust by sample confidence
  const maxForkDepth = Math.min(Math.max(m.forkDepth, 1), 4)

  // Effort tier: base from task class
  const effortTier = EFFORT_TIERS[m.effortTier] ?? 'mid'

  return { stageTokenBudget, maxForkDepth, effortTier }
}

function computeConfidence(sampleSize: number, taskClass: TaskClass): 'high' | 'medium' | 'low' {
  // Need at least 10 samples per stage for high confidence
  // Task class 'bounded' needs fewer samples (more predictable)
  const thresholds: Record<TaskClass, { high: number; medium: number }> = {
    bounded: { high: 5, medium: 2 },
    search: { high: 15, medium: 5 },
    multihop: { high: 20, medium: 8 },
    open: { high: 30, medium: 10 },
  }
  const t = thresholds[taskClass]
  if (sampleSize >= t.high) return 'high'
  if (sampleSize >= t.medium) return 'medium'
  return 'low'
}

function buildRationale(taskClass: TaskClass, stageStats: readonly StageStats[], recommended: Recommendation['recommended'], confidence: Recommendation['confidence']): string {
  const topStage = stageStats[0]?.stage ?? 'unknown'
  const topP90 = stageStats[0]?.p90Tokens ?? 0

  const lines = [
    `Task class: ${taskClass} (spec 11: ${taskClass} → effort tier ${recommended.effortTier})`,
    `Based on ${stageStats.length} stages with historical data`,
    `Dominant cost stage: ${topStage} (p90: ${topP90} tokens)`,
    `Recommended stageTokenBudget: ${recommended.stageTokenBudget.toLocaleString()} (${confidence} confidence)`,
    `Recommended maxForkDepth: ${recommended.maxForkDepth}`,
    `Recommended effortTier: ${recommended.effortTier}`,
  ]
  return lines.join('; ')
}

export function budgetAdvisorTools(): ToolSpec[] {
  return [
    {
      spec: '11',
      name: 'budget-advisor',
      description: 'Recommend stageTokenBudget, maxForkDepth, effortTier for a task class based on historical cost ledger (spec 11, 60).',
      parameters: {
        type: 'object',
        required: ['taskClass'],
        properties: {
          taskClass: { type: 'string', enum: ['bounded', 'search', 'multihop', 'open'], description: 'Task difficulty class (spec 11)' },
          historyWindow: { type: 'integer', default: 5000, description: 'Number of recent cost ledger entries to analyze' },
          minSamplesPerStage: { type: 'integer', default: 2, description: 'Minimum samples per stage to include in stats' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['taskClass', 'recommended', 'confidence', 'rationale', 'stageStats', 'sampleSize'],
        properties: {
          taskClass: { type: 'string', enum: ['bounded', 'search', 'multihop', 'open'] },
          recommended: {
            type: 'object',
            required: ['stageTokenBudget', 'maxForkDepth', 'effortTier'],
            properties: {
              stageTokenBudget: { type: 'integer' },
              maxForkDepth: { type: 'integer' },
              effortTier: { type: 'string', enum: ['low', 'mid', 'high', 'max'] },
            },
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          rationale: { type: 'string' },
          stageStats: {
            type: 'array',
            items: {
              type: 'object',
              required: ['stage', 'count', 'p50Tokens', 'p90Tokens', 'p50LatencyMs', 'p90LatencyMs', 'avgRisk'],
              properties: {
                stage: { type: 'string' },
                count: { type: 'integer' },
                p50Tokens: { type: 'number' },
                p90Tokens: { type: 'number' },
                p50LatencyMs: { type: 'number' },
                p90LatencyMs: { type: 'number' },
                avgRisk: { type: 'number' },
              },
            },
          },
          sampleSize: { type: 'integer' },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const taskClass = requireTaskClass(record)
        const historyWindow = typeof record.historyWindow === 'number' ? record.historyWindow : 5000
        const minSamples = typeof record.minSamplesPerStage === 'number' ? record.minSamplesPerStage : 2

        // Get recent cost ledger entries
        const allEntries = service.costLedger
        const recentEntries = allEntries.slice(-historyWindow)

        if (recentEntries.length === 0) {
          // No history: return defaults based on task class
          const defaults = recommendConfig(taskClass, [], 0)
          return {
            taskClass,
            recommended: defaults,
            confidence: 'low',
            rationale: `No cost history available (ledger empty). Using defaults for ${taskClass}.`,
            stageStats: [],
            sampleSize: 0,
          }
        }

        // Compute stats per stage
        const stageStats = computeStageStats(recentEntries).filter((s) => s.count >= minSamples)

        if (stageStats.length === 0) {
          const defaults = recommendConfig(taskClass, [], recentEntries.length)
          return {
            taskClass,
            recommended: defaults,
            confidence: 'low',
            rationale: `Insufficient samples per stage (min ${minSamples}). Using defaults for ${taskClass}.`,
            stageStats: [],
            sampleSize: recentEntries.length,
          }
        }

        // Generate recommendation
        const recommended = recommendConfig(taskClass, stageStats, recentEntries.length)
        const confidence = computeConfidence(recentEntries.length, taskClass)
        const rationale = buildRationale(taskClass, stageStats, recommended, confidence)

        return {
          taskClass,
          recommended,
          confidence,
          rationale,
          stageStats,
          sampleSize: recentEntries.length,
        }
      },
    },
  ]
}
