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
import { wireToolsResult } from './hooks/tools-result.ts'
import { registerTools } from './tools/index.ts'
import { PassLineage } from './state/lineage.ts'
import { PolicyRegistry } from './state/registry.ts'
import { ReasonCache } from './state/cache.ts'
import { SnapshotStore, type Snapshot } from './state/snapshots.ts'
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

/** Reasoning-mode label (spec 15): interleaved thinking is not parallel reasoning. */
export type ReasoningMode = 'parallel' | 'sequential' | 'interleaved'

export interface ApprovalRequest {
  readonly action: string
  readonly irreversible: boolean
  readonly external: boolean
  readonly estimatedCost: number
}

const LADDER: readonly EscalationRung[] = ['retry', 'replan', 'downgrade', 'ask']
const EFFORT_LADDER = ['low', 'mid', 'high', 'max'] as const

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
  readonly cache = new ReasonCache()
  readonly snapshots = new SnapshotStore()
  readonly gateLog: GateResult[] = []
  readonly worklog: WorklogEntry[] = []
  readonly costLedger: CostLedgerEntry[] = []

  /** Per-stage token accounting (spec 22). */
  stageTokens = new Map<string, number>()
  /** Escalation ladder cursor (spec 28): one rung per failure. */
  rung = 0
  /** Replan counter (spec 14). */
  replans = 0
  /** Fork/merge budget counters (spec 96). */
  forksThisStage = 0
  mergesThisStage = 0
  /** Queue depth for backpressure (spec 71). */
  queueDepth = 0
  /** Current effort tier, escalated on task signal (spec 6). */
  effortTier: Fable51Config['effort']['defaultTier']
  /** Reasoning-mode label per pass id (spec 15): parallel ≠ sequential ≠ interleaved. */
  readonly passLabels = new Map<string, ReasoningMode>()
  /** Per-turn convergence distances, oldest first (spec 58). */
  readonly turnDistances: number[] = []
  /** Turn index of the most recent new-evidence event, null when none (spec 58). */
  lastEvidenceTurn: number | null = null
  /** Turn counter driving the convergence window (spec 58). */
  turnCount = 0
  /** Per-stage token count of the previous turn, for the convergence distance (spec 58). */
  readonly previousTurnTokens = new Map<string, number>()

  constructor(ctx: Context, config: Record<string, unknown> = {}) {
    super(ctx, 'fable51')
    this.config = resolveConfig(config)
    this.effortTier = this.config.effort.defaultTier
    for (const policy of this.config.registry.policies) this.registry.register(policy)
    // PRD §3: hooks and tools wire at service construction; cordis disposes
    // listeners and tool registrations with the owning fiber automatically.
    wireAgentPreStep(ctx)
    wireToolsResult(ctx)
    wireLlmStream(ctx)
    wireSessionEvent(ctx)
    const toolCount = registerTools(ctx)
    ctx.logger('fable51').info(`fable-5-1 loaded — ${toolCount} tools registered`)
  }

  // ---- spec 1: context thresholds ----
  contextAction(fillRatio: number): 'ok' | 'compact' | 'drop' | 'spill' {
    if (fillRatio >= this.config.context.spillAt) return 'spill'
    if (fillRatio >= this.config.context.dropAt) return 'drop'
    if (fillRatio >= this.config.context.compactAt) return 'compact'
    return 'ok'
  }

  // ---- spec 22: per-stage token budget ----
  addStageTokens(stage: string, tokens: number): { used: number; alert: boolean; stop: boolean } {
    const used = (this.stageTokens.get(stage) ?? 0) + tokens
    this.stageTokens.set(stage, used)
    const limit = this.config.budget.stageTokenBudget
    return { used, alert: used >= limit * 0.8, stop: used >= limit }
  }

  // ---- spec 14 / 28: replan budget + escalation ladder ----
  replan(): { count: number; escalate: boolean } {
    this.replans += 1
    return { count: this.replans, escalate: this.replans > this.config.budget.maxReplans }
  }

  nextRung(): EscalationRung {
    const rung = LADDER[Math.min(this.rung, LADDER.length - 1)]!
    this.rung += 1
    return rung
  }

  // ---- spec 96: fork/merge budget ----
  canFork(depth: number): boolean {
    return depth < this.config.budget.maxForkDepth && this.forksThisStage < this.config.budget.maxForksPerStage
  }

  canMerge(): boolean {
    return this.mergesThisStage < this.config.budget.maxMergesPerStage
  }

  /** Consume one fork slot for the stage; false when the per-stage cap is spent (spec 96). */
  recordFork(): boolean {
    if (this.forksThisStage >= this.config.budget.maxForksPerStage) return false
    this.forksThisStage += 1
    return true
  }

  /** Consume one merge slot for the stage; false when the per-stage cap is spent (spec 96). */
  recordMerge(): boolean {
    if (this.mergesThisStage >= this.config.budget.maxMergesPerStage) return false
    this.mergesThisStage += 1
    return true
  }

  // ---- spec 6: effort escalation ----
  escalateEffort(): { from: string; to: string; escalated: boolean } {
    const from = this.effortTier
    const index = EFFORT_LADDER.indexOf(from)
    this.effortTier = EFFORT_LADDER[Math.min(index + 1, EFFORT_LADDER.length - 1)]!
    return { from, to: this.effortTier, escalated: this.effortTier !== from }
  }

  // ---- spec 15: pass-mode labeling ----
  labelPass(id: string, mode: ReasoningMode): void {
    this.passLabels.set(id, mode)
  }

  // ---- spec 58: convergence tracking ----
  /** Record one turn's distance from the previous turn (relative token delta). */
  recordTurnDistance(distance: number): void {
    this.turnDistances.push(distance)
    this.turnCount += 1
  }

  /** Mark that new evidence arrived this turn; blocks convergence (spec 58). */
  markEvidence(): void {
    this.lastEvidenceTurn = this.turnCount
  }

  /** Converged = the last N turn distances are below δ AND no new evidence since (spec 58). */
  converged(): { converged: boolean; window: number; delta: number; newEvidence: boolean } {
    const n = this.config.reasoning.convergenceTurns
    const delta = this.config.reasoning.convergenceDelta
    const window = this.turnDistances.slice(-n)
    const newEvidence = this.lastEvidenceTurn !== null && this.turnCount - this.lastEvidenceTurn < n
    const stable = window.length >= n && window.every((distance) => distance < delta)
    return { converged: stable && !newEvidence, window: window.length, delta, newEvidence }
  }

  // ---- specs 10/18: handoff persistence + rollback target ----
  /** Persist the handoff state: stage map, counters, and the last checkpoint hash (spec 10). */
  handoffSnapshot(id = 'session-handoff'): Snapshot {
    return this.snapshots.create(id, {
      stageMap: this.worklog.map((entry) => entry.stage),
      gates: this.gateLog.length,
      worklog: this.worklog.length,
      replans: this.replans,
      rung: this.rung,
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
  recordGate(result: GateResult): GateResult {
    this.gateLog.push(result)
    return result
  }

  // ---- spec 13: worklog ----
  recordWorklog(entry: WorklogEntry): WorklogEntry {
    this.worklog.push(entry)
    return entry
  }

  // ---- spec 95: cost accounting ----
  recordCost(entry: CostLedgerEntry): void {
    this.costLedger.push(entry)
  }

  stageCost(stage: string): { tokens: number; latencyMs: number; risk: number } {
    let tokens = 0
    let latencyMs = 0
    let risk = 0
    for (const entry of this.costLedger) {
      if (entry.stage !== stage) continue
      tokens += entry.tokens
      latencyMs += entry.latencyMs
      risk += entry.riskWeight
    }
    return { tokens, latencyMs, risk }
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
    this.lineage.protect(pass.id)
    return pass
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    fable51: Fable51Policy
  }
}

export default Fable51Policy
