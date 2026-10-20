/**
 * Visualization tools — spec 100 (policy registry) + state inspection.
 *
 * Read-only tools that render service state for debugging and observability.
 * No mutation, no cache side effects.
 */
import type { ToolSpec } from './shared.ts'
import type { PolicyRecord } from '../state/registry.ts'
import type { ReasoningPass } from '../types/pass.ts'

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  return args as Record<string, unknown>
}

function renderLineageTree(lineage: { get: (id: string) => ReasoningPass | undefined; children: (id: string) => readonly string[]; all: () => readonly ReasoningPass[] }, maxDepth: number): string {
  const passes = lineage.all()
  if (passes.length === 0) return '(empty)'

  // Find roots (passes without parents)
  const roots = passes.filter((p) => p.parentId === null)
  if (roots.length === 0) return '(no roots found)'

  const lines: string[] = []
  const visited = new Set<string>()

  function renderNode(passId: string, prefix: string, isLast: boolean, depth: number): void {
    if (visited.has(passId)) return
    visited.add(passId)

    const pass = lineage.get(passId)
    const verdict = pass?.verdict ?? 'unknown'
    const tokens = pass?.tokens ?? 0
    const marker = isLast ? '└── ' : '├── '
    lines.push(`${prefix}${marker}${passId} [${verdict}, ${tokens} tokens]`)

    const children = lineage.children(passId)
    const childPrefix = prefix + (isLast ? '    ' : '│   ')
    // A lineage deeper than the cap is reported, not silently dropped: the
    // operator has to know the tree they see is a prefix of the real one.
    if (depth >= maxDepth) {
      if (children.length > 0) lines.push(`${childPrefix}└── … (${children.length} more, depth cap ${maxDepth} reached)`)
      return
    }
    children.forEach((childId, index) => {
      renderNode(childId, childPrefix, index === children.length - 1, depth + 1)
    })
  }

  roots.forEach((root, index) => {
    renderNode(root.id, '', index === roots.length - 1, 1)
  })

  return lines.join('\n')
}

