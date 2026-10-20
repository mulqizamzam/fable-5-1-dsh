/**
 * Per-session episode state.
 *
 * The budget counters describe ONE run, not the host. Two sessions sharing
 * one ctx.fable51 used to share a single set of counters, so one session's
 * turn/start reset another session's stage budget and fork allowance —
 * the other session then had a full budget again and could overspend.
 *
 * The host already stamps session identity on every surface the bundle
 * touches: Agent.session (dsh-agent runtime-types), ToolExecution.agent
 * (dsh-tools), GenerateOptions.sessionId (dsh-llm), and the session
 * lifecycle events (dsh-session). The episode store keys on that identity,
 * so each run's numbers belong to that run.
 */

/** Effort tier ladder (spec 6). */
export type EffortTier = 'low' | 'mid' | 'high' | 'max'

/** Reasoning-mode label (spec 15): interleaved thinking is not parallel reasoning. */
export type ReasoningMode = 'parallel' | 'sequential' | 'interleaved'

/**
 * Key for a call whose session the host did not name — a tool executed
 * outside an agent, or a unit test. It is a real bucket, not a wildcard:
 * one session's turn never resets it, so it cannot be reset by a stranger.
 */
export const DEFAULT_SESSION = 'default'

/** One run's mutable state. */
export interface EpisodeState {
  /** Per-stage token spend, charged against the stage budget (spec 22). */
  readonly stageTokens: Map<string, number>
  /** Previous turn's token count per stage, for the convergence distance (spec 58). */
  readonly previousTurnTokens: Map<string, number>
  /** Reasoning-mode label per pass id (spec 15). */
  readonly passLabels: Map<string, ReasoningMode>
  /** Escalation ladder cursor (spec 28). */
  rung: number
  /** Replan counter (spec 14). */
  replans: number
  /** Forks consumed in this stage's window (spec 96). */
  forksThisStage: number
  /** Merges consumed in this stage's window (spec 96). */
  mergesThisStage: number
  /** Current effort tier, escalated on task signal (spec 6). */
  effortTier: EffortTier
  /** Spec 6 escalates once per task; the transcript keeps the signal for every later step. */
  effortEscalated: boolean
  /** Per-turn convergence distances, oldest first (spec 58). */
  readonly turnDistances: number[]
  /** Turn index of the most recent new-evidence event, null when none (spec 58). */
  lastEvidenceTurn: number | null
  /** Turn counter driving the convergence window (spec 58). */
  turnCount: number
  /**
   * The turn the last pre-step observed (spec 4).
   *
   * A stage transition is a new turn: the agent moved to another unit of
   * work. A step inside the same turn is not a transition, and narrating it
   * is the spam this spec exists to kill.
   */
  lastObservedTurn: number | null
  /** Verification gates that failed in this run (spec 4). */
  failingGates: number
  /** How many of those failures have already been narrated (spec 4). */
  reportedFailingGates: number
  /** Progress records: one per stage transition or gate failure (spec 4). */
  readonly progress: ProgressRecord[]
  /** Parallel passes currently running (spec 55). */
  inFlight: number
  /** Callers waiting for a parallel pass slot (spec 55). */
  readonly waiters: Array<() => void>
  /** Highest simultaneous parallel passes seen (spec 55). */
  peakInFlight: number
  /** How many callers were ever queued for a slot (spec 55). */
  queuedTotal: number
}

/**
 * A progress record (spec 4).
 *
 * `stage-transition` means the run moved to another unit of work;
 * `gate-fail` means a verification gate failed. Nothing else is narrated:
 * a per-step line is noise that buries the trail it sits in.
 */
export interface ProgressRecord {
  readonly kind: 'stage-transition' | 'gate-fail'
  readonly detail: string
  readonly at: number
}

/** How many progress records one run keeps. */
export const PROGRESS_CAP = 200

function createEpisode(effortTier: EffortTier): EpisodeState {
  return {
    stageTokens: new Map<string, number>(),
    previousTurnTokens: new Map<string, number>(),
    passLabels: new Map<string, ReasoningMode>(),
    rung: 0,
    replans: 0,
    forksThisStage: 0,
    mergesThisStage: 0,
    effortTier,
    effortEscalated: false,
    turnDistances: [],
    lastEvidenceTurn: null,
    turnCount: 0,
    lastObservedTurn: null,
    failingGates: 0,
    reportedFailingGates: 0,
    progress: [],
    inFlight: 0,
    waiters: [],
    peakInFlight: 0,
    queuedTotal: 0,
  }
}

/**
 * The per-session episodes, keyed by session id.
 *
 * Bounded: a long-lived host must not grow one episode per session for the
 * process lifetime. Eviction is oldest-first over insertion order.
 */
export class EpisodeStore {
  private readonly episodes = new Map<string, EpisodeState>()

  constructor(
    private readonly defaultEffortTier: EffortTier,
    private readonly max = 64,
  ) {}

  /** The episode for one session, created on first use. */
  get(key: string): EpisodeState {
    const existing = this.episodes.get(key)
    if (existing !== undefined) return existing
    const created = createEpisode(this.defaultEffortTier)
    this.episodes.set(key, created)
    while (this.episodes.size > this.max) {
      const oldest = this.episodes.keys().next()
      if (oldest.done === true) break
      this.episodes.delete(oldest.value)
    }
    return created
  }

  /**
   * Start one session's TURN over: the stage budget, the fork/merge window
   * and the once-per-task effort escalation. The escalation ladder, the
   * replan count and the convergence window survive a turn — they measure
   * the run, not the turn.
   */
  resetTurn(key: string): EpisodeState {
    const episode = this.get(key)
    episode.stageTokens.clear()
    episode.forksThisStage = 0
    episode.mergesThisStage = 0
    episode.effortEscalated = false
    return episode
  }

  /**
   * Start one session's RUN over: a new session must not inherit the previous
   * run's escalation rung, replan count or convergence window.
   */
  resetSession(key: string): EpisodeState {
    const fresh = createEpisode(this.defaultEffortTier)
    this.episodes.set(key, fresh)
    return fresh
  }

  /** Drop one session's episode entirely (session disposed). */
  delete(key: string): void {
    this.episodes.delete(key)
  }

  get size(): number {
    return this.episodes.size
  }

  keys(): readonly string[] {
    return [...this.episodes.keys()]
  }
}
