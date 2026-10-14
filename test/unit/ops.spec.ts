/**
 * Unit: the ops tool group — specs 21, 23, 24, 25, 26, 29, 30 (Gate 4f).
 *
 * Every tool is exercised through the real registry (typed envelope, spec id,
 * idempotent rerun) plus per-tool behavior assertions. The tools/result hook
 * also appends a `tool:<name>` worklog line on each execute, so a tool's own
 * worklog effect is isolated by its stage rather than by position or count.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Fable51Policy from '../../src/index.ts'

interface Envelope {
  ok: boolean
  spec: string
  output: Record<string, unknown>
  rerun: boolean
}

interface RunResult {
  isError: boolean
  value: Envelope
  content: unknown
}

// The full host set Fable51Policy injects (tools, llm, sessions): a reduced
// set leaves the service pending, so ctx.fable51 and its tools never register.
async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy, config)
  return ctx
}

async function execute(ctx: Context, name: string, args: unknown): Promise<RunResult> {
  const result = await ctx.tools.execute({ signal: new AbortController().signal, callId: ToolCallId(randomUUID()), name: `fable51_${name}`, arguments: args })
  assert.equal(result.isError, false, `fable51_${name} failed: ${JSON.stringify(result.content)}`)
  return result as unknown as RunResult
}

function envelope(result: RunResult): Envelope {
  return result.value
}

function worklogFor(ctx: Context, stage: string): Array<{ output: string; check: string; verdict: string; unverified: readonly string[] }> {
  return ctx.fable51.worklog.filter((entry) => entry.stage === stage)
}

describe('fable51 ops tools', () => {
  it('registers every ops tool under the fable51 namespace', async () => {
    const ctx = await setup()
    try {
      const names = ctx.tools.schemas().map((s) => s.name)
      for (const name of names) assert.match(name, /^fable51_/, `tool ${name} must stay namespaced`)
      for (const expected of ['timeboxing', 'conflict-resolution', 'observability', 'determinism', 'sandbox-boundaries', 'dependency-pinning', 'postmortem-format']) {
        assert.ok(names.includes(`fable51_${expected}`), `expected fable51_${expected} registered`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('21 timeboxing: expiry snapshots the stage, marks it unverified, logs discarded, and is idempotent', async () => {
    const ctx = await setup()
    try {
      const result = await execute(ctx, 'timeboxing', { stage: 'build', elapsedMs: 700_000 })
      const value = envelope(result)
      assert.equal(value.spec, '21')
      assert.equal(value.rerun, false)
      assert.equal(value.output.expired, true)
      assert.equal(value.output.snapshotId, 'build-timebox')
      const snapshot = ctx.fable51.snapshots.get('build-timebox')
      assert.ok(snapshot, 'expiry must write a snapshot')
      assert.equal(snapshot?.data.verdict, 'unverified')
      const logged = worklogFor(ctx, 'build')
      assert.equal(logged.length, 1)
      assert.equal(logged[0]?.verdict, 'discarded')
      assert.deepEqual(logged[0] && [...logged[0].unverified], ['stage timebox expired'])

      const rerun = await execute(ctx, 'timeboxing', { stage: 'build', elapsedMs: 700_000 })
      assert.equal(envelope(rerun).rerun, false, 'timeboxing is effectful: it must re-execute, not replay a cached answer')
      assert.equal(worklogFor(ctx, 'build').length, 2, 'each call records its own timebox line')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('21 timeboxing: within the deadline reports not-expired with no snapshot', async () => {
    const ctx = await setup()
    try {
      const value = envelope(await execute(ctx, 'timeboxing', { stage: 'plan', elapsedMs: 1_000 }))
      assert.equal(value.output.expired, false)
      assert.ok(!('snapshotId' in value.output), 'no snapshot id when within budget')
      assert.equal(ctx.fable51.snapshots.get('plan-timebox'), undefined)
      assert.equal(worklogFor(ctx, 'plan').length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('23 conflict-resolution: precedence spec > contract > subagent > memory resolves the winner', async () => {
    const ctx = await setup()
    try {
      const args = { conflicts: [{ source: 'memory', value: 'm' }, { source: 'contract', value: 'c' }, { source: 'spec', value: 's' }] }
      const value = envelope(await execute(ctx, 'conflict-resolution', args))
      assert.equal(value.spec, '23')
      assert.equal(value.output.winner, 's', 'spec outranks memory/contract regardless of order')
      assert.deepEqual(value.output.precedence, ['spec', 'contract', 'subagent', 'memory'])
      assert.equal(value.output.logged, true)
      const logged = worklogFor(ctx, 'conflict-resolution')
      assert.equal(logged.length, 1)
      assert.ok(logged[0]?.output.includes('s'), 'the winning value must be logged')

      assert.equal(envelope(await execute(ctx, 'conflict-resolution', args)).rerun, false)
      assert.equal(worklogFor(ctx, 'conflict-resolution').length, 2, 'an effectful tool logs on every call')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('23 conflict-resolution: first occurrence within a source wins; empty input yields a null winner', async () => {
    const first = envelope(await execute(await setup(), 'conflict-resolution', { conflicts: [{ source: 'subagent', value: 'a' }, { source: 'subagent', value: 'b' }] }))
    assert.equal(first.output.winner, 'a')

    const ctx = await setup()
    try {
      const empty = envelope(await execute(ctx, 'conflict-resolution', { conflicts: [] }))
      assert.equal(empty.output.winner, null)
      assert.equal(empty.output.logged, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('24 observability: emits a fingerprint trace id and one worklog line, idempotent on rerun', async () => {
    const ctx = await setup()
    try {
      const value = envelope(await execute(ctx, 'observability', { stage: 'research', verdict: 'contributed', tokens: 1234 }))
      assert.equal(value.spec, '24')
      assert.match(value.output.traceId as string, /^sha256:[0-9a-f]{64}$/)
      const line = value.output.line as string
      assert.ok(line.includes('stage=research') && line.includes('tokens=1234') && line.includes('verdict=contributed'))
      const logged = worklogFor(ctx, 'research')
      assert.equal(logged.length, 1)
      assert.equal(logged[0]?.output, line, 'the worklog line must equal the returned trace')
      assert.equal(logged[0]?.verdict, 'contributed')

      assert.equal(envelope(await execute(ctx, 'observability', { stage: 'research', verdict: 'contributed', tokens: 1234 })).rerun, false)
      assert.equal(worklogFor(ctx, 'research').length, 2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('25 determinism: reports fixed seed, stable order, and pinned versions', async () => {
    const ctx = await setup()
    try {
      const { seed, pinnedVersions } = ctx.fable51.config.determinism
      const value = envelope(await execute(ctx, 'determinism', { iteration: ['b', 'a', 'c'] }))
      assert.equal(value.spec, '25')
      assert.equal(value.output.seed, seed)
      assert.equal(value.output.iterationOrder, 'stable')
      assert.deepEqual(value.output.ordered, ['b', 'a', 'c'], 'stable order preserves input sequence')
      assert.deepEqual(value.output.pinnedVersions, pinnedVersions)

      assert.equal(envelope(await execute(ctx, 'determinism', { iteration: ['b', 'a', 'c'] })).rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('25 determinism: sorted iteration order returns a stably sorted sequence', async () => {
    const ctx = await setup({ determinism: { iterationOrder: 'sorted', seed: 7 } })
    try {
      const value = envelope(await execute(ctx, 'determinism', { iteration: [3, 1, 2, 1] }))
      assert.equal(value.output.iterationOrder, 'sorted')
      assert.equal(value.output.seed, 7)
      assert.deepEqual(value.output.ordered, [1, 1, 2, 3])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('26 sandbox-boundaries: empty allow-list allows read and denies write (escape action abort)', async () => {
    const ctx = await setup()
    try {
      const read = envelope(await execute(ctx, 'sandbox-boundaries', { path: 'src/index.ts', operation: 'read' }))
      assert.equal(read.spec, '26')
      assert.equal(read.output.allowed, true)
      assert.equal(read.output.escape, false)
      assert.equal(read.output.action, 'abort')
      assert.equal(worklogFor(ctx, 'sandbox-boundaries').length, 0, 'an allowed read is not logged')

      // escapeAction 'abort' is enforced now, not merely reported: the escape is
      // logged and the call comes back as an ok:false envelope.
      const write = envelope(await execute(ctx, 'sandbox-boundaries', { path: 'src/index.ts', operation: 'write' }))
      assert.equal(write.ok, false, 'an aborted escape must not report a usable result')
      const logged = worklogFor(ctx, 'sandbox-boundaries')
      assert.equal(logged.length, 1, 'an escape must be logged')
      assert.equal(logged[0]?.verdict, 'discarded')
      assert.ok(logged[0]?.unverified[0]?.includes('write src/index.ts'), 'the escape must be itemized')

      assert.equal(envelope(await execute(ctx, 'sandbox-boundaries', { path: 'src/index.ts', operation: 'write' })).ok, false)
      assert.equal(worklogFor(ctx, 'sandbox-boundaries').length, 2, 'each escape attempt is logged')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('26 sandbox-boundaries: a declared allow-list admits exact paths and escapes the rest (halt)', async () => {
    const ctx = await setup({ sandbox: { allowList: { read: ['src/a.ts'], write: ['src/a.ts'] }, escapeAction: 'halt' } })
    try {
      const ok = envelope(await execute(ctx, 'sandbox-boundaries', { path: 'src/a.ts', operation: 'read' }))
      assert.equal(ok.output.allowed, true, 'an exact allow-list path is admitted')
      assert.equal(ok.output.escape, false)
      assert.equal(ok.output.action, 'halt')
      assert.equal(worklogFor(ctx, 'sandbox-boundaries').length, 0, 'an in-bound access is not logged')

      const escape = envelope(await execute(ctx, 'sandbox-boundaries', { path: '/etc/passwd', operation: 'write' }))
      assert.equal(escape.output.allowed, false, 'a path outside the allow-list escapes')
      assert.equal(escape.output.escape, true)
      assert.equal(escape.output.action, 'halt', 'the configured escape action must be honored')
      assert.equal(worklogFor(ctx, 'sandbox-boundaries').length, 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('29 dependency-pinning: reports no drift when pinned and blocks on drift', async () => {
    const ctx = await setup()
    try {
      const pin = ctx.fable51.config.determinism.pinnedVersions.dsh as string
      const clean = envelope(await execute(ctx, 'dependency-pinning', { current: { dsh: pin } }))
      assert.equal(clean.spec, '29')
      assert.deepEqual(clean.output.drift, [])
      assert.equal(clean.output.blocked, false)

      const drifted = envelope(await execute(ctx, 'dependency-pinning', { current: { dsh: 'deadbeefdeadbeef' } }))
      assert.deepEqual(drifted.output.drift, ['dsh'])
      assert.equal(drifted.output.blocked, true, 'drift must block')

      assert.equal(envelope(await execute(ctx, 'dependency-pinning', { current: { dsh: 'deadbeefdeadbeef' } })).rerun, true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('30 postmortem-format: records what-failed/why/fix/catching-test, idempotent on rerun', async () => {
    const ctx = await setup()
    try {
      const args = { whatFailed: 'cache key collision', why: 'policy hash omitted', fix: 'hash policy into the key', catchingTest: 'ops rerun false then true' }
      const value = envelope(await execute(ctx, 'postmortem-format', args))
      assert.equal(value.spec, '30')
      assert.equal(value.output.recorded, true)
      const logged = worklogFor(ctx, 'postmortem')
      assert.equal(logged.length, 1)
      assert.ok(logged[0]?.output.includes('cache key collision'))
      assert.ok(logged[0]?.check.includes('ops rerun false then true'), 'the catching test must be carried in the check')

      assert.equal(envelope(await execute(ctx, 'postmortem-format', args)).rerun, false)
      assert.equal(worklogFor(ctx, 'postmortem').length, 2)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