export function visualizeTools(): ToolSpec[] {
  return [
    {
      spec: '100',
      name: 'inspect',
      description: 'Render the complete fable51 service state: policies, lineage, costs, cache, snapshots, and config summary.',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', default: 'ascii', description: 'Output format: json or ascii' },
          includeWorklog: { type: 'boolean', default: false, description: 'Include full worklog entries' },
          includeGateLog: { type: 'boolean', default: false, description: 'Include full gate log entries' },
          maxLineageDepth: { type: 'integer', default: 10, description: 'Max lineage tree depth to render' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['session', 'policies', 'lineage', 'costs', 'cache', 'snapshots', 'config'],
        properties: {
          session: { type: 'string', description: 'the session the run-scoped numbers below belong to' },
          policies: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'version', 'owner', 'active', 'hash'],
              properties: {
                id: { type: 'string' },
                version: { type: 'string' },
                owner: { type: 'string' },
                active: { type: 'boolean' },
                hash: { type: 'string' },
              },
            },
          },
          lineage: {
            type: 'object',
            required: ['totalPasses', 'verdicts', 'treeAscii'],
            properties: {
              totalPasses: { type: 'integer' },
              verdicts: {
                type: 'object',
                required: ['contributed', 'neutral', 'discarded'],
                properties: {
                  contributed: { type: 'integer' },
                  neutral: { type: 'integer' },
                  discarded: { type: 'integer' },
                },
              },
              treeAscii: { type: 'string' },
            },
          },
          costs: {
            type: 'object',
            required: ['totalTokens', 'totalLatencyMs', 'totalRisk', 'byStage', 'stageBudgets'],
            properties: {
              totalTokens: { type: 'number' },
              totalLatencyMs: { type: 'number' },
              totalRisk: { type: 'number' },
              byStage: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['stage', 'tokens', 'latencyMs', 'risk', 'entries'],
                  properties: {
                    stage: { type: 'string' },
                    tokens: { type: 'number' },
                    latencyMs: { type: 'number' },
                    risk: { type: 'number' },
                    entries: { type: 'integer' },
                  },
                },
              },
              stageBudgets: { type: 'object' },
            },
          },
          cache: {
            type: 'object',
            required: ['size', 'hits', 'misses', 'hitRate'],
            properties: {
              size: { type: 'integer' },
              hits: { type: 'integer' },
              misses: { type: 'integer' },
              hitRate: { type: 'number' },
            },
          },
          snapshots: {
            type: 'object',
            required: ['count', 'latest', 'ids'],
            properties: {
              count: { type: 'integer' },
              latest: { type: 'string' },
              ids: { type: 'array', items: { type: 'string' } },
            },
          },
          config: {
            type: 'object',
            required: ['effortTier', 'maxForkDepth', 'maxConcurrentPasses', 'stageTokenBudget'],
            properties: {
              effortTier: { type: 'string' },
              maxForkDepth: { type: 'integer' },
              maxConcurrentPasses: { type: 'integer' },
              stageTokenBudget: { type: 'integer' },
            },
          },
          worklog: { type: 'array' },
          gateLog: { type: 'array' },
        },
      },
      execute(args, { service, sessionKey }) {
        const record = asRecord(args)
        const format = (record.format as string) ?? 'ascii'
        const includeWorklog = record.includeWorklog === true
        const includeGateLog = record.includeGateLog === true

        if (format !== 'json' && format !== 'ascii') {
          throw new Error(`format must be 'json' or 'ascii', got '${format}'`)
        }

        const maxLineageDepth = record.maxLineageDepth === undefined ? 10 : record.maxLineageDepth
        if (typeof maxLineageDepth !== 'number' || !Number.isSafeInteger(maxLineageDepth) || maxLineageDepth < 1) {
          throw new Error('maxLineageDepth must be a positive integer')
        }

        // Policies
        const policies = service.registry.all().map((p: PolicyRecord) => ({
          id: p.id,
          version: p.version,
          owner: p.owner,
          active: p.active,
          hash: p.hash,
        }))

        // Lineage
        const allPasses = service.lineage.all()
        const verdicts = service.lineage.verdicts()
        const treeAscii = renderLineageTree({
          get: (id) => service.lineage.get(id),
          children: (id) => service.lineage.children(id),
          all: () => allPasses,
        }, maxLineageDepth)

        // Costs
        const costEntries = service.costLedger
        let totalTokens = 0
        let totalLatencyMs = 0
        let totalRisk = 0
        const byStageMap = new Map<string, { tokens: number; latencyMs: number; risk: number; entries: number }>()

        for (const entry of costEntries) {
          totalTokens += entry.tokens
          totalLatencyMs += entry.latencyMs
          totalRisk += entry.riskWeight
          const existing = byStageMap.get(entry.stage) ?? { tokens: 0, latencyMs: 0, risk: 0, entries: 0 }
          existing.tokens += entry.tokens
          existing.latencyMs += entry.latencyMs
          existing.risk += entry.riskWeight
          existing.entries += 1
          byStageMap.set(entry.stage, existing)
        }

        const byStage = [...byStageMap.entries()].map(([stage, totals]) => ({
          stage,
          tokens: totals.tokens,
          latencyMs: totals.latencyMs,
          risk: totals.risk,
          entries: totals.entries,
        }))

        const stageBudgets: Record<string, number> = {}
        for (const [stage, budget] of service.episode(sessionKey).stageTokens) {
          stageBudgets[stage] = budget
        }

        // Cache
        const cacheSize = service.cache.size
        const cacheHits = service.cache.hits
        const cacheMisses = service.cache.misses
        const hitRate = cacheHits + cacheMisses > 0 ? cacheHits / (cacheHits + cacheMisses) : 0

        // Snapshots
        const snapshotIds = service.snapshots.ids()
        const latestSnapshot = service.snapshots.latest()

        // Config summary
        const config = {
          effortTier: service.episode(sessionKey).effortTier,
          maxForkDepth: service.config.budget.maxForkDepth,
          maxConcurrentPasses: service.config.reasoning.maxConcurrentPasses,
          stageTokenBudget: service.config.budget.stageTokenBudget,
        }

        const output = {
          // The run-scoped numbers below belong to this session; the shared
          // audit trail belongs to the host. Say which is which.
          session: sessionKey,
          policies,
          lineage: {
            totalPasses: allPasses.length,
            verdicts,
            treeAscii,
          },
          costs: {
            totalTokens,
            totalLatencyMs,
            totalRisk,
            byStage,
            stageBudgets,
          },
          cache: {
            size: cacheSize,
            hits: cacheHits,
            misses: cacheMisses,
            hitRate,
          },
          snapshots: {
            count: snapshotIds.length,
            latest: latestSnapshot?.id ?? 'none',
            ids: snapshotIds,
          },
          config,
          worklog: includeWorklog ? service.worklog : [],
          gateLog: includeGateLog ? service.gateLog : [],
        }

        if (format === 'json') {
          return output
        }

        // ASCII format
        const lines: string[] = []
        lines.push('=== fable51 Policy Visualizer ===')
        lines.push('')
        lines.push(`Run scope: session "${sessionKey}" (budgets, effort tier, fork window)`)
        lines.push('Shared scope: host (policies, ledger, cache, snapshots, lineage)')
        lines.push('')

        lines.push('--- Policies ---')
        if (policies.length === 0) {
          lines.push('  (none)')
        } else {
          for (const p of policies) {
            const activeMark = p.active ? ' ★' : ''
            lines.push(`  ${p.id}@${p.version} (owner: ${p.owner})${activeMark}`)
            lines.push(`    hash: ${p.hash}`)
          }
        }
        lines.push('')

        lines.push('--- Lineage ---')
        lines.push(`  Total passes: ${allPasses.length}`)
        lines.push(`  Verdicts: contributed=${verdicts.contributed}, neutral=${verdicts.neutral}, discarded=${verdicts.discarded}`)
        lines.push('')
        lines.push(treeAscii)
        lines.push('')

        lines.push('--- Costs ---')
        lines.push(`  Total: ${totalTokens} tokens, ${totalLatencyMs}ms, risk ${totalRisk}`)
        for (const stage of byStage) {
          const budget = stageBudgets[stage.stage]
          const budgetStr = budget !== undefined ? ` (budget: ${budget})` : ''
          lines.push(`  ${stage.stage}: ${stage.tokens} tokens, ${stage.latencyMs}ms, risk ${stage.risk} [${stage.entries} entries]${budgetStr}`)
        }
        lines.push('')

        lines.push('--- Cache ---')
        lines.push(`  Size: ${cacheSize}, Hits: ${cacheHits}, Misses: ${cacheMisses}, Hit rate: ${(hitRate * 100).toFixed(1)}%`)
        lines.push('')

        lines.push('--- Snapshots ---')
        lines.push(`  Count: ${snapshotIds.length}, Latest: ${latestSnapshot?.id ?? 'none'}`)
        if (snapshotIds.length > 0) {
          lines.push(`  IDs: ${snapshotIds.join(', ')}`)
        }
        lines.push('')

        lines.push('--- Config ---')
        lines.push(`  Effort tier: ${config.effortTier}`)
        lines.push(`  Max fork depth: ${config.maxForkDepth}`)
        lines.push(`  Max concurrent passes: ${config.maxConcurrentPasses}`)
        lines.push(`  Stage token budget: ${config.stageTokenBudget}`)

        return { ascii: lines.join('\n'), ...output }
      },
    },
  ]
}
