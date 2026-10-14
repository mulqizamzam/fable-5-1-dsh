/**
 * Verification tools — specs 5, 7, 12, 16, 19, 36, 47, 48, 70 (Gate 4b).
 *
 * Same contract as context.ts: typed envelope via defineTool, idempotent by
 * construction, side effects only through the policy service.
 */
import type { ToolSpec } from './shared.ts'
import { fingerprint } from '../state/cache.ts'
import type { GateResult } from '../types/gate.ts'
import type { ProvenanceTag } from '../policy-service.ts'

const VERIFIED = 'verified'
const UNVERIFIED = 'unverified'

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('arguments must be an object')
  }
  return args as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, key: string): string {
  if (!nonEmpty(value)) throw new Error(`${key} must be a non-empty string`)
  return value as string
}

export function verificationTools(): ToolSpec[] {
  return [
    {
      spec: '5',
      effectful: true,
      name: 'verification-gates',
      description: 'Run a verification gate that can fail: record {gate,cmd,expected,actual,pass} where pass is actual === expected (spec 5).',
      parameters: {
        type: 'object',
        required: ['check', 'cmd', 'expected', 'actual'],
        properties: {
          check: { type: 'string', description: 'What the gate verifies.' },
          cmd: { type: 'string', description: 'Command whose output the gate compares.' },
          expected: { type: 'string', description: 'Expected outcome for a passing gate.' },
          actual: { type: 'string', description: 'Observed outcome.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['gate', 'cmd', 'expected', 'actual', 'pass', 'at'],
        properties: {
          gate: { type: 'string', description: 'Gate name, carried over from check.' },
          cmd: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          pass: { type: 'boolean' },
          at: { type: 'number' },
        },
      },
      execute(args, { service }): GateResult {
        const record = asRecord(args)
        // Fail-loud: a gate that can fail cannot be recorded from missing
        // fields — undefined === undefined must never read as a pass (spec 5).
        const check = requireNonEmptyString(record.check, 'check')
        const cmd = requireNonEmptyString(record.cmd, 'cmd')
        const expected = requireNonEmptyString(record.expected, 'expected')
        const actual = requireNonEmptyString(record.actual, 'actual')
        return service.recordGate({ gate: check, cmd, expected, actual, pass: actual === expected, at: Date.now() })
      },
    },
    {
      spec: '7',
      name: 'research-provenance',
      description: 'Tag a claim with its source: [fetch:url] for fetched evidence, [mem:era] for memory, [inf] for inference (spec 7).',
      parameters: {
        type: 'object',
        required: ['claim', 'tag'],
        properties: {
          claim: { type: 'string', description: 'The claim being sourced.' },
          tag: {
            description: 'Provenance of the claim: fetch(url), mem(era), or inf.',
            oneOf: [
              {
                type: 'object',
                required: ['kind', 'url'],
                properties: {
                  kind: { type: 'string', const: 'fetch' },
                  url: { type: 'string' },
                },
              },
              {
                type: 'object',
                required: ['kind', 'era'],
                properties: {
                  kind: { type: 'string', const: 'mem' },
                  era: { type: 'string' },
                },
              },
              {
                type: 'object',
                required: ['kind'],
                properties: { kind: { type: 'string', const: 'inf' } },
              },
            ],
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['tagged'],
        properties: { tagged: { type: 'string', description: 'Claim prefixed with its provenance marker.' } },
      },
      execute(args, { service }): { tagged: string } {
        const { claim, tag } = args as { claim: string; tag: ProvenanceTag }
        return { tagged: service.tag(claim, tag) }
      },
    },
    {
      spec: '12',
      name: 'anti-introspection',
      description: 'Reject the claim "verified" without evidence: verdict is verified only when artifact, command, and output are all non-empty (spec 12).',
      parameters: {
        type: 'object',
        required: ['claim', 'artifact', 'command', 'output'],
        properties: {
          claim: { type: 'string', description: 'Claim under test; only "verified" can be certified.' },
          artifact: { type: 'string', description: 'Artifact the claim rests on.' },
          command: { type: 'string', description: 'Command that produced the artifact.' },
          output: { type: 'string', description: 'Observed command output.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['verdict', 'missing'],
        properties: {
          verdict: { type: 'string', enum: [VERIFIED, UNVERIFIED] },
          missing: { type: 'array', items: { type: 'string' } },
        },
      },
      execute(args): { verdict: string; missing: string[] } {
        const { claim, artifact, command, output } = args as { claim: string; artifact: string; command: string; output: string }
        const missing: string[] = []
        if (claim !== VERIFIED) missing.push(`claim ${JSON.stringify(claim)} is not a verification claim`)
        if (!nonEmpty(artifact)) missing.push('artifact')
        if (!nonEmpty(command)) missing.push('command')
        if (!nonEmpty(output)) missing.push('output')
        return { verdict: missing.length === 0 ? VERIFIED : UNVERIFIED, missing }
      },
    },
    {
      spec: '16',
      name: 'cold-verifier-isolation',
      description: 'Check that a cold verifier accepts only the spec and its artifact: extra input leaks producer context (spec 16).',
      parameters: {
        type: 'object',
        required: ['spec', 'artifact'],
        properties: {
          spec: { type: 'string', description: 'Spec the verifier is forked from.' },
          artifact: { type: 'string', description: 'Artifact under verification.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['isolated', 'violations'],
        properties: {
          isolated: { type: 'boolean' },
          violations: { type: 'array', items: { type: 'string' } },
        },
      },
      execute(args): { isolated: boolean; violations: string[] } {
        const { spec, artifact } = args as { spec: string; artifact: string }
        const violations: string[] = []
        if (!nonEmpty(spec)) violations.push('spec missing')
        if (!nonEmpty(artifact)) violations.push('artifact missing')
        for (const key of Object.keys(args as Record<string, unknown>)) {
          if (key !== 'spec' && key !== 'artifact') violations.push(`${key} leaks producer context into the verifier`)
        }
        return { isolated: violations.length === 0, violations }
      },
    },
    {
      spec: '19',
      // Reads the cache to answer firstSeen, so a replayed envelope would report
      // the first call's answer forever (spec 19).
      effectful: true,
      name: 'idempotency',
      description: 'Fingerprint an input and check the content-addressed cache before a rerun; firstSeen is true only on the first call (spec 19).',
      parameters: {
        type: 'object',
        required: ['input'],
        properties: { input: { description: 'Arbitrary JSON input to fingerprint.' } },
      },
      outputSchema: {
        type: 'object',
        required: ['hash', 'firstSeen'],
        properties: {
          hash: { type: 'string', description: 'sha256 cache key of the input.' },
          firstSeen: { type: 'boolean' },
        },
      },
      execute(args, { service }): { hash: string; firstSeen: boolean } {
        const { input } = args as { input: unknown }
        const hash = service.cache.key(input, 'idempotency-check', 'none')
        const firstSeen = service.cache.get(hash) === undefined
        if (firstSeen) service.cache.set(hash, hash)
        return { hash, firstSeen }
      },
    },
    {
      spec: '36',
      name: 'verifier-forking',
      description: 'Fork a verifier from the spec alone: verifierId fingerprints the spec, never the producer output (spec 36).',
      parameters: {
        type: 'object',
        required: ['spec', 'producerOutput'],
        properties: {
          spec: { type: 'string', description: 'Spec the verifier is forked from.' },
          producerOutput: { description: 'Producer output taken in but excluded from verifier identity.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['verifierId', 'producerExcluded'],
        properties: {
          verifierId: { type: 'string' },
          producerExcluded: { type: 'boolean' },
        },
      },
      execute(args): { verifierId: string; producerExcluded: boolean } {
        const { spec } = args as { spec: string; producerOutput: unknown }
        return { verifierId: fingerprint(spec), producerExcluded: true }
      },
    },
    {
      spec: '47',
      name: 'chain-of-verification',
      description: 'Build a layered verification chain where each layer checks the layer before it; fewer than two layers cannot be verified (spec 47).',
      parameters: {
        type: 'object',
        required: ['layers'],
        properties: {
          layers: { type: 'array', items: { type: 'string' }, description: 'Layer identifiers, oldest first.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['verdict', 'chain', 'unverified'],
        properties: {
          verdict: { type: 'string', enum: [VERIFIED, UNVERIFIED] },
          chain: {
            type: 'array',
            items: {
              type: 'object',
              required: ['layer', 'checks'],
              properties: {
                layer: { type: 'string' },
                checks: { oneOf: [{ type: 'null' }, { type: 'string' }] },
              },
            },
          },
          unverified: { type: 'array', items: { type: 'string' } },
        },
      },
      execute(args): { verdict: string; chain: { layer: string; checks: string | null }[]; unverified: string[] } {
        const raw = asRecord(args).layers
        // Without this the registry never checks parameters and layers.map blows up.
        // Two blank layers are not a two-layer chain, so they must not certify.
        if (!Array.isArray(raw) || raw.some((layer: unknown) => typeof layer !== 'string' || layer.trim().length === 0)) {
          throw new Error('layers must be an array of non-empty strings')
        }
        const layers = raw as string[]
        if (layers.length < 2) {
          return { verdict: UNVERIFIED, chain: [], unverified: ['a verification chain needs at least 2 layers'] }
        }
        return {
          verdict: VERIFIED,
          chain: layers.map((layer, index) => ({ layer, checks: (index > 0 ? layers[index - 1] : null) ?? null })),
          unverified: [],
        }
      },
    },
    {
      spec: '48',
      name: 'independent-replication',
      description: 'Replicate a pass under a different seed so replication is redundant rather than correlated (spec 48).',
      parameters: {
        type: 'object',
        required: ['passId', 'input'],
        properties: {
          passId: { type: 'string', description: 'Pass being replicated.' },
          input: { description: 'Input replicated under the derived seed.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['replicaId', 'seed'],
        properties: {
          replicaId: { type: 'string' },
          seed: { type: 'number' },
        },
      },
      execute(args, { service }): { replicaId: string; seed: number } {
        const { passId, input } = args as { passId: string; input: unknown }
        // A seed from service.seed() alone replicates the source run verbatim (spec 48).
        const seed = service.seed() + Number.parseInt(fingerprint({ passId, input }).slice(7, 15), 16)
        return { replicaId: fingerprint({ passId, input, seed }), seed }
      },
    },
    {
      spec: '70',
      name: 'speculative-verify',
      description: 'Verify a partial artifact against an expectation before the producer finishes; a divergence aborts speculative verification (spec 70).',
      parameters: {
        type: 'object',
        required: ['partial', 'expectation'],
        properties: {
          partial: { description: 'Partial artifact produced so far.' },
          expectation: { description: 'Expected artifact value.' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['verdict', 'diverged'],
        properties: {
          verdict: { type: 'string', enum: [VERIFIED, UNVERIFIED] },
          diverged: { type: 'boolean' },
        },
      },
      execute(args): { verdict: string; diverged: boolean } {
        const { partial, expectation } = args as { partial: unknown; expectation: unknown }
        // Canonical comparison: key order is not divergence (spec 70 + canonicality 65).
        const diverged = fingerprint(partial) !== fingerprint(expectation)
        return { verdict: diverged ? UNVERIFIED : VERIFIED, diverged }
      },
    },
  ]
}
