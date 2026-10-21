/**
 * Unit: the two-tenant sweep must drive the GENERATION path too.
 *
 * The tool path and the generation path do not agree on how a tenant is
 * found. A tool call carries the session object, so the working directory on
 * that object is enough to name the tenant. A generation names only a
 * session id, so the tenant has to come from the host session store, then
 * from this bundle's own registry, and only then from the default tenant.
 *
 * That difference is invisible to a sweep that only calls tools. A host
 * whose session store went blind still resolves every tool call correctly,
 * so a tool-only sweep reports PASS while the generation quietly books the
 * caller's tokens in the shared default bucket, where another tenant's spend
 * and history can be read.
 *
 * So these cases run the sweep on a healthy host, then break exactly the two
 * sources the generation path depends on, and require the sweep to report
 * the break while the tool path keeps passing. A sweep that still passed
 * after that sabotage would be a sweep watching the wrong path.
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
import { DEFAULT_SCOPE, DEFAULT_TENANT, tenantOfScope } from '../../src/state/tenant.ts'

/** Boot the real host services, in the order the shipped sweep command does. */
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
 * The checks the generation phase added, by name.
 *
 * The names are the contract: a sweep that renamed them would hide the
 * question "does the generation reach the caller's tenant" behind a label
 * nobody searches for.
 */
const GENERATION_CHECKS = [
  "the generation path charges the caller's tenant",
  "the generation path writes into the caller's tenant",
  'the generation path leaves the default tenant untouched',
] as const

/**
 * The checks that ask about the TOOL path.
 *
 * The sabotage in this file breaks the generation path only, so these must
 * keep passing. A sweep that failed on them too would be reporting a broken
 * host rather than a broken generation path, and would prove nothing about
 * the leak.
 *
 * The three default tenant checks are deliberately NOT in this list: the
 * leaked generation really does land in the default tenant, so those checks
 * fail as well, and that is the correct report of a leak rather than a
 * broken host.
 */
const TOOL_PATH_CHECKS = [
  'every tool answers in the first tenant',
  "the first tenant's calls left the second tenant untouched",
] as const

/**
 * The checks the tool sweep already made, before the generation phase.
 *
 * Adding the generation phase must not quietly drop or rename one of them: a
 * sweep that lost a check would report the same verdict on a host that
 * leaks.
 */
const ORIGINAL_CHECKS = [
  'every tool answers in the first tenant',
  'the first tenant owns the state it produced',
  "the first tenant's calls left the second tenant untouched",
  "the first tenant's calls left the default tenant untouched",
  'every tool answers in the second tenant too',
  "the second tenant's calls did not change the first tenant's state",
  'the two tenants hold the same amount of state',
  'no tenant call landed in the default tenant',
  'no state landed in a tenant other than the two swept',
  'a pure tool answers the same in both tenants',
  'the idempotency cache is per tenant',
  'the progress ring is per tenant',
  'the pass lineage is per tenant',
  'a stage budget spent in one tenant is not spent in the other',
] as const

/** The model name the sweep drives the generation with. */
const GENERATION_MODEL = 'sweep-model'

/** The stage the hook books the generation tokens under. */
const GENERATION_STAGE = `llm:${GENERATION_MODEL}`

/**
 * The chunks the sweep drives the generation with.
 *
 * The second chunk repeats the first, so the hook sees a duplicate chunk and
 * writes exactly one dedup line into the worklog of the tenant it charged.
 */
const GENERATION_CHUNKS = ['sweep ', 'sweep ']

/**
 * The tokens the hook counts for those chunks.
 *
 * The hook charges Math.ceil(text.length / 4) tokens per chunk, so the six
 * characters of 'sweep ' cost 2 tokens and the two chunks cost 4.
 */
const GENERATION_TOKENS = GENERATION_CHUNKS.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0)

/** One check of a report, by name. */
function checkNamed(checks: readonly SweepCheck[], name: string): SweepCheck {
  const found = checks.find((check) => check.name === name)
  assert.ok(found !== undefined, `the sweep has no check named '${name}', it has: ${checks.map((c) => c.name).join(' | ')}`)
  return found
}

/** The episodes that belong to one tenant. */
function episodesOf(ctx: Context, tenant: string): string[] {
  return ctx.fable51.episodes.keys().filter((key) => tenantOfScope(key) === tenant)
}

