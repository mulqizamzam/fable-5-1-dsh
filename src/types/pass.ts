/** Reasoning-pass lineage, verdict, and scoring contracts (specs 34, 49, 54, 59, 69, 89). */

export type PassVerdict = 'contributed' | 'neutral' | 'discarded'

/** Weighted quality score for one reasoning pass (spec 89: w1·ev + w2·coh + w3·cov − w4·contra). */
export interface PassScore {
  evidence: number
  coherence: number
  coverage: number
  contradiction: number
  weighted: number
}

/** One reasoning pass in the DAG (spec 34). Identity is content-addressed. */
export interface ReasoningPass {
  readonly id: string
  readonly spec: string
  readonly parentId: string | null
  readonly inHash: string
  readonly outHash: string
  readonly deps: readonly string[]
  readonly verdict: PassVerdict
  readonly score: PassScore
  readonly startedAt: number
  readonly endedAt: number
  readonly tokens: number
  readonly latencyMs: number
  readonly unverified: readonly string[]
}

/** Emit shape of a reasoning trace record (spec 49). */
export interface ReasoningTrace {
  readonly id: string
  readonly inHash: string
  readonly outHash: string
  readonly deps: readonly string[]
  readonly verdict: PassVerdict
  readonly score: PassScore
}
