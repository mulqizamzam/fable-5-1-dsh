/**
 * The two log shapes the bundle records, kept apart from the service so the
 * tenant scope can hold them without importing the service.
 */
import type { PassVerdict } from './pass.ts'

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
