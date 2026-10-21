/**
 * agent/pre-step hook, specs 1, 3, 4, 6, 14, 21, 22, 24, 37, 71, 72
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

/** Plain-text projection of a message's content, for signal detection (spec 6). */
function messageText(message: UserMessage): string {
  const content = (message as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block === 'object' && block !== null && 'text' in block ? String((block as { text?: unknown }).text ?? '') : ''))
      .join(' ')
  }
  return ''
}

export function wireAgentPreStep(ctx: Context): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision> => {
    const svc = ctx.fable51 as Fable51Policy
    const stage = `turn-${payload.turn ?? 0}-step-${payload.step ?? 0}`
    // Cordis waterfalls do not catch listener throws, so every statement here is
    // contained: a plugin fault must be logged, never veto the step.
    try {
      // The run this step belongs to: the agent carries the session, and a
      // session's progress, budget and ladder are its own.
      const key = svc.scopeKeyOfAgent(payload.agent)
      const episode = svc.episode(key)
      const turn = typeof payload.turn === 'number' ? payload.turn : 0

      // spec 4: a stage transition is a new turn, the run moved to another
      // unit of work. A step inside the same turn is not a transition, and
      // narrating every step is the spam this spec exists to kill.
      const transition = episode.lastObservedTurn !== turn
      episode.lastObservedTurn = turn

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
        }, key)
      }
      // spec 6: pre-first-tool effort escalation, a search/multi-hop/ambiguity
      // signal in the step's messages raises the effort tier one rung.
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const text = messages.map(messageText).join(' ')
      const signals = svc.config.effort.escalateOn.filter((signal) => text.includes(signal))
      // The escalation belongs to the session whose agent took the step: one
      // session's signal must not raise another session's effort tier.
      // Without this guard the accumulated transcript re-triggers the same signal
      // on every later step and pins the tier at `max` within a single task.
      if (signals.length > 0 && episode.effortEscalated !== true) {
        episode.effortEscalated = true
        const { from, to, escalated } = svc.escalateEffort(key)
        if (escalated) {
          svc.recordWorklog({
            stage,
            output: `effort escalated ${from} → ${to} on signals: ${signals.join(', ')}`,
            check: 'effort escalation',
            verdict: 'neutral',
            unverified: [],
            at: Date.now(),
          }, key)
        }
      }

      // spec 4: narrate what the operator needs, the run moved, or a gate
      // failed. Nothing else earns a line.
      if (transition) {
        svc.recordProgress(key, 'stage-transition', `turn ${turn} started`)
        svc.recordWorklog({
          stage,
          output: `stage transition: turn ${turn} started`,
          check: 'progress record',
          verdict: 'neutral',
          unverified: [],
          at: Date.now(),
        }, key)
      }
      const failedGates = episode.failingGates - episode.reportedFailingGates
      if (failedGates > 0) {
        svc.recordProgress(key, 'gate-fail', `${failedGates} verification gate(s) failed`)
        svc.markGatesReported(key)
        svc.recordWorklog({
          stage,
          output: `gate failure: ${failedGates} gate(s) failed`,
          check: 'progress record',
          verdict: 'discarded',
          unverified: ['a verification gate failed'],
          at: Date.now(),
        }, key)
      }
    } catch (err) {
      ctx.logger('fable51').error(`agent/pre-step fault, admitting the step: ${String(err)}`)
    }
    return next()
  })
}
