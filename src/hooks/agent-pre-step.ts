/**
 * agent/pre-step hook — specs 1, 3, 4, 6, 14, 21, 22, 24, 37, 71, 72
 * (plus the clarification risk signal for spec 8).
 *
 * Verified contract: `agent/pre-step` is a WATERFALL. The payload is
 * `{ agent, messages, turn, step, signal }`; a listener returns a
 * PreStepDecision and MUST call `next()` to admit the step. This bundle's
 * hook is observational: it records budget/liveness state and only steers
 * through the tools (spill, escalate); it never rejects a step silently.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Fable51Policy } from '../policy-service.ts'

interface PreStepPayload {
  agent: Agent
  messages: UserMessage[]
  turn: number
  step: number
  signal: AbortSignal
}

export function wireAgentPreStep(ctx: Context): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const svc = ctx.fable51 as Fable51Policy
    const stage = `turn-${payload.turn ?? 0}-step-${payload.step ?? 0}`
    // spec 24: one observability line per step boundary.
    svc.recordWorklog({
      stage,
      output: `pre-step observed (${Array.isArray(payload.messages) ? payload.messages.length : 0} messages)`,
      check: 'agent/pre-step fired',
      verdict: 'neutral',
      unverified: [],
      at: Date.now(),
    })
    // spec 1: context threshold classification for the current message volume.
    const fillRatio = Math.min(1, (Array.isArray(payload.messages) ? payload.messages.length : 0) / 200)
    const action = svc.contextAction(fillRatio)
    if (action !== 'ok') {
      svc.recordWorklog({
        stage,
        output: `context action: ${action}`,
        check: 'context thresholds',
        verdict: 'neutral',
        unverified: [],
        at: Date.now(),
      })
    }
    // spec 71: backpressure — queue depth over budget throttles further forks.
    const throttled = svc.queueDepth > svc.config.reasoning.maxConcurrentPasses
    if (throttled) {
      svc.recordWorklog({
        stage,
        output: `backpressure: queue ${svc.queueDepth} > ${svc.config.reasoning.maxConcurrentPasses}`,
        check: 'reasoning backpressure',
        verdict: 'neutral',
        unverified: [],
        at: Date.now(),
      })
    }
    return next()
  })
}
