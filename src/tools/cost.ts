/**
 * Cost tools — specs 11, 60, 95, 97 (Gate 4d).
 */
import type { ToolSpec } from './shared.ts'

interface TaskClassCurve {
  tier: 'low' | 'mid' | 'high' | 'max'
  expectedCost: number
  accuracy: number
}

const TASK_CURVE: Record<string, TaskClassCurve | undefined> = {
  bounded: { tier: 'low', expectedCost: 10_000, accuracy: 0.7 },
  search: { tier: 'mid', expectedCost: 100_000, accuracy: 0.85 },
  multihop: { tier: 'high', expectedCost: 500_000, accuracy: 0.93 },
  open: { tier: 'max', expectedCost: 2_000_000, accuracy: 0.99 },
}

const TOKEN_RATE = 0.000002
const LATENCY_RATE = 0.000001
const RISK_UNIT_COST = 1000

const ACCURACY_TARGET = 0.9

export function costTools(): ToolSpec[] {
  return [
    {
      spec: '11',
      name: 'cost-accuracy-tradeoff',
      description: 'Map a task class to its effort tier and the deterministic expected-cost vs accuracy curve (spec 11).',
      parameters: {
        type: 'object',
        required: ['taskClass'],
        properties: {
          taskClass: { type: 'string', enum: ['bounded', 'search', 'multihop', 'open'], description: 'Task difficulty class.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['tier', 'expectedCost', 'accuracy'],
        properties: {
          tier: { type: 'string', enum: ['low', 'mid', 'high', 'max'], description: 'Effort tier for this task class.' },
          expectedCost: { type: 'number', description: 'Expected cost on the deterministic curve.' },
          accuracy: { type: 'number', description: 'Expected accuracy for this tier.' },
        },
      },
      execute(args): TaskClassCurve {
        const { taskClass } = args as { taskClass: string }
        const curve = TASK_CURVE[taskClass]
        if (curve === undefined) throw new Error(`cost-accuracy-tradeoff: unknown taskClass ${String(taskClass)}`)
        return { tier: curve.tier, expectedCost: curve.expectedCost, accuracy: curve.accuracy }
      },
    },
    {
      spec: '60',
      name: 'reasoning-cost-model',
      description: 'Deterministic reasoning-pass cost model: cost = tokens + latency + risk weight (spec 60).',
      parameters: {
        type: 'object',
        required: ['tokens', 'latencyMs', 'riskWeight'],
        properties: {
          tokens: { type: 'number', description: 'Token count for the pass.' },
          latencyMs: { type: 'number', description: 'Pass latency in milliseconds.' },
          riskWeight: { type: 'number', description: 'Risk weight admitted for the pass.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['cost'],
        properties: {
          cost: { type: 'number', description: 'Deterministic scheduling cost.' },
        },
      },
      execute(args): { cost: number } {
        const { tokens, latencyMs, riskWeight } = args as { tokens: number; latencyMs: number; riskWeight: number }
        const cost = tokens * TOKEN_RATE + latencyMs * LATENCY_RATE + riskWeight * RISK_UNIT_COST
        return { cost }
      },
    },
    {
      spec: '95',
      name: 'pass-cost-accounting',
      description: 'Account one reasoning pass into the cost ledger — tokens, producer+verifier latency, retries as risk — and return its running stage cost (spec 95).',
      parameters: {
        type: 'object',
        required: ['passId', 'tokens', 'latencyMs', 'retries', 'verifierMs'],
        properties: {
          passId: { type: 'string', description: 'Pass identity; ledger stage is pass:<passId>.' },
          tokens: { type: 'number', description: 'Tokens spent by the pass.' },
          latencyMs: { type: 'number', description: 'Producer latency in milliseconds.' },
          retries: { type: 'number', description: 'Retry count, booked as risk weight.' },
          verifierMs: { type: 'number', description: 'Verifier latency in milliseconds, added to producer latency.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['tokens', 'latencyMs', 'risk'],
        properties: {
          tokens: { type: 'number', description: 'Total tokens booked for this pass stage.' },
          latencyMs: { type: 'number', description: 'Total latency (producer + verifier) booked for this pass stage.' },
          risk: { type: 'number', description: 'Total risk weight booked for this pass stage.' },
        },
      },
      execute(args, { service }): { tokens: number; latencyMs: number; risk: number } {
        const { passId, tokens, latencyMs, retries, verifierMs } = args as { passId: string; tokens: number; latencyMs: number; retries: number; verifierMs: number }
        const stage = `pass:${passId}`
        service.recordCost({
          stage,
          tokens,
          latencyMs: latencyMs + verifierMs,
          riskWeight: retries,
          at: Date.now(),
        })
        return service.stageCost(stage)
      },
    },
    {
      spec: '97',
      name: 'pass-sla',
      description: 'Check a reasoning pass against its latency/token/accuracy SLA; on breach record a worklog line and degrade (spec 97).',
      parameters: {
        type: 'object',
        required: ['passId', 'latencyMs', 'tokens', 'accuracy'],
        properties: {
          passId: { type: 'string', description: 'Pass identity.' },
          latencyMs: { type: 'number', description: 'Observed pass latency in milliseconds.' },
          tokens: { type: 'number', description: 'Observed token usage.' },
          accuracy: { type: 'number', description: 'Observed pass accuracy.' },
          targets: {
            type: 'object',
            description: 'Optional per-target SLA overrides; omitted fields fall back to config defaults.',
            properties: {
              latencyMs: { type: 'number', description: 'Latency target override in milliseconds.' },
              tokens: { type: 'number', description: 'Token target override.' },
              accuracy: { type: 'number', description: 'Accuracy target override.' },
            },
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['breaches', 'action'],
        properties: {
          breaches: { type: 'array', items: { type: 'string' }, description: 'SLA dimensions that breached; empty when within target.' },
          action: { type: 'string', enum: ['ok', 'log+degrade'], description: 'Required action given the breaches.' },
        },
      },
      execute(args, { service }): { breaches: string[]; action: 'ok' | 'log+degrade' } {
        const { passId, latencyMs, tokens, accuracy, targets } = args as {
          passId: string
          latencyMs: number
          tokens: number
          accuracy: number
          targets?: { latencyMs?: number; tokens?: number; accuracy?: number }
        }
        const latencyTarget = targets?.latencyMs ?? service.config.budget.passTimeoutMs
        const tokensTarget = targets?.tokens ?? service.config.budget.stageTokenBudget
        const accuracyTarget = targets?.accuracy ?? ACCURACY_TARGET
        const breaches: string[] = []
        if (latencyMs > latencyTarget) breaches.push('latency')
        if (tokens > tokensTarget) breaches.push('tokens')
        if (accuracy < accuracyTarget) breaches.push('accuracy')
        const action: 'ok' | 'log+degrade' = breaches.length > 0 ? 'log+degrade' : 'ok'
        if (breaches.length > 0) {
          service.recordWorklog({
            stage: `pass:${passId}`,
            output: `SLA breach [${breaches.join(', ')}] — degraded`,
            check: `latency<=${latencyTarget}, tokens<=${tokensTarget}, accuracy>=${accuracyTarget}`,
            verdict: 'neutral',
            unverified: breaches,
            at: Date.now(),
          })
        }
        return { breaches, action }
      },
    },
  ]
}
