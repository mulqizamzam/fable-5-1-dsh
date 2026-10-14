/**
 * Fail-loud configuration contract (spec: bundle config; PRD §5).
 *
 * Validation is deliberately dependency-free and reports an explicit field
 * path on violation — silent misconfiguration is the top dsh port failure
 * mode. No field is defaulted silently when the value conflicts.
 */

export interface Fable51Config {
  /** Spec 1 — context thresholds. Strictly ordered compactAt < dropAt < spillAt. */
  context: {
    compactAt: number
    dropAt: number
    spillAt: number
    spillPath: string
  }
  /** Specs 6, 11 — effort escalation and cost ceiling. */
  effort: {
    defaultTier: 'low' | 'mid' | 'high' | 'max'
    escalateOn: Array<'search' | 'multihop' | 'ambiguity'>
    costCeiling: number
  }
  /** Specs 14, 21, 22, 52, 72, 81, 96. */
  budget: {
    maxReplans: number
    maxPassRetries: number
    passTimeoutMs: number
    stageTimeoutMs: number
    stageTokenBudget: number
    maxForkDepth: number
    maxForksPerStage: number
    maxMergesPerStage: number
  }
  /** Specs 55, 58, 73, 75 (43's cache key is derived at runtime; 96's fields live in budget). */
  reasoning: {
    maxConcurrentPasses: number
    convergenceDelta: number
    convergenceTurns: number
    decayLambda: number
    quorumThreshold: number
  }
  /** Spec 25. */
  determinism: {
    seed: number
    iterationOrder: 'stable' | 'sorted'
    pinnedVersions: Record<string, string>
  }
  /** Spec 26. */
  sandbox: {
    allowList: Record<string, string[]>
    escapeAction: 'abort' | 'halt'
  }
  /** Spec 27. */
  hitl: {
    requireOnIrreversible: boolean
    requireOnExternal: boolean
    requireAboveCost: number
  }
  /** Specs 24, 79. */
  observability: {
    traceLevel: 'stage' | 'pass' | 'both'
    logFormat: 'line' | 'json'
  }
  /** Spec 100. */
  registry: {
    policies: Array<{ id: string; version: string; owner: string; active: boolean; hash: string }>
  }
}

export class ConfigError extends Error {
  constructor(readonly fieldPath: string, message: string) {
    super(`fable51 config invalid at ${fieldPath}: ${message}`)
    this.name = 'ConfigError'
  }
}

const TIERS = new Set(['low', 'mid', 'high', 'max'])
const ESCALATE_ON = new Set(['search', 'multihop', 'ambiguity'])

function fail(path: string, message: string): never {
  throw new ConfigError(path, message)
}

function num(value: unknown, path: string, { min, max, integer }: { min?: number; max?: number; integer?: boolean } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'expected a finite number')
  // A fractional counter is never what the operator meant: maxReplans 0.5
  // escalates on the first replan.
  if (integer === true && !Number.isSafeInteger(value)) fail(path, 'expected an integer')
  if (min !== undefined && value < min) fail(path, `must be >= ${min}`)
  if (max !== undefined && value > max) fail(path, `must be <= ${max}`)
  return value
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'expected a boolean')
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'expected a non-empty string')
  return value
}

function obj(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(path, 'expected an object')
  return value as Record<string, unknown>
}

// A typo'd safety key must fail loudly, never merge into nothing and read as active.
function knownKeys(path: string, value: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(path, `unknown key ${key}; known keys are ${keys.join(', ')}`)
  }
}

/**
 * Validate a raw config object against the schema, returning the typed config.
 * Throws ConfigError with the exact field path on the first violation.
 */
