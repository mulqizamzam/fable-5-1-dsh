/**
 * Unit: the verification tool group, specs 5, 7, 12, 16, 19, 36, 47, 48, 70
 * (Gate 4b) against a real Cordis host and the real tool registry.
 *
 * Every assertion runs through ctx.tools.execute, so the envelope shape, the
 * fable51.* namespace, and the idempotency replay are all exercised the way
 * the host exercises them.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { fingerprint } from '../../src/state/cache.ts'
import { DEFAULT_SCOPE } from '../../src/state/tenant.ts'

interface Envelope {
  readonly ok: boolean
  readonly spec: string
  readonly output: Record<string, unknown>
  readonly verdict: string
  readonly unverified: readonly string[]
  readonly rerun: boolean
  readonly gates: readonly unknown[]
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

async function call(ctx: Context, name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('c1'),
    name: `fable51_${name}`,
    arguments: args,
  })
  assert.equal(result.isError, false, `fable51_${name} failed: ${JSON.stringify(result.content)}`)
  return (result as { value: unknown }).value as Envelope
}

describe('verification tools, registry surface', () => {
  it('registers every verification tool under the fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      for (const expected of [
        'fable51_verification-gates',
        'fable51_research-provenance',
        'fable51_anti-introspection',
        'fable51_cold-verifier-isolation',
        'fable51_idempotency',
        'fable51_verifier-forking',
        'fable51_chain-of-verification',
        'fable51_independent-replication',
        'fable51_speculative-verify',
      ]) {
        assert.ok(names.includes(expected), `missing ${expected} in ${names.join(',')}`)
      }
      for (const name of names) assert.match(name, /^fable51_/, `tool ${name} must stay in the fable51 namespace`)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 5, verification-gates', () => {
  const args = { check: 'tests', cmd: 'node --test', expected: 'pass', actual: 'pass' }

  it('records a passing gate in the gate log and records it again on rerun', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'verification-gates', args)
      assert.equal(first.spec, '5')
      assert.equal(first.rerun, false)
      const output = first.output as { gate: string; cmd: string; expected: string; actual: string; pass: boolean; at: number }
      assert.equal(output.pass, true)
      assert.equal(output.gate, 'tests')
      assert.equal(output.cmd, 'node --test')
      assert.equal(typeof output.at, 'number')

      const recorded = ctx.fable51.gateLogOf(DEFAULT_SCOPE).at(-1)
      assert.deepEqual(recorded, { gate: 'tests', cmd: 'node --test', expected: 'pass', actual: 'pass', pass: true, at: recorded?.at })

      const second = await call(ctx, 'verification-gates', args)
      // Effectful: the old unconditional cache replayed the first answer, so a rerun recorded no second gate result.
      assert.equal(second.rerun, false)
      assert.equal((second.output as { pass: boolean }).pass, true)
      assert.equal(ctx.fable51.gateLogOf(DEFAULT_SCOPE).length, 2, 'each call records its own gate result')
      assert.deepEqual(
        ctx.fable51.gateLogOf(DEFAULT_SCOPE).map((g) => ({ ...g, at: 0 })),
        [first.output, second.output].map((o) => ({ ...(o as Record<string, unknown>), at: 0 })),
        'both gate records must describe the same comparison',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails the gate when the observed outcome differs from the expected one', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'verification-gates', { ...args, actual: 'fail' })
      const output = first.output as { expected: string; actual: string; pass: boolean }
      assert.equal(output.pass, false)
      assert.equal(output.expected, 'pass')
      assert.equal(output.actual, 'fail')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 7, research-provenance', () => {
  it('tags a fetched claim, replays on rerun, and keeps memory and inference apart', async () => {
    const ctx = await setup()
    try {
      const fetch = await call(ctx, 'research-provenance', { claim: 'sky is blue', tag: { kind: 'fetch', url: 'https://example.test/sky' } })
      assert.equal(fetch.spec, '7')
      assert.equal(fetch.rerun, false)
      assert.equal((fetch.output as { tagged: string }).tagged, '[fetch:https://example.test/sky] sky is blue')

      const mem = await call(ctx, 'research-provenance', { claim: 'sky is blue', tag: { kind: 'mem', era: '2026-Q1' } })
      assert.equal((mem.output as { tagged: string }).tagged, '[mem:2026-Q1] sky is blue')

      const inf = await call(ctx, 'research-provenance', { claim: 'sky is blue', tag: { kind: 'inf' } })
      assert.equal((inf.output as { tagged: string }).tagged, '[inf] sky is blue')

      const replay = await call(ctx, 'research-provenance', { claim: 'sky is blue', tag: { kind: 'fetch', url: 'https://example.test/sky' } })
      assert.equal(replay.rerun, true)
      assert.deepEqual(replay.output, fetch.output)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 12, anti-introspection', () => {
  it('certifies "verified" only when artifact, command, and output are all present', async () => {
    const ctx = await setup()
    try {
      const ok = await call(ctx, 'anti-introspection', {
        claim: 'verified',
        artifact: 'out/result.json',
        command: 'node --test test/unit/verification.spec.ts',
        output: 'pass 40',
      })
      assert.equal(ok.spec, '12')
      assert.equal(ok.rerun, false)
      assert.deepEqual(ok.output, { verdict: 'verified', missing: [] })

      const missing = await call(ctx, 'anti-introspection', { claim: 'verified', artifact: 'out/result.json', command: '', output: 'pass 40' })
      assert.equal((missing.output as { verdict: string }).verdict, 'unverified')
      assert.deepEqual((missing.output as { missing: string[] }).missing, ['command'])

      const selfReport = await call(ctx, 'anti-introspection', { claim: 'likely', artifact: 'out/result.json', command: 'node --test', output: 'pass 40' })
      assert.equal((selfReport.output as { verdict: string }).verdict, 'unverified')
      assert.deepEqual((selfReport.output as { missing: string[] }).missing, ['claim "likely" is not a verification claim'])

      const replay = await call(ctx, 'anti-introspection', {
        claim: 'verified',
        artifact: 'out/result.json',
        command: 'node --test test/unit/verification.spec.ts',
        output: 'pass 40',
      })
      assert.equal(replay.rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 16, cold-verifier-isolation', () => {
  it('accepts spec + artifact only, and names every leaked key', async () => {
    const ctx = await setup()
    try {
      const isolated = await call(ctx, 'cold-verifier-isolation', { spec: 'spec-5', artifact: 'out/result.json' })
      assert.equal(isolated.spec, '16')
      assert.equal(isolated.rerun, false)
      assert.deepEqual(isolated.output, { isolated: true, violations: [] })

      const noSpec = await call(ctx, 'cold-verifier-isolation', { spec: '', artifact: 'out/result.json' })
      assert.deepEqual(noSpec.output, { isolated: false, violations: ['spec missing'] })

      const leaked = await call(ctx, 'cold-verifier-isolation', { spec: 'spec-5', artifact: 'out/result.json', reasoning: 'producer trace' })
      const output = leaked.output as { isolated: boolean; violations: string[] }
      assert.equal(output.isolated, false)
      assert.equal(output.violations.length, 1)
      assert.match(output.violations[0] ?? '', /^reasoning leaks producer context/)

      const replay = await call(ctx, 'cold-verifier-isolation', { spec: 'spec-5', artifact: 'out/result.json' })
      assert.equal(replay.rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 19, idempotency', () => {
  it('reports firstSeen only on the first fingerprint and replays on rerun', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'idempotency', { input: { stage: 'verify', files: 3 } })
      assert.equal(first.spec, '19')
      assert.equal(first.rerun, false)
      const output = first.output as { hash: string; firstSeen: boolean }
      assert.equal(output.firstSeen, true)
      assert.match(output.hash, /^sha256:[0-9a-f]{64}$/)
      assert.equal(output.hash, ctx.fable51.cacheOf(DEFAULT_SCOPE).key({ stage: 'verify', files: 3 }, 'idempotency-check', 'none'))

      // The tool reads the cache to answer firstSeen, so it is effectful: an
      // identical call re-executes and reports the input was already fingerprinted.
      const replay = await call(ctx, 'idempotency', { input: { stage: 'verify', files: 3 } })
      assert.equal(replay.rerun, false)
      assert.equal((replay.output as { hash: string }).hash, output.hash)
      assert.equal((replay.output as { firstSeen: boolean }).firstSeen, false)

      const other = await call(ctx, 'idempotency', { input: { stage: 'verify', files: 4 } })
      assert.equal((other.output as { hash: string }).hash !== output.hash, true)

      const known = ctx.fable51.cacheOf(DEFAULT_SCOPE).key('seen-before', 'idempotency-check', 'none')
      ctx.fable51.cacheOf(DEFAULT_SCOPE).set(known, known)
      const seen = await call(ctx, 'idempotency', { input: 'seen-before' })
      assert.equal((seen.output as { hash: string; firstSeen: boolean }).firstSeen, false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 36, verifier-forking', () => {
  it('forks the verifier from the spec and excludes producer output', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'verifier-forking', { spec: 'spec-5', producerOutput: 'run-A' })
      assert.equal(first.spec, '36')
      assert.equal(first.rerun, false)
      const output = first.output as { verifierId: string; producerExcluded: boolean }
      assert.equal(output.verifierId, fingerprint('spec-5'))
      assert.equal(output.producerExcluded, true)

      const second = await call(ctx, 'verifier-forking', { spec: 'spec-5', producerOutput: 'run-B' })
      assert.equal((second.output as { verifierId: string }).verifierId, output.verifierId, 'producer output must not change verifier identity')

      const otherSpec = await call(ctx, 'verifier-forking', { spec: 'spec-12', producerOutput: 'run-A' })
      assert.equal((otherSpec.output as { verifierId: string }).verifierId !== output.verifierId, true)

      const replay = await call(ctx, 'verifier-forking', { spec: 'spec-5', producerOutput: 'run-A' })
      assert.equal(replay.rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 47, chain-of-verification', () => {
  it('chains each layer onto the previous one and rejects a single-layer chain', async () => {
    const ctx = await setup()
    try {
      const chain = await call(ctx, 'chain-of-verification', { layers: ['pass1', 'pass2', 'pass3'] })
      assert.equal(chain.spec, '47')
      assert.equal(chain.rerun, false)
      assert.deepEqual(chain.output, {
        verdict: 'verified',
        chain: [
          { layer: 'pass1', checks: null },
          { layer: 'pass2', checks: 'pass1' },
          { layer: 'pass3', checks: 'pass2' },
        ],
        unverified: [],
      })

      const single = await call(ctx, 'chain-of-verification', { layers: ['pass1'] })
      assert.equal((single.output as { verdict: string }).verdict, 'unverified')
      assert.deepEqual((single.output as { chain: unknown[] }).chain, [])
      assert.equal((single.output as { unverified: string[] }).unverified.length, 1)

      const empty = await call(ctx, 'chain-of-verification', { layers: [] })
      assert.equal((empty.output as { verdict: string }).verdict, 'unverified')

      const replay = await call(ctx, 'chain-of-verification', { layers: ['pass1', 'pass2', 'pass3'] })
      assert.equal(replay.rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 48, independent-replication', () => {
  it('derives the replica id from a distinct seed and stays deterministic', async () => {
    const ctx = await setup()
    try {
      const first = await call(ctx, 'independent-replication', { passId: 'pass1', input: { q: 'sky' } })
      assert.equal(first.spec, '48')
      assert.equal(first.rerun, false)
      const output = first.output as { replicaId: string; seed: number }
      // The old seed was the bare determinism constant, so every replica ran the source pass verbatim (spec 48).
      assert.notEqual(output.seed, ctx.fable51.seed(), 'the replica seed must be derived, not the bare determinism seed')
      assert.equal(output.replicaId, fingerprint({ passId: 'pass1', input: { q: 'sky' }, seed: output.seed }))

      const otherPass = await call(ctx, 'independent-replication', { passId: 'pass2', input: { q: 'sky' } })
      assert.notEqual((otherPass.output as { seed: number }).seed, output.seed, 'a different passId must derive a different seed')
      assert.equal((otherPass.output as { replicaId: string }).replicaId !== output.replicaId, true)

      const other = await call(ctx, 'independent-replication', { passId: 'pass1', input: { q: 'sea' } })
      assert.equal((other.output as { replicaId: string }).replicaId !== output.replicaId, true)
      assert.notEqual((other.output as { seed: number }).seed, output.seed, 'a different input must derive a different seed')

      const replay = await call(ctx, 'independent-replication', { passId: 'pass1', input: { q: 'sky' } })
      assert.equal(replay.rerun, true)
      assert.deepEqual(replay.output, first.output)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('spec 70, speculative-verify', () => {
  it('verifies a matching partial artifact and aborts on divergence', async () => {
    const ctx = await setup()
    try {
      const match = await call(ctx, 'speculative-verify', { partial: { ok: true, items: [1, 2] }, expectation: { ok: true, items: [1, 2] } })
      assert.equal(match.spec, '70')
      assert.equal(match.rerun, false)
      assert.deepEqual(match.output, { verdict: 'verified', diverged: false })

      const diverged = await call(ctx, 'speculative-verify', { partial: { ok: true, items: [1, 2] }, expectation: { ok: false, items: [1, 2] } })
      assert.deepEqual(diverged.output, { verdict: 'unverified', diverged: true })

      const other = await call(ctx, 'speculative-verify', { partial: 'half-written', expectation: 'complete' })
      assert.equal((other.output as { diverged: boolean }).diverged, true)

      const replay = await call(ctx, 'speculative-verify', { partial: { ok: true, items: [1, 2] }, expectation: { ok: true, items: [1, 2] } })
      assert.equal(replay.rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
