import type { Fable51Config } from './schema.ts'
import { ConfigError, validateConfig } from './schema.ts'

/** Deep-merge a partial config onto the defaults, then fail-loud validate. */
export function resolveConfig(partial: unknown): Fable51Config {
  const merged = deepMerge(defaults() as unknown as Record<string, unknown>, obj(partial))
  return validateConfig(merged)
}

function obj(value: unknown): Record<string, unknown> {
  // Only `undefined` means "no config supplied"; every other non-mapping is a
  // typo or bad YAML indentation and must not resolve to 100% defaults.
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError('config', `expected a config object, received ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)
  }
  return value as Record<string, unknown>
}

function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key]
    if (isPlainObject(value) && isPlainObject(current)) {
      out[key] = deepMerge(current, value)
    } else {
      out[key] = value
    }
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function defaults(): Fable51Config {
  return {
    context: { compactAt: 0.7, dropAt: 0.85, spillAt: 0.9, spillPath: '.dsh/fable-spill' },
    effort: { defaultTier: 'mid', escalateOn: ['search', 'multihop', 'ambiguity'], costCeiling: 2_000_000 },
    budget: { maxReplans: 2, maxPassRetries: 2, passTimeoutMs: 120_000, stageTimeoutMs: 600_000, stageTokenBudget: 400_000, maxForkDepth: 4, maxForksPerStage: 8, maxMergesPerStage: 8 },
    reasoning: { maxConcurrentPasses: 4, convergenceDelta: 0.02, convergenceTurns: 3, decayLambda: 0.15, quorumThreshold: 0.6 },
    determinism: { seed: 20261011, iterationOrder: 'stable', pinnedVersions: { dsh: '23c78fcdd5ee0b497a77ca356608c51093c74bb9' } },
    sandbox: { allowList: {}, escapeAction: 'abort' },
    hitl: { requireOnIrreversible: true, requireOnExternal: true, requireAboveCost: 500_000 },
    observability: { traceLevel: 'stage', logFormat: 'line' },
    registry: { policies: [] },
  }
}
