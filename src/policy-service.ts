/**
 * fable51 — the policy service (PRD §3.1).
 *
 * Holds the validated config plus every piece of durable bundle state: the
 * immutable policy registry (100), pass lineage (69/87/94), the
 * content-addressed cache (43/65), the snapshot index (38/46/77/83), the
 * verification-gate log (5/12), the worklog (13), and the cost ledger (95).
 *
 * Registered as `ctx.fable51`; injects tools, llm, sessions.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveConfig } from './config/defaults.ts'
import type { Fable51Config } from './config/schema.ts'
import { wireAgentPreStep } from './hooks/agent-pre-step.ts'
import { wireLlmStream } from './hooks/llm-stream.ts'
import { wireSessionEvent } from './hooks/session-event.ts'
import { wireToolsPreExecute } from './hooks/tools-pre-execute.ts'
import { wireToolsResult } from './hooks/tools-result.ts'
import { registerTools } from './tools/index.ts'
import { PassLineage } from './state/lineage.ts'
import { PolicyRegistry } from './state/registry.ts'
import { ReasonCache } from './state/cache.ts'
import { SnapshotStore, type Snapshot } from './state/snapshots.ts'
import { EpisodeStore, PROGRESS_CAP, type EpisodeState, type EffortTier, type ProgressRecord, type ReasoningMode } from './state/episode.ts'
import type { GateResult } from './types/gate.ts'
import type { PassScore, PassVerdict, ReasoningPass } from './types/pass.ts'

export interface WorklogEntry {
  readonly stage: string
  readonly output: string
  readonly check: string
  readonly verdict: PassVerdict
  readonly unverified: readonly string[]
  readonly at: number
}

export interface CostLedgerEntry {
  readonly stage: string
  readonly tokens: number
  readonly latencyMs: number
  readonly riskWeight: number
  readonly at: number
}

export type ProvenanceTag =
  | { readonly kind: 'fetch'; readonly url: string }
  | { readonly kind: 'mem'; readonly era: string }
  | { readonly kind: 'inf' }

export type EscalationRung = 'retry' | 'replan' | 'downgrade' | 'ask'

export type { EffortTier, EpisodeState, ReasoningMode }

export interface ApprovalRequest {
  readonly action: string
  readonly irreversible: boolean
  readonly external: boolean
  readonly estimatedCost: number
}

const LADDER: readonly EscalationRung[] = ['retry', 'replan', 'downgrade', 'ask']
const EFFORT_LADDER = ['low', 'mid', 'high', 'max'] as const

// Bundle-state caps. Not yet configurable — no config key exists for them; these
// exist only so a long-lived host cannot grow state for the process lifetime.
/** Worklog ring cap (spec 13): newest kept, oldest trimmed. */
const WORKLOG_CAP = 5000
/** Verification-gate log ring cap (specs 5/12). */
const GATE_LOG_CAP = 5000
/** Cost-ledger ring cap (spec 95). */
const COST_LEDGER_CAP = 5000
/** Per-turn convergence ring floor (spec 58); raised to cover the configured window. */
const TURN_DISTANCES_CAP = 64
/** Cache FIFO cap (specs 43/65). */
const CACHE_CAP = 2000
/** Snapshot FIFO cap (specs 38/46). */
const SNAPSHOT_CAP = 256

/** Ring append: trims the oldest entries past `cap`, keeping the newest. */
function pushCapped<T>(items: T[], entry: T, cap: number): T {
  items.push(entry)
  if (items.length > cap) items.splice(0, items.length - cap)
  return entry
}

export class Fable51Policy extends Service {
  static inject = ['tools', 'llm', 'sessions'] as const