describe('the two-tenant sweep drives the generation path', () => {
  it('passes on a healthy host and reports the generation state', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)

      assert.equal(report.pass, true, `the sweep failed: ${report.failures.join(' | ')}`)
      assert.deepEqual(report.failures, [], 'a passing sweep names no failure')
      assert.equal(
        report.checks.length,
        17,
        'the sweep grew from 14 checks to 17: the tool sweep plus three generation checks',
      )

      for (const name of GENERATION_CHECKS) {
        const check = checkNamed(report.checks, name)
        assert.equal(check.pass, true, `check '${name}' failed: ${check.detail}`)
      }

      // The report has to say that the generation phase ran. A check that
      // was skipped and a check that passed look the same in a report that
      // only prints the tool sweep.
      const text = renderSweepReport(report)
      assert.ok(text.includes('generation'), `the report must name the generation phase: ${text.slice(-400)}`)
      for (const name of GENERATION_CHECKS) {
        assert.ok(text.includes(name), `the report must name the check '${name}'`)
      }

      // And the generation state must really exist, in BOTH swept tenants and
      // only there. A check that measures nothing passes for the wrong
      // reason.
      for (const tenant of report.tenants) {
        const keys = episodesOf(ctx, tenant)
        assert.ok(keys.length > 0, `the sweep must have an episode for the tenant ${tenant}`)
        const holders = keys.filter((key) => ctx.fable51.episode(key).stageTokens.get(GENERATION_STAGE) !== undefined)
        assert.equal(
          holders.length,
          1,
          `exactly one episode of ${tenant} must hold the generation stage, got: ${holders.join(' | ')}`,
        )
        assert.equal(
          ctx.fable51.episode(holders[0]!).stageTokens.get(GENERATION_STAGE),
          GENERATION_TOKENS,
          `the generation must charge ${tenant} the tokens of its own chunks`,
        )

        // The repeated chunk is accounted once, in the tenant that paid for
        // it. Two lines would mean the hook counted the same text twice.
        const dedupLines = ctx.fable51.worklogOf(holders[0]!).filter(
          (entry) => entry.stage === GENERATION_STAGE && entry.check === 'reasoning dedup',
        )
        assert.equal(
          dedupLines.length,
          1,
          `the repeated chunk must be accounted exactly once in ${tenant}, got ${dedupLines.length}`,
        )
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails when only the generation path loses its tenant', async () => {
    const ctx = await setup()
    try {
      // The breakage, aimed at the generation path alone. The host session
      // store goes blind and this bundle's own registry forgets every
      // session, so a session id can no longer be resolved to a tenant.
      // The TOOL path keeps working, because it reads the working directory
      // off the session object itself, and the session object is handed to
      // the tool whole.
      const blindStore = ctx.sessions as unknown as { get: (id: string) => unknown }
      blindStore.get = () => undefined
      ctx.fable51.tenants.tenantFor = () => undefined

      const report = await runTenantSweep(ctx)

      assert.equal(
        report.pass,
        false,
        'a generation that booked the caller tokens in the default tenant must fail the sweep',
      )

      // All three generation checks must fail. A sweep where only one of them
      // caught the leak would still pass a "at least one" assertion, and the
      // other two would be free to stop working.
      for (const name of GENERATION_CHECKS) {
        const check = checkNamed(report.checks, name)
        assert.equal(check.pass, false, `the generation check '${name}' must fail under the sabotage: ${check.detail}`)
        assert.ok(
          report.failures.some((failure) => failure.startsWith(name)),
          `the failure list must carry the failing check '${name}'`,
        )
        assert.ok(check.detail.length > 0, `failing check '${name}' must say what it saw`)
      }

      // The tool path must be untouched. If the whole sweep had failed, the
      // failure would tell nothing about the generation path.
      for (const name of TOOL_PATH_CHECKS) {
        const check = checkNamed(report.checks, name)
        assert.equal(check.pass, true, `the tool path check '${name}' must still pass: ${check.detail}`)
      }

      // And the leak is real: the tokens landed in the default tenant, which
      // is the bucket every unknown session shares.
      const defaultHolders = episodesOf(ctx, DEFAULT_TENANT).filter(
        (key) => ctx.fable51.episode(key).stageTokens.get(GENERATION_STAGE) !== undefined,
      )
      assert.ok(
        defaultHolders.length > 0,
        'the sabotaged generation must have booked its tokens in the default tenant',
      )
      assert.equal(
        ctx.fable51.episode(defaultHolders[0]!).stageTokens.get(GENERATION_STAGE),
        GENERATION_TOKENS,
        'the default tenant must show exactly the tokens the caller should have paid',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('leaves the default tenant without any generation state', async () => {
    const ctx = await setup()
    try {
      const report = await runTenantSweep(ctx)
      assert.equal(report.pass, true, `the sweep failed: ${report.failures.join(' | ')}`)

      // The worklog belongs to the TENANT, so any scope key of the default
      // tenant reads the same lines.
      const defaultWorklog = ctx.fable51.worklogOf(DEFAULT_SCOPE)
      const generationLines = defaultWorklog.filter((entry) => entry.stage.startsWith('llm:'))
      assert.deepEqual(
        generationLines.map((entry) => entry.stage),
        [],
        'the default tenant must own no generation line',
      )

      // And no episode of the default tenant holds the generation stage.
      for (const key of episodesOf(ctx, DEFAULT_TENANT)) {
        const stages = [...ctx.fable51.episode(key).stageTokens.keys()].filter((stage) => stage.startsWith('llm:'))
        assert.deepEqual(stages, [], `the default tenant episode ${key} must not hold a generation stage`)
        assert.equal(
          ctx.fable51.episode(key).stageTokens.get(GENERATION_STAGE),
          undefined,
          `the default tenant episode ${key} must not hold ${GENERATION_STAGE}`,
        )
      }

      // The generation really happened, so the two assertions above are not
      // vacuous: the state landed in the tenants that were swept.
      const sweptHolders = report.tenants.flatMap((tenant) => episodesOf(ctx, tenant)).filter(
        (key) => ctx.fable51.episode(key).stageTokens.get(GENERATION_STAGE) !== undefined,
      )
      assert.ok(
        sweptHolders.length > 0,
        'the swept tenants must hold the generation stage, or the default tenant owns nothing because nothing happened',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports the same way when the sweep runs twice in the same host', async () => {
    const ctx = await setup()
    try {
      // The worklog belongs to the TENANT, and the tenant of a sweep is its
      // working directory, so the second run finds the first run's
      // generation line already in the tenant it is about to measure. A
      // check that counts those lines absolutely would report a healthy
      // host as broken on the second run, so the generation checks have to
      // measure what THIS run added.
      const first = await runTenantSweep(ctx)
      assert.equal(first.pass, true, `the first sweep failed: ${first.failures.join(' | ')}`)

      const second = await runTenantSweep(ctx)
      assert.equal(second.pass, true, `the second sweep must also report: ${second.failures.join(' | ')}`)
      assert.deepEqual(second.failures, [], 'a repeated sweep must not report failures')
      assert.equal(second.checks.length, 17, 'the repeated sweep must make the same checks')
      for (const name of GENERATION_CHECKS) {
        const check = checkNamed(second.checks, name)
        assert.equal(check.pass, true, `check '${name}' failed on the second run: ${check.detail}`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps every check the tool sweep already made', async () => {
    const ctx = await setup()
    try {
      // The generation phase was added to the sweep, not swapped for the
      // old one. A renamed or dropped check would report the same verdict
      // on a host that leaks.
      const report = await runTenantSweep(ctx)

      for (const name of ORIGINAL_CHECKS) {
        const check = checkNamed(report.checks, name)
        assert.equal(check.pass, true, `check '${name}' failed: ${check.detail}`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports a generation leak that leaves no worklog line', async () => {
    const ctx = await setup()
    try {
      // The breakage: the generation books its tokens into the default
      // tenant WITHOUT writing a worklog line there. The worklog line is one
      // witness of a leak; the episodes are the other, because a leaked
      // generation is keyed by the session it leaked for, so the default
      // session's own episode looks empty. A sweep that only watched the
      // worklog would call this host clean.
      const svc = ctx.fable51 as unknown as {
        addStageTokens(key: string, stage: string, tokens: number): { used: number; alert: boolean; stop: boolean }
      }
      const original = svc.addStageTokens.bind(svc)
      svc.addStageTokens = (key: string, stage: string, tokens: number) => {
        const result = original(key, stage, tokens)
        if (stage === GENERATION_STAGE) original(`${DEFAULT_TENANT}::leaked-session`, stage, tokens)
        return result
      }

      const report = await runTenantSweep(ctx)

      assert.equal(
        report.pass,
        false,
        'a generation that booked tokens in the default tenant must fail the sweep even without a worklog line',
      )
      const check = checkNamed(report.checks, 'the generation path leaves the default tenant untouched')
      assert.equal(check.pass, false, `the default tenant check must fail: ${check.detail}`)
      assert.ok(
        check.detail.includes(DEFAULT_TENANT),
        `the failure must name the tenant that was polluted: ${check.detail}`,
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports instead of throwing when two tenants name the same session', async () => {
    const ctx = await setup()
    try {
      // The host refuses two live sessions with the same id, so a sweep that
      // reused the caller's session id verbatim would throw instead of
      // reporting. A check that crashes is not a check.
      const report = await runTenantSweep(ctx, [
        { cwd: '/work/collide-alpha', sessionId: 'collide' },
        { cwd: '/work/collide-bravo', sessionId: 'collide' },
      ])

      assert.equal(report.pass, true, `the sweep failed: ${report.failures.join(' | ')}`)
      assert.equal(report.tools, 92, 'the sweep must still cover every tool')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
