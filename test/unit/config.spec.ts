/**
 * Unit: fail-loud config validation (Gate 2). Bad config must throw with the
 * exact field path — no silent defaults, no silent fallback.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, ConfigError } from '../../src/config/schema.ts'
import { defaults, resolveConfig } from '../../src/config/defaults.ts'

function validPatch(): Record<string, unknown> {
  return {}
}

describe('Gate 2 — config validation', () => {
  it('defaults validate cleanly', () => {
    const config = validateConfig(defaults())
    assert.equal(config.context.compactAt, 0.7)
    assert.equal(config.reasoning.quorumThreshold, 0.6)
  })

  it('a partial config merges onto defaults and validates', () => {
    const config = resolveConfig(validPatch())
    assert.equal(config.effort.defaultTier, 'mid')
  })

  it('throws with the exact field path on a type violation', () => {
    const bad = { ...defaults(), effort: { ...defaults().effort, costCeiling: 'lots' } }
    assert.throws(
      () => validateConfig(bad),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError)
        assert.equal(error.fieldPath, 'config.effort.costCeiling')
        return true
      },
    )
  })

  it('throws on unordered context thresholds', () => {
    const bad = { ...defaults(), context: { compactAt: 0.9, dropAt: 0.85, spillAt: 0.95, spillPath: '.dsh/fable-spill' } }
    assert.throws(
      () => validateConfig(bad),
      (error: unknown) => error instanceof ConfigError && error.fieldPath === 'config.context',
    )
  })

  it('throws on an unknown effort tier', () => {
    const bad = { ...defaults(), effort: { ...defaults().effort, defaultTier: 'turbo' } }
    assert.throws(
      () => validateConfig(bad),
      (error: unknown) => error instanceof ConfigError && error.fieldPath === 'config.effort.defaultTier',
    )
  })

  it('throws on a malformed registry policy entry with its index', () => {
    const bad = { ...defaults(), registry: { policies: [{ id: 'p', version: '1', owner: 'o', active: 'yes', hash: 'h' }] } }
    assert.throws(
      () => validateConfig(bad),
      (error: unknown) => error instanceof ConfigError && error.fieldPath === 'config.registry.policies[0].active',
    )
  })

  it('rejects a missing section loudly rather than defaulting it', () => {
    const partial: Record<string, unknown> = { ...defaults() }
    delete partial.hitl
    assert.throws(() => validateConfig(partial), (error: unknown) => error instanceof ConfigError && error.fieldPath === 'config.hitl')
  })
})
