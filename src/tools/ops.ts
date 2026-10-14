/**
 * Ops tools — specs 21, 23, 24, 25, 26, 29, 30 (Gate 4f).
 *
 * Enforced invariants: per-stage wall clock with expiry escalation (21),
 * fixed-precedence conflict resolution (23), one-line per-stage traces (24),
 * reproducible seed/order/pins (25), allow-list sandbox boundaries (26),
 * pinned-version drift blocking (29), and the what-failed/why/fix/
 * catching-test postmortem record (30).
 */
import type { ToolSpec } from './shared.ts'
import { fingerprint } from '../state/cache.ts'
import type { PassVerdict } from '../types/pass.ts'

const CONFLICT_PRECEDENCE = ['spec', 'contract', 'subagent', 'memory'] as const

function stableCompare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const sa = String(a)
  const sb = String(b)
  return sa < sb ? -1 : sa > sb ? 1 : 0
}

export function opsTools(): ToolSpec[] {
  return [
    {
      spec: '21',
      effectful: true,
      name: 'timeboxing',
      description: 'Enforce the per-stage wall-clock timebox; on expiry snapshot the stage, mark the result UNVERIFIED, and record a discarded worklog line (spec 21).',
      parameters: {
        type: 'object',
        required: ['stage', 'elapsedMs'],
        properties: {
          stage: { type: 'string', description: 'Stage being timed.' },
          elapsedMs: { type: 'number', description: 'Wall-clock time the stage has consumed.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['expired', 'elapsedMs'],
        properties: {
          expired: { type: 'boolean' },
          elapsedMs: { type: 'number' },
          snapshotId: { type: 'string', description: 'Expiry snapshot id, present only when expired.' },
        },
      },
      execute(args, { service }) {
        const { stage, elapsedMs } = args as { stage: string; elapsedMs: number }
        // elapsedMs is compared against the deadline and echoed into the declared
        // number field; a string would coerce into a bogus verdict and be returned as a string.
        if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
          throw new Error('elapsedMs must be a finite number')
        }
        const deadline = service.config.budget.stageTimeoutMs
        if (elapsedMs < deadline) return { expired: false, elapsedMs }
        // A constant id made every expiry of a stage overwrite the previous one.
        const snapshot = service.snapshots.create(`${stage}-timebox-${elapsedMs}`, { stage, elapsedMs, verdict: 'unverified' })
        service.recordWorklog({
          stage,
          output: `stage timebox of ${deadline}ms expired at ${elapsedMs}ms`,
          check: 'stageTimeoutMs',
          verdict: 'discarded',
          unverified: ['stage timebox expired'],
          at: Date.now(),
        })
        return { expired: true, elapsedMs, snapshotId: snapshot.id }
      },
    },
    {
      spec: '23',
      effectful: true,
      name: 'conflict-resolution',
      description: 'Resolve conflicting inputs by fixed precedence spec > contract > subagent > memory; the highest-precedence source wins and the decision is logged (spec 23).',
      parameters: {
        type: 'object',
        required: ['conflicts'],
        properties: {
          conflicts: {
            type: 'array',
            description: 'Competing values, each tagged with its source.',
            items: {
              type: 'object',
              required: ['source', 'value'],
              properties: {
                source: { type: 'string', enum: ['spec', 'contract', 'subagent', 'memory'] },
                value: { type: 'string' },
              },
            },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['winner', 'precedence', 'logged'],
        properties: {
          winner: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Winning value, or null when no conflict was supplied.' },
          precedence: { type: 'array', items: { type: 'string' } },
          logged: { type: 'boolean', enum: [true] },
        },
      },
      execute(args, { service }) {
        const { conflicts } = args as { conflicts: Array<{ source: string; value: string }> }
        let winner: string | null = null
        let winnerSource: string | null = null
        for (const source of CONFLICT_PRECEDENCE) {
          const hit = conflicts.find((entry) => entry.source === source)
          if (hit) {
            winner = hit.value
            winnerSource = source
            break
          }
        }
        service.recordWorklog({
          stage: 'conflict-resolution',
          output: winnerSource === null ? 'no conflict entries supplied' : `resolved by ${winnerSource}: ${winner}`,
          check: `precedence ${CONFLICT_PRECEDENCE.join(' > ')}`,
          verdict: winnerSource === null ? 'neutral' : 'contributed',
          unverified: [],
          at: Date.now(),
        })
        return { winner, precedence: [...CONFLICT_PRECEDENCE], logged: true }
      },
    },
    {
      spec: '24',
      effectful: true,
      name: 'observability',
      description: 'Emit a one-line per-stage trace carrying the trace id, stage, tokens, and verdict, and record it to the worklog (spec 24).',
      parameters: {
        type: 'object',
        required: ['stage', 'verdict', 'tokens'],
        properties: {
          stage: { type: 'string' },
          verdict: { type: 'string', enum: ['contributed', 'neutral', 'discarded'] },
          tokens: { type: 'number' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['traceId', 'line'],
        properties: {
          traceId: { type: 'string' },
          line: { type: 'string' },
        },
      },
      execute(args, { service }) {
        const { stage, verdict, tokens } = args as { stage: string; verdict: PassVerdict; tokens: number }
        // Same rule timeboxing applies: a string would be echoed into the trace
        // line and the worklog as if it were a measured token count.
        if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
          throw new Error('tokens must be a finite number')
        }
        const at = Date.now()
        const traceId = fingerprint({ stage, verdict, tokens, at })
        const line = `${traceId} stage=${stage} tokens=${tokens} verdict=${verdict} at=${at}`
        service.recordWorklog({
          stage,
          output: line,
          check: `observability trace ${traceId}`,
          verdict,
          unverified: [],
          at,
        })
        return { traceId, line }
      },
    },
    {
      spec: '25',
      name: 'determinism',
      description: 'Report the fixed seed, iteration order, and pinned versions, and return the iteration in the configured order (spec 25).',
      parameters: {
        type: 'object',
        properties: {
          iteration: { type: 'array', description: 'Optional sequence to order deterministically.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['seed', 'iterationOrder', 'ordered', 'pinnedVersions'],
        properties: {
          seed: { type: 'number' },
          iterationOrder: { type: 'string', enum: ['stable', 'sorted'] },
          ordered: { type: 'array' },
          pinnedVersions: { type: 'object' },
        },
      },
      execute(args, { service }) {
        const { iteration } = args as { iteration?: unknown[] }
        const { iterationOrder, pinnedVersions } = service.config.determinism
        const base = Array.isArray(iteration) ? [...iteration] : []
        const ordered = iterationOrder === 'sorted' ? [...base].sort(stableCompare) : base
        return { seed: service.seed(), iterationOrder, ordered, pinnedVersions }
      },
    },
    {
      spec: '26',
      effectful: true,
      name: 'sandbox-boundaries',
      description: 'Check a path against the operation allow-list; an empty list allows reads and denies writes, and any escape is logged and aborted when the escape action is abort (spec 26).',
      parameters: {
        type: 'object',
        required: ['path', 'operation'],
        properties: {
          path: { type: 'string' },
          operation: { type: 'string', enum: ['read', 'write'] },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['allowed', 'escape', 'action'],
        properties: {
          allowed: { type: 'boolean' },
          escape: { type: 'boolean' },
          action: { type: 'string', enum: ['abort', 'halt'] },
        },
      },
      execute(args, { service }) {
        const { path, operation } = args as { path: string; operation: 'read' | 'write' }
        const list = service.config.sandbox.allowList[operation] ?? []
        // A DECLARED allow-list is fail-closed exact matching, so traversal, NUL and
        // case spellings all deny. An UNSET one is the read-open/write-closed default —
        // stated here rather than falling out of the empty-array branch.
        const allowed = list.length === 0 ? operation === 'read' : list.includes(path)
        const action = service.config.sandbox.escapeAction
        if (!allowed) {
          service.recordWorklog({
            stage: 'sandbox-boundaries',
            output: `${operation} on ${path} escaped the declared allow-list`,
            check: `sandbox.allowList.${operation}`,
            verdict: 'discarded',
            unverified: [`sandbox escape attempt: ${operation} ${path}`],
            at: Date.now(),
          })
          // An abort action is enforcement, not a report: returning the escape
          // object here would let the caller treat a denied path as a completed check.
          if (action === 'abort') {
            throw new Error(`sandbox escape: ${operation} on ${path} is outside the declared allow-list`)
          }
        }
        return { allowed, escape: !allowed, action }
      },
    },
    {
      spec: '29',
      name: 'dependency-pinning',
      description: 'Compare the current dependency versions against the pinned versions and report drift, blocking when any pin has drifted (spec 29).',
      parameters: {
        type: 'object',
        required: ['current'],
        properties: {
          current: { type: 'object', description: 'Current versions keyed by dependency name.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['drift', 'blocked'],
        properties: {
          drift: { type: 'array', items: { type: 'string' } },
          blocked: { type: 'boolean' },
        },
      },
      execute(args, { service }) {
        const { current } = args as { current: Record<string, string> }
        const pins = service.config.determinism.pinnedVersions
        const drift = Object.entries(pins)
          .filter(([key, pinned]) => current[key] !== pinned)
          .map(([key]) => key)
        return { drift, blocked: drift.length > 0 }
      },
    },
    {
      spec: '30',
      effectful: true,
      name: 'postmortem-format',
      description: 'Record a postmortem in what-failed / why / fix / catching-test form to the worklog (spec 30).',
      parameters: {
        type: 'object',
        required: ['whatFailed', 'why', 'fix', 'catchingTest'],
        properties: {
          whatFailed: { type: 'string' },
          why: { type: 'string' },
          fix: { type: 'string' },
          catchingTest: { type: 'string' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['recorded'],
        properties: {
          recorded: { type: 'boolean', enum: [true] },
        },
      },
      execute(args, { service }) {
        const { whatFailed, why, fix, catchingTest } = args as { whatFailed: string; why: string; fix: string; catchingTest: string }
        service.recordWorklog({
          stage: 'postmortem',
          output: `what-failed: ${whatFailed}; why: ${why}; fix: ${fix}`,
          check: `catching-test: ${catchingTest}`,
          verdict: 'discarded',
          unverified: [],
          at: Date.now(),
        })
        return { recorded: true }
      },
    },
  ]
}