  // Schema value only: Schemastery validates at load; the constructor's own
  // fail-loud validator (resolveConfig) owns the field-path contract.
  static Config = z.object({
    context: z.object({
      compactAt: z.number().default(0.7),
      dropAt: z.number().default(0.85),
      spillAt: z.number().default(0.9),
      spillPath: z.string().default('.dsh/fable-spill'),
    }),
    effort: z.object({
      defaultTier: z.union(['low', 'mid', 'high', 'max'] as const).default('mid'),
      // Must mirror defaults.ts: a schema default of [] would overwrite the
      // real default whenever the host materializes Config (spec 6).
      escalateOn: z.array(z.union(['search', 'multihop', 'ambiguity'] as const)).default(['search', 'multihop', 'ambiguity']),
      costCeiling: z.number().default(2_000_000),
    }),
    budget: z.object({
      maxReplans: z.number().default(2),
      maxPassRetries: z.number().default(2),
      passTimeoutMs: z.number().default(120_000),
      stageTimeoutMs: z.number().default(600_000),
      stageTokenBudget: z.number().default(400_000),
      maxForkDepth: z.number().default(4),
      maxForksPerStage: z.number().default(8),
      maxMergesPerStage: z.number().default(8),
    }),
    reasoning: z.object({
      maxConcurrentPasses: z.number().default(4),
      convergenceDelta: z.number().default(0.02),
      convergenceTurns: z.number().default(3),
      decayLambda: z.number().default(0.15),
      quorumThreshold: z.number().default(0.6),
    }),
    determinism: z.object({
      seed: z.number().default(20261011),
      iterationOrder: z.union(['stable', 'sorted'] as const).default('stable'),
      pinnedVersions: z.dict(z.string(), z.string()).default({ dsh: '23c78fcdd5ee0b497a77ca356608c51093c74bb9' }),
    }),
    sandbox: z.object({
      allowList: z.dict(z.array(z.string())),
      escapeAction: z.union(['abort', 'halt'] as const).default('abort'),
    }),
    hitl: z.object({
      requireOnIrreversible: z.boolean().default(true),
      requireOnExternal: z.boolean().default(true),
      requireAboveCost: z.number().default(500_000),
    }),
    observability: z.object({
      traceLevel: z.union(['stage', 'pass', 'both'] as const).default('stage'),
      logFormat: z.union(['line', 'json'] as const).default('line'),
    }),
    registry: z.object({
      policies: z.array(z.object({
        id: z.string(),
        version: z.string(),
        owner: z.string(),
        active: z.boolean(),
        hash: z.string(),
      })).default([]),
    }),
  })

  readonly config: Fable51Config
  readonly registry = new PolicyRegistry()
  readonly lineage = new PassLineage()
  readonly cache = new ReasonCache(CACHE_CAP)
  readonly snapshots = new SnapshotStore(SNAPSHOT_CAP)
  readonly gateLog: GateResult[] = []
  readonly worklog: WorklogEntry[] = []
  readonly costLedger: CostLedgerEntry[] = []

  /**
   * Per-session run state (specs 6, 14, 15, 22, 28, 58, 96).
   *
   * The counters describe one run, not the host: two sessions in one host
   * used to share them, so one session's turn/start reset the other's stage
   * budget and fork allowance. The audit rings above stay host-wide — a long
   * run is audited at host level — but a budget belongs to the run spending it.
   */
  readonly episodes: EpisodeStore