export function validateConfig(raw: unknown): Fable51Config {
  const root = obj(raw, 'config')
  knownKeys('config', root, ['context', 'effort', 'budget', 'reasoning', 'determinism', 'sandbox', 'hitl', 'observability', 'registry'])
  const context = obj(root.context, 'config.context')
  knownKeys('config.context', context, ['compactAt', 'dropAt', 'spillAt', 'spillPath'])
  const compactAt = num(context.compactAt, 'config.context.compactAt', { min: 0.1, max: 0.99 })
  const dropAt = num(context.dropAt, 'config.context.dropAt', { min: 0.1, max: 0.99 })
  const spillAt = num(context.spillAt, 'config.context.spillAt', { min: 0.1, max: 0.99 })
  if (!(compactAt < dropAt && dropAt < spillAt)) {
    fail('config.context', `thresholds must be ordered compactAt(${compactAt}) < dropAt(${dropAt}) < spillAt(${spillAt})`)
  }
  const spillPath = str(context.spillPath, 'config.context.spillPath')

  const effort = obj(root.effort, 'config.effort')
  knownKeys('config.effort', effort, ['defaultTier', 'escalateOn', 'costCeiling'])
  const defaultTier = str(effort.defaultTier, 'config.effort.defaultTier')
  if (!TIERS.has(defaultTier)) fail('config.effort.defaultTier', `must be one of ${[...TIERS].join('|')}`)
  if (!Array.isArray(effort.escalateOn)) fail('config.effort.escalateOn', 'expected an array')
  for (const [i, item] of (effort.escalateOn as unknown[]).entries()) {
    if (typeof item !== 'string' || !ESCALATE_ON.has(item)) fail(`config.effort.escalateOn[${i}]`, `must be one of ${[...ESCALATE_ON].join('|')}`)
  }
  const costCeiling = num(effort.costCeiling, 'config.effort.costCeiling', { min: 1 })

  const budget = obj(root.budget, 'config.budget')
  knownKeys('config.budget', budget, ['maxReplans', 'maxPassRetries', 'passTimeoutMs', 'stageTimeoutMs', 'stageTokenBudget', 'maxForkDepth', 'maxForksPerStage', 'maxMergesPerStage'])
  const maxReplans = num(budget.maxReplans, 'config.budget.maxReplans', { min: 0, max: 10, integer: true })
  const maxPassRetries = num(budget.maxPassRetries, 'config.budget.maxPassRetries', { min: 0, max: 10, integer: true })
  const passTimeoutMs = num(budget.passTimeoutMs, 'config.budget.passTimeoutMs', { min: 1, integer: true })
  const stageTimeoutMs = num(budget.stageTimeoutMs, 'config.budget.stageTimeoutMs', { min: 1, integer: true })
  const stageTokenBudget = num(budget.stageTokenBudget, 'config.budget.stageTokenBudget', { min: 1, integer: true })
  const maxForkDepth = num(budget.maxForkDepth, 'config.budget.maxForkDepth', { min: 1, max: 100, integer: true })
  const maxForksPerStage = num(budget.maxForksPerStage, 'config.budget.maxForksPerStage', { min: 1, max: 1000, integer: true })
  const maxMergesPerStage = num(budget.maxMergesPerStage, 'config.budget.maxMergesPerStage', { min: 1, max: 1000, integer: true })

  const reasoning = obj(root.reasoning, 'config.reasoning')
  knownKeys('config.reasoning', reasoning, ['maxConcurrentPasses', 'convergenceDelta', 'convergenceTurns', 'decayLambda', 'quorumThreshold'])
  const maxConcurrentPasses = num(reasoning.maxConcurrentPasses, 'config.reasoning.maxConcurrentPasses', { min: 1, max: 1000, integer: true })
  const convergenceDelta = num(reasoning.convergenceDelta, 'config.reasoning.convergenceDelta', { min: 0, max: 1 })
  const convergenceTurns = num(reasoning.convergenceTurns, 'config.reasoning.convergenceTurns', { min: 1, max: 1000, integer: true })
  const decayLambda = num(reasoning.decayLambda, 'config.reasoning.decayLambda', { min: 0, max: 10 })
  const quorumThreshold = num(reasoning.quorumThreshold, 'config.reasoning.quorumThreshold', { min: 0, max: 1 })

  const determinism = obj(root.determinism, 'config.determinism')
  knownKeys('config.determinism', determinism, ['seed', 'iterationOrder', 'pinnedVersions'])
  const seed = num(determinism.seed, 'config.determinism.seed', { min: 0 })
  if (!Number.isSafeInteger(seed)) fail('config.determinism.seed', 'expected a non-negative safe integer')
  const iterationOrder = str(determinism.iterationOrder, 'config.determinism.iterationOrder')
  if (iterationOrder !== 'stable' && iterationOrder !== 'sorted') fail('config.determinism.iterationOrder', "must be 'stable' or 'sorted'")
  if (typeof determinism.pinnedVersions !== 'object' || determinism.pinnedVersions === null || Array.isArray(determinism.pinnedVersions)) {
    fail('config.determinism.pinnedVersions', 'expected a record of version pins')
  }
  for (const [key, pin] of Object.entries(determinism.pinnedVersions as Record<string, unknown>)) {
    str(pin, `config.determinism.pinnedVersions.${key}`)
  }

  const sandbox = obj(root.sandbox, 'config.sandbox')
  knownKeys('config.sandbox', sandbox, ['allowList', 'escapeAction'])
  if (typeof sandbox.allowList !== 'object' || sandbox.allowList === null || Array.isArray(sandbox.allowList)) {
    fail('config.sandbox.allowList', 'expected a record of allow-lists')
  }
  for (const [key, paths] of Object.entries(sandbox.allowList as Record<string, unknown>)) {
    if (!Array.isArray(paths)) fail(`config.sandbox.allowList.${key}`, 'expected an array of path strings')
    for (const [i, path] of (paths as unknown[]).entries()) {
      str(path, `config.sandbox.allowList.${key}[${i}]`)
    }
  }
  const escapeAction = str(sandbox.escapeAction, 'config.sandbox.escapeAction')
  if (escapeAction !== 'abort' && escapeAction !== 'halt') fail('config.sandbox.escapeAction', "must be 'abort' or 'halt'")

  const hitl = obj(root.hitl, 'config.hitl')
  knownKeys('config.hitl', hitl, ['requireOnIrreversible', 'requireOnExternal', 'requireAboveCost'])
  const requireOnIrreversible = bool(hitl.requireOnIrreversible, 'config.hitl.requireOnIrreversible')
  const requireOnExternal = bool(hitl.requireOnExternal, 'config.hitl.requireOnExternal')
  const requireAboveCost = num(hitl.requireAboveCost, 'config.hitl.requireAboveCost', { min: 0 })

  const observability = obj(root.observability, 'config.observability')
  knownKeys('config.observability', observability, ['traceLevel', 'logFormat'])
  const traceLevel = str(observability.traceLevel, 'config.observability.traceLevel')
  if (!['stage', 'pass', 'both'].includes(traceLevel)) fail('config.observability.traceLevel', "must be 'stage'|'pass'|'both'")
  const logFormat = str(observability.logFormat, 'config.observability.logFormat')
  if (logFormat !== 'line' && logFormat !== 'json') fail('config.observability.logFormat', "must be 'line' or 'json'")

  const registry = obj(root.registry, 'config.registry')
  knownKeys('config.registry', registry, ['policies'])
  if (!Array.isArray(registry.policies)) fail('config.registry.policies', 'expected an array')
  const policies = (registry.policies as unknown[]).map((item, i) => {
    const p = obj(item, `config.registry.policies[${i}]`)
    knownKeys(`config.registry.policies[${i}]`, p, ['id', 'version', 'owner', 'active', 'hash'])
    return {
      id: str(p.id, `config.registry.policies[${i}].id`),
      version: str(p.version, `config.registry.policies[${i}].version`),
      owner: str(p.owner, `config.registry.policies[${i}].owner`),
      active: bool(p.active, `config.registry.policies[${i}].active`),
      hash: str(p.hash, `config.registry.policies[${i}].hash`),
    }
  })

  return {
    context: { compactAt, dropAt, spillAt, spillPath },
    effort: { defaultTier: defaultTier as Fable51Config['effort']['defaultTier'], escalateOn: effort.escalateOn as Fable51Config['effort']['escalateOn'], costCeiling },
    budget: { maxReplans, maxPassRetries, passTimeoutMs, stageTimeoutMs, stageTokenBudget, maxForkDepth, maxForksPerStage, maxMergesPerStage },
    reasoning: { maxConcurrentPasses, convergenceDelta, convergenceTurns, decayLambda, quorumThreshold },
    determinism: { seed, iterationOrder, pinnedVersions: determinism.pinnedVersions as Record<string, string> },
    sandbox: { allowList: sandbox.allowList as Record<string, string[]>, escapeAction },
    hitl: { requireOnIrreversible, requireOnExternal, requireAboveCost },
    observability: { traceLevel: traceLevel as Fable51Config['observability']['traceLevel'], logFormat },
    registry: { policies },
  }
}
