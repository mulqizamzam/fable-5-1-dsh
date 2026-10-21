/**
 * Governance tools, specs 13, 20, 91, 92, 94, 98, 99 (Gate 4o).
 *
 * The group that keeps a delivery honest: every result emits a worklog line
 * (13) with an explicit unverified list (20), merges are canonical and
 * order-independent (91), drift is measured against the spec anchor (92),
 * lineage is garbage-collected (94), policies are A/B-tested on one input
 * (98), and a pass migrated across models is fingerprinted for divergence
 * (99).
 */
import type { ToolSpec } from './shared.ts'
import type { WorklogEntry } from '../policy-service.ts'
import { fingerprint } from '../state/cache.ts'

const VERDICTS = ['contributed', 'neutral', 'discarded'] as const

/** Lowercased alphanumeric tokens; the word universe of drift measurement (92). */
function tokenize(text: string): readonly string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Union of keys with later values winning, resolved in canonical fingerprint order (91). */
function mergeOutputs(outputs: readonly Record<string, unknown>[]): Record<string, unknown> {
  const ordered = [...outputs].sort((a, b) => {
    const left = fingerprint(a)
    const right = fingerprint(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  // A null prototype keeps a caller-supplied `__proto__` an ordinary own key
  // instead of an assignment that silently repoints the merged object's
  // prototype and drops the key from the union spec 91 then fingerprints.
  const merged: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const output of ordered) {
    for (const [key, value] of Object.entries(output)) merged[key] = value
  }
  return merged
}

export function governanceTools(): ToolSpec[] {
  return [
    {
      spec: '13',
      effectful: true,
      name: 'worklog-format',
      description: 'Record the final worklog line, stage, output, check, verdict, and the explicit unverified list (spec 13).',
      parameters: {
        type: 'object',
        required: ['stage', 'output', 'check', 'verdict'],
        properties: {
          stage: { type: 'string', description: 'Stage that produced the output.' },
          output: { type: 'string', description: 'What the stage delivered.' },
          check: { type: 'string', description: 'How the output was checked.' },
          verdict: { type: 'string', enum: VERDICTS, description: 'Contribution verdict of the stage.' },
          unverified: { type: 'array', items: { type: 'string' }, description: 'Claims that remain unverified.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['stage', 'output', 'check', 'verdict', 'unverified', 'at'],
        properties: {
          stage: { type: 'string' },
          output: { type: 'string' },
          check: { type: 'string' },
          verdict: { type: 'string', enum: VERDICTS },
          unverified: { type: 'array', items: { type: 'string' } },
          at: { type: 'number' },
        },
      },
      execute(args, { service, scopeKey }): WorklogEntry {
        const { stage, output, check, verdict, unverified } = args as {
          stage: string
          output: string
          check: string
          verdict: WorklogEntry['verdict']
          unverified?: string[]
        }
        return service.recordWorklog({
          stage,
          output,
          check,
          verdict,
          unverified: unverified ?? [],
          at: Date.now(),
        }, scopeKey)
      },
    },
    {
      spec: '20',
      name: 'partial-delivery',
      description: 'When the final stage is unverified, ship the prior verified output plus the explicit list of what is not verified (spec 20).',
      parameters: {
        type: 'object',
        required: ['finalVerified', 'unverified'],
        properties: {
          finalVerified: { type: 'boolean', description: 'Whether the final stage output is verified.' },
          priorOutput: { description: 'The last verified output, shipped when finalVerified is false.' },
          unverified: { type: 'array', items: { type: 'string' }, description: 'Explicit list of what remains unverified.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['shipped'],
        properties: {
          shipped: { type: 'string', enum: ['final', 'prior'] },
          priorOutput: { description: 'Present only when the prior output ships.' },
          unverified: { type: 'array', items: { type: 'string' }, description: 'Present only when the prior output ships.' },
        },
      },
      execute(args) {
        const { finalVerified, priorOutput, unverified } = args as {
          finalVerified: boolean
          priorOutput?: unknown
          unverified?: string[]
        }
        // A truthy non-boolean ('false', 0, {}) would ship an unverified final
        // as the verified branch, which is the one outcome this tool exists to prevent.
        if (typeof finalVerified !== 'boolean') throw new Error('finalVerified must be a boolean')
        if (finalVerified) return { shipped: 'final' }
        // An omitted list defaulted to [], which let judge() certify an
        // unverified delivery as verified (spec 20).
        return {
          shipped: 'prior',
          priorOutput,
          unverified: unverified ?? ['final stage unverified and no unverified list supplied'],
        }
      },
    },
    {
      spec: '91',
      name: 'pass-merge-idempotency',
      description: 'Merge pass outputs by union of keys, resolved in canonical fingerprint order so any input order yields the same result (spec 91).',
      parameters: {
        type: 'object',
        required: ['outputs'],
        properties: {
          outputs: {
            type: 'array',
            items: { type: 'object' },
            description: 'Pass outputs to merge; entries must be objects.',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['merged', 'orderIndependent'],
        properties: {
          merged: { type: 'object' },
          orderIndependent: { type: 'boolean' },
        },
      },
      execute(args) {
        const { outputs } = args as { outputs: Record<string, unknown>[] }
        for (const [index, output] of outputs.entries()) {
          if (typeof output !== 'object' || output === null || Array.isArray(output)) {
            throw new Error(`outputs[${index}] must be an object, spec 91 merges by union of object keys`)
          }
        }
        const forward = mergeOutputs(outputs)
        const backward = mergeOutputs([...outputs].reverse())
        return { merged: forward, orderIndependent: fingerprint(forward) === fingerprint(backward) }
      },
    },
    {
      spec: '92',
      name: 'reasoning-drift-detection',
      description: 'Measure drift between a pass output and its spec anchor as 1 − common-word overlap ratio; drift above the ε threshold reports drifted (spec 92).',
      parameters: {
        type: 'object',
        required: ['anchor', 'output'],
        properties: {
          anchor: { type: 'string', description: 'The spec anchor text.' },
          output: { type: 'string', description: 'The pass output text to compare.' },
          epsilon: { type: 'number', description: 'Drift threshold; defaults to config.reasoning.convergenceDelta.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['drift', 'drifted', 'epsilon'],
        properties: {
          drift: { type: 'number' },
          drifted: { type: 'boolean' },
          epsilon: { type: 'number' },
        },
      },
      execute(args, { service, scopeKey }) {
        const { anchor, output, epsilon } = args as { anchor: string; output: string; epsilon?: number }
        // The threshold is both compared against and echoed into the declared
        // number field, so a string epsilon would be coerced and returned as-is.
        if (epsilon !== undefined && (typeof epsilon !== 'number' || !Number.isFinite(epsilon))) {
          throw new Error('epsilon must be a finite number')
        }
        const threshold = epsilon ?? service.config.reasoning.convergenceDelta
        const anchorWords = new Set(tokenize(anchor))
        const outputWords = new Set(tokenize(output))
        const union = new Set([...anchorWords, ...outputWords])
        const common = [...anchorWords].filter((word) => outputWords.has(word)).length
        const ratio = union.size === 0 ? 1 : common / union.size
        const drift = 1 - ratio
        return { drift, drifted: drift > threshold, epsilon: threshold }
      },
    },
    {
      spec: '94',
      effectful: true,
      name: 'reasoning-garbage-collection',
      description: 'Collect reasoning passes no longer referenced, keeping live ancestry and the most recent N passes (spec 94).',
      parameters: {
        type: 'object',
        required: ['liveIds', 'keepLastN'],
        properties: {
          liveIds: { type: 'array', items: { type: 'string' }, description: 'Ids still referenced by the live pipeline.' },
          keepLastN: { type: 'number', description: 'How many of the most recent passes to retain.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['dropped', 'kept'],
        properties: {
          dropped: { type: 'array', items: { type: 'string' } },
          kept: { type: 'number' },
        },
      },
      execute(args, { service, scopeKey }) {
        const { liveIds, keepLastN } = args as { liveIds: string[]; keepLastN: number }
        // Same hazard as keepLastN below: an omitted liveIds is an empty keep-set,
        // so a malformed call collects the entire lineage.
        if (!Array.isArray(liveIds) || liveIds.some((id: unknown) => typeof id !== 'string')) {
          throw new Error('liveIds must be an array of strings')
        }
        // `Math.max(0, NaN)` is NaN and `slice(NaN)` is `slice(0)`, so an
        // unvalidated keepLastN makes this destructive call empty the whole lineage.
        if (typeof keepLastN !== 'number' || !Number.isFinite(keepLastN)) {
          throw new Error('keepLastN must be a finite number')
        }
        // A negative count is a typo, not a request to keep nothing.
        if (keepLastN < 0) throw new Error('keepLastN must not be negative')
        const dropped = service.lineageOf(scopeKey).gc(liveIds, keepLastN)
        return { dropped: [...dropped], kept: service.lineageOf(scopeKey).size() }
      },
    },
    {
      spec: '98',
      name: 'reasoning-ab-test',
      description: 'Run the same input through two reasoning policies and pick by score, breaking a score tie on lower cost (spec 98).',
      parameters: {
        type: 'object',
        required: ['input', 'policyA', 'policyB'],
        properties: {
          input: { description: 'The shared input both policies are evaluated on.' },
          policyA: {
            type: 'object',
            required: ['score', 'cost'],
            properties: {
              score: { type: 'number' },
              cost: { type: 'number' },
            },
          },
          policyB: {
            type: 'object',
            required: ['score', 'cost'],
            properties: {
              score: { type: 'number' },
              cost: { type: 'number' },
            },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['winner', 'reason'],
        properties: {
          winner: { type: 'string', enum: ['A', 'B'] },
          reason: { type: 'string' },
        },
      },
      execute(args) {
        const { input, policyA, policyB } = args as {
          input: unknown
          policyA: { score: number; cost: number }
          policyB: { score: number; cost: number }
        }
        const on = `on input ${fingerprint(input)}`
        if (policyA.score !== policyB.score) {
          const winner = policyA.score > policyB.score ? 'A' : 'B'
          const [chosen, other] = winner === 'A' ? [policyA, policyB] : [policyB, policyA]
          return { winner, reason: `policy ${winner} scored ${chosen.score} over ${other.score} ${on}` }
        }
        if (policyA.cost !== policyB.cost) {
          const winner = policyA.cost < policyB.cost ? 'A' : 'B'
          const [chosen, other] = winner === 'A' ? [policyA, policyB] : [policyB, policyA]
          return { winner, reason: `scores tie at ${policyA.score}; policy ${winner} cost ${chosen.cost} under ${other.cost} ${on}` }
        }
        return { winner: 'A', reason: `scores and costs are identical (${policyA.score}, ${policyA.cost}); policy A taken by default ${on}` }
      },
    },
    {
      spec: '99',
      effectful: true,
      name: 'pass-migration',
      description: 'Migrate a pass to another model, verify its output is unchanged, and record a worklog line when the migration diverges (spec 99).',
      parameters: {
        type: 'object',
        required: ['passId', 'fromModel', 'toModel', 'outputBefore', 'outputAfter'],
        properties: {
          passId: { type: 'string' },
          fromModel: { type: 'string' },
          toModel: { type: 'string' },
          outputBefore: { description: 'Pass output on the source model.' },
          outputAfter: { description: 'Pass output on the target model.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['migrated', 'divergence', 'fromModel', 'toModel'],
        properties: {
          migrated: { type: 'boolean' },
          divergence: { type: 'boolean' },
          fromModel: { type: 'string' },
          toModel: { type: 'string' },
        },
      },
      execute(args, { service, scopeKey }) {
        const { passId, fromModel, toModel, outputBefore, outputAfter } = args as {
          passId: string
          fromModel: string
          toModel: string
          outputBefore: unknown
          outputAfter: unknown
        }
        const before = fingerprint(outputBefore)
        const after = fingerprint(outputAfter)
        const divergence = before !== after
        if (divergence) {
          // The source model's verification does not carry over, so the line
          // is recorded as discarded with the equivalence claim unverified.
          service.recordWorklog({
            stage: `pass-migration:${passId}`,
            output: `${fromModel} → ${toModel} changed the pass output (${before} → ${after})`,
            check: `fingerprint(outputBefore) === fingerprint(outputAfter): ${before} vs ${after}`,
            verdict: 'discarded',
            unverified: [`pass ${passId} equivalence across ${fromModel} → ${toModel}`],
            at: Date.now(),
          }, scopeKey)
        }
        return { migrated: true, divergence, fromModel, toModel }
      },
    },
  ]
}