  /** Handoff id discriminator: a constant id made every session overwrite the last. */
  private handoffSeq = 0

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'fable51')
    this.config = resolveConfig(config)
    this.episodes = new EpisodeStore(this.config.effort.defaultTier)
    for (const policy of this.config.registry.policies) this.registry.register(policy)
    // PRD §3: hooks and tools wire at service construction; cordis disposes
    // listeners and tool registrations with the owning fiber automatically.
    wireAgentPreStep(ctx)
    wireToolsPreExecute(ctx)
    wireToolsResult(ctx)
    wireLlmStream(ctx)
    wireSessionEvent(ctx)
    const toolCount = registerTools(ctx)
    ctx.logger('fable51').info(`fable-5-1 loaded — ${toolCount} tools registered`)
  }

  /**
   * The run state for one session. Created on first use; a session that has
   * never run gets a fresh episode rather than a shared one.
   */
  episode(key: string): EpisodeState {
    return this.episodes.get(key)
  }

  // ---- spec 4: progress reporting ----
  /**
   * Record one progress note (spec 4).
   *
   * The bundle narrates two things and only two: the run moved to another
   * unit of work, and a verification gate failed. A line per step is the
   * narration spam this record replaces.
   */
  recordProgress(key: string, kind: ProgressRecord['kind'], detail: string): ProgressRecord {
    const episode = this.episodes.get(key)
    const record: ProgressRecord = { kind, detail, at: Date.now() }
    pushCapped(episode.progress, record, PROGRESS_CAP)
    return record
  }

  /**
   * Mark this run's gate failures as narrated (spec 4).
   *
   * Separate from recordProgress: a stage transition must not silently
   * swallow a gate failure that has not been told yet.
   */
  markGatesReported(key: string): void {
    const episode = this.episodes.get(key)
    episode.reportedFailingGates = episode.failingGates
  }

  /** The progress records of one run, oldest first. */
  progress(key: string): readonly ProgressRecord[] {
    return this.episodes.get(key).progress
  }

  // ---- spec 55: reasoning bandwidth ----
  /**
   * Take a parallel-pass slot (spec 55).
   *
   * Excess is queued, not denied: the caller waits for a slot instead of
   * being turned away, so a burst of parallel work is throttled rather than
   * refused.
   */
  async acquireSlot(key: string, signal?: AbortSignal): Promise<boolean> {
    const episode = this.episodes.get(key)
    const cap = this.config.reasoning.maxConcurrentPasses
    if (episode.inFlight < cap) {
      episode.inFlight += 1
      if (episode.inFlight > episode.peakInFlight) episode.peakInFlight = episode.inFlight
      return true
    }
    // Over the cap: queue behind the passes already running.
    episode.queuedTotal += 1
    return new Promise<boolean>((resolve) => {
      let settled = false
      const grant = (): void => {
        if (settled) return
        settled = true
        resolve(true)
      }
      const abandon = (): void => {
        if (settled) return
        settled = true
        episode.queuedTotal -= 1
        resolve(false)
      }
      episode.waiters.push(grant)
      if (signal === undefined) return
      // An aborted caller must not hold a queue place forever.
      if (signal.aborted) {
        const index = episode.waiters.indexOf(grant)
        if (index >= 0) episode.waiters.splice(index, 1)
        abandon()
        return
      }
      signal.addEventListener('abort', () => {
        const index = episode.waiters.indexOf(grant)
        if (index >= 0) episode.waiters.splice(index, 1)
        abandon()
      }, { once: true })
    })
  }

  /**
   * Give a parallel-pass slot back (spec 55).
   *
   * A queued caller takes the freed slot directly, so the running count never
   * dips below the cap while somebody is waiting for it.
   */
  releaseSlot(key: string): void {
    const episode = this.episodes.get(key)
    const next = episode.waiters.shift()
    if (next !== undefined) {
      next()
      return
    }
    episode.inFlight = Math.max(0, episode.inFlight - 1)
  }

  /** The parallel-pass state of one run (spec 55). */
  bandwidth(key: string): { inFlight: number; cap: number; queued: number; peak: number; saturated: boolean } {
    const episode = this.episodes.get(key)
    const cap = this.config.reasoning.maxConcurrentPasses
    return {
      inFlight: episode.inFlight,
      cap,
      queued: episode.waiters.length,
      peak: episode.peakInFlight,
      saturated: episode.inFlight >= cap,
    }
  }

  /**
   * Executions currently holding a parallel-pass slot (spec 55).
   *
   * A call can be denied after the slot was taken — another gate may refuse
   * it, or the caller may abort — so the holder is tracked per execution and
   * released exactly once, by whoever reports the result.
   */
  private readonly slotHolders = new WeakMap<object, string>()

  /** Remember that this execution holds a slot, and which run's. */
  holdSlot(exec: object, key: string): void {
    this.slotHolders.set(exec, key)
  }

  /** Release the slot this execution holds, if any; returns the run's key. */
  releaseHeldSlot(exec: object): string | undefined {
    const key = this.slotHolders.get(exec)
    if (key === undefined) return undefined
    this.slotHolders.delete(exec)
    this.releaseSlot(key)
    return key
  }

  // ---- spec 1: context thresholds ----
  contextAction(fillRatio: number): 'ok' | 'compact' | 'drop' | 'spill' {
    if (fillRatio >= this.config.context.spillAt) return 'spill'
    if (fillRatio >= this.config.context.dropAt) return 'drop'
    if (fillRatio >= this.config.context.compactAt) return 'compact'
    return 'ok'
  }

  // ---- spec 22: per-stage token budget ----
  addStageTokens(key: string, stage: string, tokens: number): { used: number; alert: boolean; stop: boolean } {
    const episode = this.episodes.get(key)
    const used = (episode.stageTokens.get(stage) ?? 0) + tokens
    episode.stageTokens.set(stage, used)
    const limit = this.config.budget.stageTokenBudget
    return { used, alert: used >= limit * 0.8, stop: used >= limit }
  }

  // ---- spec 14 / 28: replan budget + escalation ladder ----
  replan(key: string): { count: number; escalate: boolean } {
    const episode = this.episodes.get(key)
    episode.replans += 1
    return { count: episode.replans, escalate: episode.replans > this.config.budget.maxReplans }
  }

  nextRung(key: string): EscalationRung {
    const episode = this.episodes.get(key)
    const rung = LADDER[Math.min(episode.rung, LADDER.length - 1)]!
    episode.rung += 1
    return rung
  }

  // ---- spec 96: fork/merge budget ----
  canFork(key: string, depth: number): boolean {
    const episode = this.episodes.get(key)
    return depth < this.config.budget.maxForkDepth && episode.forksThisStage < this.config.budget.maxForksPerStage
  }

  canMerge(key: string): boolean {
    return this.episodes.get(key).mergesThisStage < this.config.budget.maxMergesPerStage
  }

  /**
   * Per-session episode state (specs 14/28/58/96).
   *
   * The service outlives the session, so a fresh session must not inherit the
   * previous run's escalation rung, replan count or convergence window. The
   * reset is scoped to ONE session: resetting every session at once is the
   * bug this store exists to remove.
   */
  resetEpisodeState(key: string): void {
    this.episodes.resetSession(key)
  }

  /** Reset one session's turn-scoped state: stage budget, fork window, effort escalation. */
  resetTurnState(key: string): void {
    this.episodes.resetTurn(key)
  }

  /** Consume one fork slot for the stage; false when the per-stage cap is spent (spec 96). */
  recordFork(key: string): boolean {
    const episode = this.episodes.get(key)
    if (episode.forksThisStage >= this.config.budget.maxForksPerStage) return false
    episode.forksThisStage += 1
    return true
  }

  /** Consume one merge slot for the stage; false when the per-stage cap is spent (spec 96). */
  recordMerge(key: string): boolean {
    const episode = this.episodes.get(key)
    if (episode.mergesThisStage >= this.config.budget.maxMergesPerStage) return false
    episode.mergesThisStage += 1
    return true
  }

  // ---- spec 6: effort escalation ----
  escalateEffort(key: string): { from: string; to: string; escalated: boolean } {
    const episode = this.episodes.get(key)
    const from = episode.effortTier
    const index = EFFORT_LADDER.indexOf(from)
    episode.effortTier = EFFORT_LADDER[Math.min(index + 1, EFFORT_LADDER.length - 1)]!
    return { from, to: episode.effortTier, escalated: episode.effortTier !== from }
  }

  // ---- spec 15: pass-mode labeling ----
  labelPass(key: string, id: string, mode: ReasoningMode): void {
    this.episodes.get(key).passLabels.set(id, mode)
  }

  // ---- spec 58: convergence tracking ----
  /** Record one turn's distance from the previous turn (relative token delta). */
  recordTurnDistance(key: string, distance: number): void {
    const episode = this.episodes.get(key)
    // capped at the configured window too, so a window wider than the floor stays measurable
    pushCapped(episode.turnDistances, distance, Math.max(TURN_DISTANCES_CAP, this.config.reasoning.convergenceTurns))
    episode.turnCount += 1
  }

  /** Mark that new evidence arrived this turn; blocks convergence (spec 58). */
  markEvidence(key: string): void {
    const episode = this.episodes.get(key)
    episode.lastEvidenceTurn = episode.turnCount
  }

  /** Converged = the last N turn distances are below δ AND no new evidence since (spec 58). */
  converged(key: string): { converged: boolean; window: number; delta: number; newEvidence: boolean } {
    const episode = this.episodes.get(key)
    const n = this.config.reasoning.convergenceTurns
    const delta = this.config.reasoning.convergenceDelta
    const window = episode.turnDistances.slice(-n)
    const newEvidence = episode.lastEvidenceTurn !== null && episode.turnCount - episode.lastEvidenceTurn < n
    const stable = window.length >= n && window.every((distance) => distance < delta)
    return { converged: stable && !newEvidence, window: window.length, delta, newEvidence }
  }

  // ---- specs 10/18: handoff persistence + rollback target ----
  /**
   * Persist the handoff state: stage map, counters, and the last checkpoint
   * hash (spec 10). The counters are the session's own episode, so a handoff
   * reports the run it belongs to.
   */
  handoffSnapshot(key: string, id = `session-handoff-${++this.handoffSeq}`): Snapshot {
    const episode = this.episodes.get(key)
    return this.snapshots.create(id, {
      stageMap: this.worklog.map((entry) => entry.stage),
      gates: this.gateLog.length,
      worklog: this.worklog.length,
      replans: episode.replans,
      rung: episode.rung,
      lastHash: this.snapshots.latest()?.hash ?? 'sha256:none',
      pinnedVersions: this.config.determinism.pinnedVersions,
    })
  }

  /** Most recent checkpoint not marked unverified; the rollback target (specs 18/46). */
  lastVerifiedSnapshot(): Snapshot | undefined {
    for (const id of [...this.snapshots.ids()].reverse()) {
      const snapshot = this.snapshots.get(id)
      if (snapshot === undefined) continue
      if (snapshot.data.verdict === 'unverified') continue
      return snapshot
    }
    return undefined
  }

  // ---- spec 27: human-in-the-loop gate ----
  requiresApproval(request: ApprovalRequest): { required: boolean; reason: string } {
    const { hitl } = this.config
    if (hitl.requireOnIrreversible && request.irreversible) return { required: true, reason: 'irreversible action' }
    if (hitl.requireOnExternal && request.external) return { required: true, reason: 'external effect' }
    if (request.estimatedCost > hitl.requireAboveCost) return { required: true, reason: `estimated cost ${request.estimatedCost} above ceiling ${hitl.requireAboveCost}` }
    return { required: false, reason: 'within autonomous bounds' }
  }

  // ---- spec 7: provenance tagging ----
  tag(claim: string, tag: ProvenanceTag): string {
    if (tag.kind === 'fetch') return `[fetch:${tag.url}] ${claim}`
    if (tag.kind === 'mem') return `[mem:${tag.era}] ${claim}`
    return `[inf] ${claim}`
  }

  // ---- specs 5 / 12: verification gates ----
  recordGate(result: GateResult, key?: string): GateResult {
    const entry = pushCapped(this.gateLog, result, GATE_LOG_CAP)
    // A failed gate is worth narrating (spec 4), and only the run that
    // failed it should hear about it.
    if (!result.pass && key !== undefined) {
      this.episodes.get(key).failingGates += 1
    }
    return entry
  }

  // ---- spec 13: worklog ----
  recordWorklog(entry: WorklogEntry): WorklogEntry {
    return pushCapped(this.worklog, entry, WORKLOG_CAP)
  }

  // ---- spec 95: cost accounting ----
  /** Running per-stage totals, kept beside the ring so eviction cannot roll them back. */
  private readonly stageCosts = new Map<string, { tokens: number; latencyMs: number; risk: number }>()

  recordCost(entry: CostLedgerEntry): void {
    pushCapped(this.costLedger, entry, COST_LEDGER_CAP)
    // Re-summing the retained entries made the "running stage cost" shrink once
    // the ring dropped a booking, so budget numbers moved backwards.
    const running = this.stageCosts.get(entry.stage) ?? { tokens: 0, latencyMs: 0, risk: 0 }
    this.stageCosts.set(entry.stage, {
      tokens: running.tokens + entry.tokens,
      latencyMs: running.latencyMs + entry.latencyMs,
      risk: running.risk + entry.riskWeight,
    })
  }

  stageCost(stage: string): { tokens: number; latencyMs: number; risk: number } {
    return this.stageCosts.get(stage) ?? { tokens: 0, latencyMs: 0, risk: 0 }
  }

  // ---- spec 89: weighted pass score ----
  score(input: { evidence: number; coherence: number; coverage: number; contradiction: number }): PassScore {
    const weighted = input.evidence + input.coherence + input.coverage - input.contradiction
    return { ...input, weighted }
  }

  // ---- spec 75: decay weight ----
  decayWeight(ageMs: number): number {
    return Math.exp(-this.config.reasoning.decayLambda * (ageMs / 1000))
  }

  // ---- spec 88: deadline propagation ----
  childDeadline(parentDeadline: number | null, ownDeadline: number | null): number | null {
    if (parentDeadline === null) return ownDeadline
    if (ownDeadline === null) return parentDeadline
    return Math.min(parentDeadline, ownDeadline)
  }

  // ---- spec 25: deterministic seed ----
  seed(): number {
    return this.config.determinism.seed
  }

  /** Record a pass into lineage + snapshot boundary (specs 34, 38, 69). */
  recordPass(pass: ReasoningPass): ReasoningPass {
    this.lineage.record(pass)
    // Audit protection stays opt-in via lineage.protect: protecting every pass made the GC keep-set everything.
    return pass
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fable51: Fable51Policy
  }
}

export default Fable51Policy
