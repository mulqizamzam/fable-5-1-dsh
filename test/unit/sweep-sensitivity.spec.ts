/**
 * Unit: the two-tenant sweep must be able to FAIL.
 *
 * A check that cannot fail proves nothing, and a sweep that always passes is
 * worse than no sweep: it is a green light wired to nothing. So these cases
 * break the isolation on purpose and require the sweep to report the break.
 *
 * Two breakages are exercised, and they are the two shapes a cross-tenant
 * leak actually takes in this bundle:
 *
 * 1. Both tenants collapse into one bucket. Every tenant's state lands in the
 *    same place, so the second tenant sees the first tenant's ledger.
 * 2. The bundle forgets which tenant a session belongs to and falls back to
 *    the SHARED default bucket. This is the real bug: the session map was
 *    bounded and evicted oldest-first, so a long-lived host moved a live
 *    session's spend into a bucket every other unknown session also used.
 *
 * Both breakages are applied to a running host, so the sweep runs the same
 * code path it runs in production.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { runTenantSweep } from '../../src/sweep.ts'

async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy, config)
  return ctx
}

describe('the two-tenant sweep can fail', () => {
  it('reports the break when both tenants collapse into one bucket', async () => {
    const ctx = await setup()
    try {
      // The breakage: every session resolves to the same tenant, so the
      // second tenant reads the first tenant's ledger and history.
      const svc = ctx.fable51 as unknown as { tenantKeyFor: () => string }
      svc.tenantKeyFor = () => 'sabotaged-tenant'

      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, false, 'the sweep must report a collapsed tenant as a failure')
      assert.ok(report.failures.length > 0, 'a failed sweep must name what failed')
      for (const failure of report.failures) {
        assert.ok(failure.length > 0, 'every failure must carry a detail')
      }
      const failed = report.checks.filter((check) => !check.pass)
      assert.ok(failed.length > 0, 'at least one check must be marked failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the break when a forgotten session falls into the shared default bucket', async () => {
    const ctx = await setup()
    try {
      // The breakage, in the shape the bounded session map produced: the
      // bundle resolves a tenant from its own registry only, and a session
      // it no longer remembers lands in the bucket every unknown session
      // shares.
      const svc = ctx.fable51 as unknown as {
        scopeKeyOfSessionId: (id: string) => string
        tenantKeyFor: (session: unknown, sessionKey: string) => string
        tenants: { tenantFor(id: string): string | undefined; forget(id: string): void; remember(id: string, tenant: string): void }
      }
      svc.scopeKeyOfSessionId = (id: string): string => {
        const tenant = svc.tenants.tenantFor(id) ?? 'default'
        return `${tenant}::${id}`
      }
      svc.tenantKeyFor = (_session: unknown, sessionKey: string): string => {
        const tenant = svc.tenants.tenantFor(sessionKey) ?? 'default'
        svc.tenants.remember(sessionKey, tenant)
        return tenant
      }
      // The eviction: the registry no longer knows these sessions.
      svc.tenants.forget('sweep-alpha')
      svc.tenants.forget('sweep-bravo')

      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, false, 'the sweep must report a forgotten session as a failure')
      assert.ok(
        report.failures.some((failure) => failure.includes('default tenant')),
        `the shared default bucket must be named among the failures: ${report.failures.join(' | ')}`,
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the break when only the pass lineage is shared', async () => {
    const ctx = await setup()
    try {
      // The breakage: the lineage is shared while everything else stays
      // separate. A sweep that only checked "the tool did not refuse" would
      // pass here, because the second tenant's record of the same pass id
      // would be refused rather than duplicated. The check has to look at
      // what each tenant actually holds.
      const svc = ctx.fable51 as unknown as {
        lineageOf: (scopeKey: string) => { get(id: string): unknown }
      }
      const shared = svc.lineageOf('shared-probe')
      svc.lineageOf = () => shared

      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, false, 'the sweep must report a shared lineage as a failure')
      assert.ok(
        report.failures.some((failure) => failure.includes('pass lineage is per tenant')),
        `the shared lineage must be named among the failures: ${report.failures.join(' | ')}`,
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the passes it recorded, so the lineage check has something to measure', async () => {
    const ctx = await setup()
    try {
      // The sweep must not delete the state it is about to measure. The
      // pruning tools take a keep-set of live pass ids, and a generic value
      // would match no real pass and drop every pass the sweep recorded.
      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, true, 'a healthy host must pass the sweep')
      const lineageCheck = report.checks.find((check) => check.name === 'the pass lineage is per tenant')
      assert.ok(lineageCheck !== undefined, 'the lineage check must exist')
      assert.equal(lineageCheck.pass, true, `the lineage check failed: ${lineageCheck.detail}`)
      assert.ok(
        lineageCheck.detail.includes('sweep-dag'),
        `the lineage check must report the pass ids it looked for: ${lineageCheck.detail}`,
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('can run twice in the same host without throwing', async () => {
    const ctx = await setup()
    try {
      // The host refuses to create two sessions with the same id, so a sweep
      // that reused its ids threw on the second run instead of reporting. A
      // repeatable check must report again, not crash.
      const first = await runTenantSweep(ctx)
      assert.equal(first.pass, true, 'the first sweep must pass on a healthy host')

      const second = await runTenantSweep(ctx)
      assert.equal(second.pass, true, `the second sweep must also report: ${second.failures.join(' | ')}`)
      assert.equal(second.failures.length, 0, 'a repeated sweep must not report failures')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the break when the progress ring is shared', async () => {
    const ctx = await setup()
    try {
      // The breakage: every session gets the same progress ring, while the
      // counters stay apart. Nothing in the tool sweep writes progress, so
      // the sweep writes one note per tenant and checks that each tenant
      // sees only its own.
      const svc = ctx.fable51 as unknown as {
        episodes: { get(key: string): { progress: unknown[] } }
      }
      const sharedProgress: unknown[] = []
      const originalGet = svc.episodes.get.bind(svc.episodes)
      svc.episodes.get = (key: string) => {
        const episode = originalGet(key)
        Object.defineProperty(episode, 'progress', {
          get: () => sharedProgress,
          configurable: true,
        })
        return episode
      }

      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, false, 'the sweep must report a shared progress ring as a failure')
      assert.ok(
        report.failures.some((failure) => failure.includes('progress ring is per tenant')),
        `the shared progress ring must be named among the failures: ${report.failures.join(' | ')}`,
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
