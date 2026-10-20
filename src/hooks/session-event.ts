/**
 * session/event hook — specs 10, 18, 25, 29, 30, 46, 88.
 *
 * Verified contract: `session/event` is EMIT-mode with payload
 * `(session, event)`; `event.type` is a durable type (turn/start, turn/end,
 * step/end, tool/result, compaction/*, ...). Lifecycle start/end rides on
 * `session/created` / `session/disposed`.
 *
 * The session is the unit of a run: its turn/start resets ITS OWN budget and
 * fork window, never another session's.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Fable51Policy } from '../policy-service.ts'
import { sessionKeyOf } from '../state/session-key.ts'

interface SessionEventLike {
  type?: string
}

export function wireSessionEvent(ctx: Context): void {
  // Disambiguates checkpoint ids that share a millisecond timestamp.
  let turnEndSeq = 0

  // spec 29: dependency pins recorded at session start; drift blocks.
  ctx.on('session/created', (session: unknown) => {
    const svc = ctx.fable51 as Fable51Policy
    // The service is host-wide and outlives the session: a new session must not
    // start on the previous session's escalation rung and replan count — and
    // must not reset them for the sessions still running.
    svc.resetEpisodeState(sessionKeyOf(session))
    const pinned = svc.config.determinism.pinnedVersions
    svc.recordWorklog({
      stage: 'session:start',
      output: `pins recorded: ${Object.entries(pinned).map(([k, v]) => `${k}=${v}`).join(', ')}`,
      check: 'dependency pinning',
      verdict: 'neutral',
      // The pins are config constants; nothing compares them against the running host.
      unverified: ['pins were not compared against the running host'],
      at: Date.now(),
    })
  })

  ctx.on('session/event', (session: unknown, event: Readonly<SessionEventLike>) => {
    const svc = ctx.fable51 as Fable51Policy
    const key = sessionKeyOf(session)
    switch (event.type) {
      case 'turn/start':
        // new stage: reset fork/merge counters (spec 96 budget window) and the
        // stage budget (spec 22) — for THIS session only. Another session
        // running in the same host keeps its own budget.
        svc.resetTurnState(key)
        break
      case 'turn/end': {
        // spec 38/46: checkpoint at the turn boundary; spec 10: handoff state.
        const episode = svc.episode(key)
        const snapshot = svc.snapshots.create(`turn-end-${Date.now()}-${turnEndSeq++}`, {
          gates: svc.gateLog.length,
          worklog: svc.worklog.length,
          replans: episode.replans,
          rung: episode.rung,
        })
        svc.recordWorklog({
          stage: 'session:turn-end',
          output: `checkpoint ${snapshot.id} (${snapshot.hash.slice(0, 16)}…)`,
          check: 'reasoning checkpoint + handoff',
          verdict: 'contributed',
          unverified: [],
          at: Date.now(),
        })
        break
      }
      default:
        break
    }
  })

  // spec 30: postmortem emission on session end; spec 10: handoff persistence.
  ctx.on('session/disposed', (session: unknown) => {
    const svc = ctx.fable51 as Fable51Policy
    const key = sessionKeyOf(session)
    // Persist the handoff state (stage map + last checkpoint hash + pins)
    // BEFORE the closing postmortem line, so the snapshot reflects the run.
    const handoff = svc.handoffSnapshot(key)
    svc.recordWorklog({
      stage: 'session:end',
      output: `handoff ${handoff.id} (${handoff.hash.slice(0, 16)}…) postmortem: gates=${svc.gateLog.length} worklog=${svc.worklog.length} replans=${svc.episode(key).replans} rung=${svc.episode(key).rung}`,
      check: 'postmortem format',
      verdict: 'contributed',
      unverified: [],
      at: Date.now(),
    })
  })
}
