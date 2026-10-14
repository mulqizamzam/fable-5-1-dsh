/**
 * Unit: bundle state modules — registry immutability (100), lineage + GC
 * (69/87/94), cache fingerprinting (43/65), snapshot diff (38/46/77/83).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PolicyRegistry } from '../../src/state/registry.ts'
import { PassLineage } from '../../src/state/lineage.ts'
import { ReasonCache, canonicalize, fingerprint } from '../../src/state/cache.ts'
import { SnapshotStore } from '../../src/state/snapshots.ts'
import type { ReasoningPass } from '../../src/types/pass.ts'

function pass(id: string, parentId: string | null = null): ReasoningPass {
  return {
    id, spec: 'test', parentId, inHash: `sha256:in-${id}`, outHash: `sha256:out-${id}`,
    deps: [], verdict: 'contributed',
    score: { evidence: 1, coherence: 1, coverage: 1, contradiction: 0, weighted: 3 },
    startedAt: 0, endedAt: 1, tokens: 10, latencyMs: 1, unverified: [],
  }
}

describe('PolicyRegistry (spec 100)', () => {
  it('registers a policy and finds the active version', () => {
    const registry = new PolicyRegistry()
    registry.register({ id: 'p', version: '1.0.0', owner: 'o', active: true, hash: 'h1' })
    assert.equal(registry.getActive('p')?.version, '1.0.0')
  })

  it('forbids mutation: registering the same id+version throws', () => {
    const registry = new PolicyRegistry()
    registry.register({ id: 'p', version: '1.0.0', owner: 'o', active: true, hash: 'h1' })
    assert.throws(() => registry.register({ id: 'p', version: '1.0.0', owner: 'o', active: true, hash: 'h2' }), /mutation is forbidden/)
  })

  it('a new version becomes the active one; history is kept', () => {
    const registry = new PolicyRegistry()
    registry.register({ id: 'p', version: '1.0.0', owner: 'o', active: true, hash: 'h1' })
    registry.register({ id: 'p', version: '1.1.0', owner: 'o', active: true, hash: 'h2' })
    assert.equal(registry.getActive('p')?.version, '1.1.0')
    assert.equal(registry.versions('p').length, 2)
  })
})

describe('PassLineage (specs 69, 87, 94)', () => {
  it('records parent→child edges and answers ancestors', () => {
    const lineage = new PassLineage()
    lineage.record(pass('a'))
    lineage.record(pass('b', 'a'))
    lineage.record(pass('c', 'b'))
    assert.deepEqual(lineage.ancestors('c'), ['b', 'a'])
    assert.deepEqual(lineage.children('a'), ['b'])
  })

  it('rejects a pass with an unknown parent', () => {
    const lineage = new PassLineage()
    assert.throws(() => lineage.record(pass('orphan', 'missing')))
  })

  it('GC keeps live passes and their ancestor chain plus audit; drops only the unreachable (keepLastN=0)', () => {
    const lineage = new PassLineage()
    lineage.record(pass('a'))
    lineage.record(pass('b', 'a'))
    lineage.record(pass('c', 'b'))
    lineage.record(pass('side')) // reachable from nothing
    lineage.protect('a')
    const dropped = lineage.gc(['c'], 0)
    assert.ok(!dropped.includes('a'), 'audit-protected pass survives')
    assert.ok(!dropped.includes('b'), 'ancestor of a live pass survives (traceability, spec 94)')
    assert.ok(!dropped.includes('c'), 'live pass survives')
    assert.ok(dropped.includes('side'), 'unreachable side pass is collected')
    assert.equal(lineage.size(), 3)
  })

  it('GC keeps the N newest passes even when unreachable (spec 94 keep-last-N)', () => {
    const lineage = new PassLineage()
    lineage.record(pass('a'))
    lineage.record(pass('b', 'a'))
    lineage.record(pass('side'))
    const dropped = lineage.gc(['b'], 1)
    assert.deepEqual(dropped, [], 'the newest pass is protected by keep-last-N')
    assert.equal(lineage.size(), 3)
  })

  it('prune keeps the ancestry of a live pass and honours audit protection (spec 87)', () => {
    const lineage = new PassLineage()
    lineage.record(pass('a'))
    lineage.record(pass('b', 'a'))
    lineage.record(pass('c', 'b'))
    lineage.protect('a')
    const dropped = lineage.prune(['c'])
    assert.ok(!dropped.includes('b'), "a live pass's ancestor must survive: ancestors() would otherwise report a dangling id")
    assert.ok(!dropped.includes('a'), 'audit-protected survives prune')
    assert.ok(!dropped.includes('c'), 'live survives prune')
    assert.equal(lineage.size(), 3)
    // guard: ancestors() is nearest-first, and prune must leave the whole chain resolvable (spec 87)
    assert.deepEqual(lineage.ancestors('c'), ['b', 'a'], 'the whole chain resolves, nearest ancestor first')
  })

  it('classifies verdicts for the audit tool (spec 59)', () => {
    const lineage = new PassLineage()
    lineage.record(pass('a'))
    lineage.record({ ...pass('b', 'a'), verdict: 'discarded' })
    assert.deepEqual(lineage.verdicts(), { contributed: 1, neutral: 0, discarded: 1 })
  })
})

describe('ReasonCache (specs 43, 65)', () => {
  it('canonicalizes key order so equal content fingerprints equally', () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }))
    assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }))
  })

  it('cache key is deterministic across calls and inputs', () => {
    const cache = new ReasonCache()
    const k1 = cache.key({ x: 1 }, 'spec', 'sha256:policy')
    const k2 = cache.key({ x: 1 }, 'spec', 'sha256:policy')
    assert.equal(k1, k2)
    assert.notEqual(k1, cache.key({ x: 2 }, 'spec', 'sha256:policy'))
  })

  it('counts hits and misses', () => {
    const cache = new ReasonCache()
    const key = cache.key('input', 'spec', 'policy')
    cache.set(key, { done: true })
    assert.ok(cache.get(key))
    assert.equal(cache.get('missing'), undefined)
    assert.equal(cache.hits, 1)
    assert.equal(cache.misses, 1)
  })
})

describe('SnapshotStore (specs 38, 46, 77, 83)', () => {
  it('creates content-addressed snapshots and diffs them', () => {
    const store = new SnapshotStore()
    store.create('s1', { a: 1, b: 2 })
    store.create('s2', { b: 3, c: 4 })
    const diff = store.diff('s1', 's2')
    assert.deepEqual(diff.added, ['c'])
    assert.deepEqual(diff.removed, ['a'])
    assert.deepEqual(diff.changed, ['b'])
  })

  it('diff throws on unknown snapshots', () => {
    const store = new SnapshotStore()
    store.create('s1', {})
    assert.throws(() => store.diff('s1', 'nope'))
  })
})

describe('fingerprint', () => {
  it('is stable and prefixed', () => {
    assert.match(fingerprint({ a: [1, 2] }), /^sha256:[0-9a-f]{64}$/)
    assert.equal(fingerprint('x'), fingerprint('x'))
  })
})
