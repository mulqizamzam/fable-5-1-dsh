/**
 * Escalation tools — specs 8, 14, 27, 28, 52, 72, 81 (Gate 4e).
 *
 * Clarification halts (8), the replan budget (14), the human-in-the-loop
 * gate (27), the escalation ladder (28), abort criteria (52), the pass
 * timeout (72), and the pass retry policy (81). Tools 14, 28 and 72 advance
 * service state and are marked effectful: they bypass the cache so every call
 * moves the counter instead of replaying the first output (spec 19).
 */
import type { ToolSpec } from './shared.ts'
import type { ApprovalRequest, EscalationRung } from '../policy-service.ts'

const LADDER: readonly EscalationRung[] = ['retry', 'replan', 'downgrade', 'ask']

function rungAt(index: number): EscalationRung {
  return LADDER[Math.min(Math.max(index, 0), LADDER.length - 1)] ?? 'ask'
}

export function escalationTools(): ToolSpec[] {
  return [
    {
      spec: '8',
      name: 'spec-clarification',
      description: 'Halt and ask the user when the spec carries ≥2 readings, an explicit conflict, or a third replan (spec 8).',
      parameters: {
        type: 'object',
        required: ['readings'],
        properties: {
          readings: { type: 'array', items: { type: 'string' }, description: 'Distinct readings of the requirement under consideration.' },
          conflict: { type: 'boolean', description: 'Whether the readings contradict each other.' },
          replanCount: { type: 'number', description: 'Replans already spent on this spec.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['action', 'reason'],
        properties: {
          action: { type: 'string', enum: ['ask', 'proceed'] },
          reason: { type: 'string' },
        },
      },
      execute(args) {
        const { readings, conflict, replanCount } = args as {
          readings: string[]
          conflict?: boolean
          replanCount?: number
        }
        const list = Array.isArray(readings) ? readings : []
        // A stringly-typed count reads as zero replans and silently proceeds.
        if (replanCount !== undefined && (typeof replanCount !== 'number' || !Number.isFinite(replanCount))) {
          throw new Error('replanCount must be a finite number')
        }
        const replans = typeof replanCount === 'number' ? replanCount : 0
        const reasons: string[] = []
        if (list.length >= 2) reasons.push(`${list.length} competing readings`)
        if (conflict === true) reasons.push('explicit requirement conflict')
        if (replans >= 3) reasons.push(`replan count ${replans} reached the third replan`)
        if (reasons.length === 0) {
          return { action: 'proceed', reason: 'single reading, no conflict, replan budget intact' }
        }
        return { action: 'ask', reason: `halt and ask the user: ${reasons.join('; ')}` }
      },
    },
    {
      spec: '14',
      effectful: true,
      name: 'replan-budget',
      description: 'Account a replan against the budget (max 2); a third replan escalates (spec 14).',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          replanCount: { type: 'number', description: 'Advisory caller-reported replan count; the service budget counter decides.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['allowed', 'escalate', 'count'],
        properties: {
          allowed: { type: 'boolean' },
          escalate: { type: 'boolean' },
          count: { type: 'number' },
        },
      },
      execute(_args, { service }) {
        // The service counter is the source of truth: the argument is
        // advisory only, so a caller cannot under- or over-report the budget.
        const { count, escalate } = service.replan()
        const max = service.config.budget.maxReplans
        return {
          allowed: count <= max,
          escalate,
          count,
        }
      },
    },
    {
      spec: '27',
      name: 'human-in-the-loop',
      description: 'Require human approval before an irreversible or external action, or one costing above the HITL ceiling (spec 27).',
      parameters: {
        type: 'object',
        required: ['action', 'irreversible', 'external', 'estimatedCost'],
        properties: {
          action: { type: 'string', description: 'The action under consideration.' },
          irreversible: { type: 'boolean', description: 'Whether the action cannot be undone.' },
          external: { type: 'boolean', description: 'Whether the action has effects outside the sandbox.' },
          estimatedCost: { type: 'number', description: 'Estimated cost of the action.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['required', 'reason'],
        properties: {
          required: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      execute(args, { service }) {
        const { action, irreversible, external, estimatedCost } = args as Partial<ApprovalRequest>
        // Fail closed: an undeclared risk flag is itself the risk (spec 27).
        const hasIrreversible = typeof irreversible === 'boolean'
        const hasExternal = typeof external === 'boolean'
        const hasCost = typeof estimatedCost === 'number' && Number.isFinite(estimatedCost)
        if (!hasIrreversible || !hasExternal || !hasCost) {
          const absent = [
            ...(hasIrreversible ? [] : ['irreversible']),
            ...(hasExternal ? [] : ['external']),
            ...(hasCost ? [] : ['estimatedCost']),
          ]
          return { required: true, reason: `risk flags not supplied (${absent.join(', ')}) — approval required` }
        }
        return service.requiresApproval({
          action: action ?? '',
          irreversible,
          external,
          estimatedCost,
        })
      },
    },
    {
      spec: '28',
      effectful: true,
      name: 'escalation-ladder',
      description: 'Advance the escalation ladder retry→replan→downgrade→ask, one rung per failure; a success reads the current rung (spec 28).',
      parameters: {
        type: 'object',
        required: ['failed'],
        properties: {
          failed: { type: 'boolean', description: 'Whether the pass or stage failed; one failure advances one rung.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['rung', 'ladder'],
        properties: {
          rung: { type: 'string', enum: ['retry', 'replan', 'downgrade', 'ask'] },
          ladder: { type: 'array', items: { type: 'string', enum: ['retry', 'replan', 'downgrade', 'ask'] } },
        },
      },
      execute(args, { service }) {
        const { failed } = args as { failed: boolean }
        // A truthy non-boolean would be read as a success: the ladder would not
        // advance on a failure that happened.
        if (typeof failed !== 'boolean') throw new Error('failed must be a boolean')
        const rung = failed ? service.nextRung() : rungAt(service.rung)
        return { rung, ladder: [...LADDER] }
      },
    },
    {
      spec: '52',
      name: 'abort-criteria',
      description: 'Abort a reasoning pass on budget overrun or contradiction; proceed on convergence (spec 52).',
      parameters: {
        type: 'object',
        required: ['budgetExceeded', 'converged', 'contradiction'],
        properties: {
          budgetExceeded: { type: 'boolean', description: 'Whether the pass spent more than its budget.' },
          converged: { type: 'boolean', description: 'Whether the pass converged.' },
          contradiction: { type: 'boolean', description: 'Whether the pass output contradicts its inputs.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['abort', 'reason'],
        properties: {
          abort: { type: 'boolean' },
          reason: { type: 'string' },
        },
      },
      execute(args) {
        const { budgetExceeded, converged, contradiction } = args as {
          budgetExceeded: boolean
          converged: boolean
          contradiction: boolean
        }
        // Every one of these flags is a safety gate: a truthy non-boolean must
        // not read as the safe branch.
        for (const flag of [budgetExceeded, converged, contradiction]) {
          if (typeof flag !== 'boolean') throw new Error('budgetExceeded, converged and contradiction must be booleans')
        }
        if (budgetExceeded) return { abort: true, reason: 'budget exceeded' }
        if (contradiction) return { abort: true, reason: 'contradiction detected' }
        if (converged) return { abort: false, reason: 'converged' }
        return { abort: false, reason: 'no abort criterion met' }
      },
    },
    {
      spec: '72',
      effectful: true,
      name: 'pass-timeout',
      description: 'Enforce the per-pass deadline: on breach, snapshot the pass as unverified and escalate (spec 72).',
      parameters: {
        type: 'object',
        required: ['passId', 'elapsedMs'],
        properties: {
          passId: { type: 'string', description: 'The pass being timed.' },
          elapsedMs: { type: 'number', description: 'Wall-clock time the pass has consumed.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['passed', 'elapsedMs'],
        properties: {
          passed: { type: 'boolean' },
          elapsedMs: { type: 'number' },
          snapshotId: { type: 'string' },
        },
      },
      execute(args, { service }) {
        const { passId, elapsedMs } = args as { passId: string; elapsedMs: number }
        // A non-finite elapsed would read as "within the deadline": refuse it instead.
        if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
          throw new Error('elapsedMs must be a finite number')
        }
        const deadline = service.config.budget.passTimeoutMs
        if (elapsedMs <= deadline) {
          return { passed: true, elapsedMs }
        }
        const snapshot = service.snapshots.create(`${passId}-timeout`, {
          passId,
          elapsedMs,
          verdict: 'unverified',
        })
        service.recordWorklog({
          stage: `pass:${passId}`,
          output: `pass ${passId} breached the ${deadline}ms deadline at ${elapsedMs}ms`,
          check: 'pass deadline',
          verdict: 'discarded',
          unverified: [`pass ${passId} timed out after ${elapsedMs}ms`],
          at: Date.now(),
        })
        return { passed: false, elapsedMs, snapshotId: snapshot.id }
      },
    },
    {
      spec: '81',
      name: 'pass-retry-policy',
      description: 'Cap pass retries at 2 with exponential backoff; a third attempt aborts (spec 81).',
      parameters: {
        type: 'object',
        required: ['attempt'],
        properties: {
          attempt: { type: 'number', description: '1-based attempt number.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['retry', 'backoffMs', 'abort'],
        properties: {
          retry: { type: 'boolean' },
          backoffMs: { oneOf: [{ type: 'number' }, { type: 'null' }] },
          abort: { type: 'boolean' },
        },
      },
      execute(args, { service }) {
        const { attempt } = args as { attempt: number }
        // attempt < 1 or fractional would buy a longer backoff for less work.
        if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
          throw new Error('attempt must be an integer of at least 1')
        }
        const max = service.config.budget.maxPassRetries
        return {
          retry: attempt <= max,
          backoffMs: attempt <= max ? 2 ** (attempt - 1) * 1000 : null,
          abort: attempt > max,
        }
      },
    },
  ]
}
