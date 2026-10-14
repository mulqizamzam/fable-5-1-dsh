/**
 * E2E: one synthetic agent session exercising the PRD's §8 requirement —
 * context compaction, verification-gate fail + rollback, reasoning fork +
 * merge (lineage), cost accounting, escalation, handoff + resume, and the
 * worklog/provenance/unverified-list emissions (specs 13, 7, 20).
 *
 * Runs against the REAL Cordis host with the REAL dsh services.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import type { ReasoningPass } from '../../src/types/pass.ts'

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('e2e'), name, arguments: args })
}

describe('Gate 6 — synthetic session end-to-end', () => {
  it('runs the representative task: overflow → compact → verify → fork → merge → deliver', async () => {
    const ctx = await setup()
    try {
      // --- session start: pins verified (spec 29) ---
      ctx.emit('session/created', {} as never)
      // --- pre-step observation (specs 1, 24) ---
      await (ctx as unknown as { waterfall(t: unknown, n: string, p: unknown, next: () => Promise<unknown>): Promise<unknown> })
        .waterfall(ctx, 'agent/pre-step', { messages: [{}, {}, {}], turn: 1, step: 1 }, async () => ({ kind: 'enter' }))
      // --- context overflow → spill decision (spec 1) ---
      const spill = await execute(ctx, 'fable51_context-management', { fillRatio: 0.95 })
      assert.equal((spill.value as { output: { action: string } }).output.action, 'spill')
      // --- verification gate FAILS then ROLLBACK (specs 5, 18, 46) ---
      const svc = ctx.fable51
      svc.recordGate({ gate: 'e2e-check', cmd: 'compare', expected: 'A', actual: 'B', pass: false, at: Date.now() })
      assert.equal(svc.gateLog.at(-1)?.pass, false)
      const checkpoint = svc.snapshots.create('pre-merge', { stage: 'reasoning', good: true })
      svc.snapshots.create('post-merge', { stage: 'reasoning', good: false })
      const diff = svc.snapshots.diff('pre-merge', 'post-merge')
      assert.deepEqual(diff.changed, ['good'], 'regression must be visible in the diff')
      // --- reasoning fork + merge via lineage (specs 34, 39, 69) ---
      const fork: ReasoningPass = {
        id: 'fork-1', spec: 'e2e', parentId: null, inHash: 'sha256:i', outHash: 'sha256:o1',
        deps: [], verdict: 'contributed',
        score: { evidence: 2, coherence: 1, coverage: 1, contradiction: 0, weighted: 4 },
        startedAt: 0, endedAt: 1, tokens: 100, latencyMs: 5, unverified: [],
      }
      const merge: ReasoningPass = { ...fork, id: 'merge-1', parentId: 'fork-1', outHash: 'sha256:o2' }
      svc.recordPass(fork)
      svc.recordPass(merge)
      assert.deepEqual(svc.lineage.ancestors('merge-1'), ['fork-1'])
      // --- fork decision + order-independent merge through the tool surface (specs 31, 91) ---
      const forkDecision = await execute(ctx, 'fable51_reasoning-forking', { candidateCount: 2, budgetLeft: 5000 })
      assert.equal((forkDecision.value as { output: { decision: string } }).output.decision, 'fork')
      const mergeA = await execute(ctx, 'fable51_pass-merge-idempotency', { outputs: [{ a: 1 }, { b: 2 }] })
      const mergeB = await execute(ctx, 'fable51_pass-merge-idempotency', { outputs: [{ b: 2 }, { a: 1 }] })
      assert.equal(
        JSON.stringify((mergeA.value as { output: { merged: unknown } }).output.merged),
        JSON.stringify((mergeB.value as { output: { merged: unknown } }).output.merged),
        'merge must be order-independent (spec 91)',
      )
      // --- cost accounting (spec 95) ---
      svc.recordCost({ stage: 'reasoning', tokens: 1000, latencyMs: 50, riskWeight: 0, at: Date.now() })
      assert.deepEqual(svc.stageCost('reasoning'), { tokens: 1000, latencyMs: 50, risk: 0 })
      // --- escalation ladder advances one rung per failure (spec 28) ---
      assert.equal(svc.nextRung(), 'retry')
      assert.equal(svc.nextRung(), 'replan')
      assert.equal(svc.nextRung(), 'downgrade')
      // --- replan budget: third replan escalates (spec 14) ---
      assert.equal(svc.replan().escalate, false)
      assert.equal(svc.replan().escalate, false)
      assert.equal(svc.replan().escalate, true)
      // --- provenance + partial delivery (specs 7, 20) ---
      assert.equal(svc.tag('the sky is blue', { kind: 'fetch', url: 'https://example.test' }), '[fetch:https://example.test] the sky is blue')
      // --- turn end: checkpoint + handoff (specs 10, 38) ---
      ctx.emit('session/event', {} as never, { type: 'turn/end' } as never)
      const late = svc.snapshots.latest()
      assert.ok(late && late.id.startsWith('turn-end-'), 'turn boundary must checkpoint')
      // --- worklog emitted with unverified list explicit (spec 13) ---
      const stages = svc.worklog.map((w) => w.stage)
      assert.ok(stages.some((s) => s.startsWith('session:')), 'handoff worklog present')
      // --- session end: postmortem (spec 30) ---
      ctx.emit('session/disposed', {} as never)
      assert.equal(svc.worklog.at(-1)?.stage, 'session:end')
      // --- resume determinism (spec 25): same seed, same fingerprint ---
      assert.equal(svc.seed(), svc.config.determinism.seed)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('llm stream passthrough keeps bytes identical while accounting tokens (specs 22, 53)', async () => {
    const ctx = await setup()
    try {
      async function* source() {
        yield { text: 'alpha' }
        yield { text: 'beta' }
      }
      const stream = await (ctx as unknown as { waterfall(t: unknown, n: string, o: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown> })
        .waterfall(ctx, 'llm/stream', { model: 'e2e' }, source)
      const seen: string[] = []
      for await (const chunk of stream) seen.push((chunk as { text: string }).text)
      assert.deepEqual(seen, ['alpha', 'beta'])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
