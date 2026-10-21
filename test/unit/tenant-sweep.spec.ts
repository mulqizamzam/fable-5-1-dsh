/**
 * Unit: the two-tenant sweep.
 *
 * The one-way sweep proved every tool answers, and the two-way sweep proved a
 * tool answers the same when it is called twice. Neither can see a leak
 * BETWEEN tenants: a tool that read the host-wide ledger answered perfectly
 * in a host of one tenant.
 *
 * So this file runs every tool in two tenants of the SAME host and asks
 * whether one tenant's calls changed what another tenant sees.
 *
 * The second half of the file is the part that matters most. A sweep that
 * cannot fail proves nothing, so the same sweep is run against a host whose
 * tenant mode puts every session in one bucket. That host leaks by
 * construction, and the sweep has to say so.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { runTenantSweep, renderSweepReport, type SweepCheck } from '../../src/sweep.ts'
import { allToolSpecs } from '../../src/tools/index.ts'

/** Boot the real host services, the way the shipped sweep command does. */
async function setup(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy, config)
  return ctx
}

/**
 * The checks that ask whether a tool answered at all.
 *
 * A sweep that failed only on these would be reporting a broken tool, not a
 * broken tenant boundary, so the sensitive case below looks for a failure
 * OUTSIDE this set.
 */
const TOOL_ANSWER_CHECKS = new Set([
  'every tool answers in the first tenant',
  'every tool answers in the second tenant too',
])

/** The checks the sweep must make, by name, and pass. */
const REQUIRED_CHECKS = [
  'every tool answers in the first tenant',
  'every tool answers in the second tenant too',
  "the first tenant's calls left the second tenant untouched",
  "the second tenant's calls did not change the first tenant's state",
  'the idempotency cache is per tenant',
  'the pass lineage is per tenant',
  'a pure tool answers the same in both tenants',
]

/** One check of a report, by name. */
function checkNamed(checks: readonly SweepCheck[], name: string): SweepCheck {
  const found = checks.find((check) => check.name === name)
  assert.ok(found !== undefined, `the sweep has no check named '${name}', it has: ${checks.map((c) => c.name).join(' | ')}`)
  return found
}

describe('two-tenant sweep', () => {
  it('passes in a real host with two tenants', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, true, `the sweep failed: ${report.failures.join(' | ')}`)
      assert.deepEqual(report.failures, [], 'a passing sweep has no failures')
      assert.ok(report.checks.length >= 10, `expected at least 10 checks, got ${report.checks.length}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sweeps every registered tool', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)

      // The count comes from the registry, not from a number typed in a test:
      // a tool added to the registry must be swept, and a tool removed must
      // not be counted.
      assert.equal(report.tools, allToolSpecs().length)
      assert.equal(report.tools, 92, 'the bundle ships 92 tools and the sweep must cover all of them')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('makes every named check and passes it', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)

      for (const name of REQUIRED_CHECKS) {
        const check = checkNamed(report.checks, name)
        assert.equal(check.pass, true, `check '${name}' failed: ${check.detail}`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('names every check it makes', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)

      assert.ok(report.checks.length > 0, 'the sweep made no check at all')
      for (const check of report.checks) {
        assert.equal(typeof check.name, 'string')
        assert.ok(check.name.length > 0, 'a check without a name cannot be read')
        assert.equal(typeof check.pass, 'boolean')
        assert.equal(typeof check.detail, 'string')
        assert.ok(check.detail.length > 0, `check '${check.name}' says nothing about what it saw`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('renders the report with a PASS verdict', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)
      const text = renderSweepReport(report)

      assert.ok(text.includes('VERDICT: PASS'), `expected the PASS verdict, got: ${text.slice(-200)}`)
      assert.ok(text.includes('two-tenant sweep'), 'the report must say what it is')
      assert.ok(text.includes(String(report.tools)), 'the report must say how many tools it swept')
      for (const check of report.checks) {
        assert.ok(text.includes(check.name), `the report must name the check '${check.name}'`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails on a host that puts every session in one tenant', async () => {
    // The sensitivity case. `mode: none` gives every session the same tenant
    // key, so the two swept sessions are the same tenant and every tenant
    // check in the sweep has to fire. A sweep that still passed here would be
    // a sweep that proves nothing.
    const ctx = await setup({ tenants: { mode: 'none' } })
    try {
      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, false, 'a host with one tenant for everybody must fail the sweep')
      assert.ok(report.failures.length > 0, 'the failing sweep must say what failed')

      const failed = report.checks.filter((check) => !check.pass)
      assert.ok(failed.length > 0, 'a failing report must name the checks that failed')
      for (const check of failed) {
        assert.ok(check.name.length > 0, 'a failing check must name itself')
        assert.ok(check.detail.length > 0, `failing check '${check.name}' must say what it saw`)
        assert.ok(
          report.failures.some((failure) => failure.startsWith(`${check.name}:`)),
          `the failure list must carry the failing check '${check.name}'`,
        )
      }

      // The failure has to be about the tenant boundary. A failure on the
      // two "every tool answers" checks would mean a tool broke, not that the
      // boundary leaked.
      const boundaryFailures = failed.filter((check) => !TOOL_ANSWER_CHECKS.has(check.name))
      assert.ok(
        boundaryFailures.length > 0,
        `the sweep must fail on the tenant boundary, not only on a broken tool: ${failed.map((c) => c.name).join(' | ')}`,
      )

      const text = renderSweepReport(report)
      assert.ok(text.includes('VERDICT: FAIL'), `expected the FAIL verdict, got: ${text.slice(-200)}`)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the two swept tenants apart in the report', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)

      assert.equal(report.tenants.length, 2)
      assert.notEqual(report.tenants[0], report.tenants[1], 'the two tenants must be different directories')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
