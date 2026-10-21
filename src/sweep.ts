/**
 * The two-tenant sweep.
 *
 * A host serves many tenants, and each tenant has its own worklog, gate log,
 * cost ledger, pass lineage, snapshots and cache. The one-way sweep proved
 * every tool answers; the two-way sweep proved a tool answers the same when
 * called twice. Neither of those can see a leak BETWEEN tenants: a tool that
 * read the host-wide ledger answered perfectly in a host of one tenant.
 *
 * So this sweep runs every tool in TWO tenants of the SAME host and asks the
 * question the other sweeps cannot: did anything one tenant did change what
 * another tenant sees?
 *
 * The checks are deliberately about state, not about output equality. Output
 * equality is checked only for the pure tools, because an effectful tool is
 * allowed to answer differently when the ledger it reads is different. A
 * leak is proven by a COUNTER that moves in the wrong tenant, and a counter
 * cannot be argued away by a normalizer.
 *
 * The tool sweep resolves the tenant from the session object's own working
 * directory, so it never reaches the one surface that names a session id and
 * never a directory: the generation hook. The sweep drives that surface in
 * both tenants too, because a leak there would be invisible to every other
 * check here.
 */
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { isDeepStrictEqual } from 'node:util'
import { allToolSpecs } from './tools/index.ts'
import { argsFor, sweepPassIds } from './tools/args.ts'
import { DEFAULT_SCOPE, DEFAULT_TENANT, scopeKeyOf, tenantOfScope } from './state/tenant.ts'

/** One tenant of the sweep: a working directory, and the session in it. */
export interface SweepTenantSpec {
  readonly cwd: string
  readonly sessionId: string
}

/** One named check and its outcome. */
export interface SweepCheck {
  readonly name: string
  readonly pass: boolean
  readonly detail: string
}

/** What the sweep found. */
export interface SweepReport {
  readonly tools: number
  readonly tenants: readonly string[]
  readonly checks: readonly SweepCheck[]
  readonly failures: readonly string[]
  readonly pass: boolean
}

interface Envelope {
  readonly ok: boolean
  readonly spec: string
  readonly output: unknown
  readonly verdict: string
  readonly rerun: boolean
}

/**
 * The two tenants the sweep runs in. Different directories, by construction.
 */
export const DEFAULT_SWEEP_TENANTS: readonly SweepTenantSpec[] = [
  { cwd: '/work/sweep-alpha', sessionId: 'sweep-alpha' },
  { cwd: '/work/sweep-bravo', sessionId: 'sweep-bravo' },
]

/**
 * A counter that keeps the sweep's session ids unique.
 *
 * The host refuses to create two sessions with the same id, so a sweep that
 * reused its ids would throw on the second run instead of reporting. A
 * repeated sweep must report again, not crash.
 */
let sweepRunSeq = 0

/** The progress note the sweep writes into the first tenant. */
const ALPHA_PROGRESS_DETAIL = 'sweep probe in the first tenant'

/** The progress note the sweep writes into the second tenant. */
const BRAVO_PROGRESS_DETAIL = 'sweep probe in the second tenant'

/**
 * The stage the sweep spends its budget on.
 *
 * Both tenants spend the SAME amount here, on purpose: a shared budget would
 * show the double, and each tenant showing exactly one spend is the proof
 * that neither paid for the other.
 */
const BUDGET_STAGE = 'sweep'
const BUDGET_TOKENS = 10

/**
 * The model the sweep's generation run names.
 *
 * The hook charges the stage `llm:<model>`, so the name is part of the
 * measurement: it is how the sweep finds the tokens a generation spent.
 */
const GENERATION_MODEL = 'sweep-model'

/** The stage the generation hook charges the sweep's tokens to. */
const GENERATION_STAGE = `llm:${GENERATION_MODEL}`

/**
 * The chunks the generation run replays.
 *
 * The second chunk repeats the first on purpose: the duplicate is what makes
 * the hook write its worklog line, and that line is the only trace of the
 * tenant the hook charged. Both tenants get the same chunks, so the two stay
 * comparable.
 */
const GENERATION_CHUNKS: readonly string[] = ['sweep ', 'sweep ']

/**
 * The tokens one generation run costs.
 *
 * Two chunks of six characters, each charged as Math.ceil(6 / 4) = 2.
 */
const GENERATION_TOKENS = 4

/** Call one tool as one tenant, the way the agent loop does. */
async function callAs(
  ctx: Context,
  session: unknown,
  name: string,
  args: Record<string, unknown>,
  tag: string,
): Promise<Envelope> {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${tag}-${name}`),
    name: `fable51_${name}`,
    arguments: args,
    agent: { session } as never,
  })
  if (result.isError) {
    throw new Error(`tool fable51_${name} threw: ${JSON.stringify(result.content).slice(0, 300)}`)
  }
  return result.value as unknown as Envelope
}

/**
 * Drive one generation stream through the bundle's llm/stream hook.
 *
 * The hook resolves the tenant from the session id the request names, never
 * from a directory, so this is the one call in the sweep that can charge the
 * wrong tenant. The stream is drained because the hook accounts it in its
 * finally block, and that block only runs when the stream ends.
 */
async function generateAs(ctx: Context, sessionId: string): Promise<void> {
  async function* source(): AsyncIterable<unknown> {
    for (const text of GENERATION_CHUNKS) yield { text }
  }
  // The cast is required, not laziness: the host types the waterfall's
  // `this` as LlmRuntime, while the bundle drives it from a Context.
  const stream = await (ctx as unknown as {
    waterfall(t: unknown, n: string, o: unknown, next: () => AsyncIterable<unknown>): AsyncIterable<unknown>
  }).waterfall(ctx, 'llm/stream', { model: GENERATION_MODEL, sessionId }, source)
  for await (const _chunk of stream) {
    // The chunks are drained, not read: the sweep measures the state the
    // hook leaves behind, not the chunks themselves.
  }
}

/** The tokens one tenant's episode charged to one stage. */
function stageTokensOf(ctx: Context, scopeKey: string, stage: string): number {
  return ctx.fable51.episode(scopeKey).stageTokens.get(stage) ?? 0
}

/**
 * The worklog lines of one stage one tenant holds.
 *
 * The worklog belongs to the tenant, not to the run, so a second sweep in the
 * same host finds the lines the first one wrote. The sweep compares this
 * count before and after a generation, so what it measures is what this run
 * added: a generation that lands in the wrong tenant still adds its line
 * there, and the check still fails.
 */
function worklogLinesOfStage(ctx: Context, scopeKey: string, stage: string): number {
  return ctx.fable51.worklogOf(scopeKey).filter((entry) => entry.stage === stage).length
}

/**
 * The episodes one tenant owns.
 *
 * An episode is keyed by scope, so a tenant owns one per session that ran
 * in it. Looking at a single scope would miss the others, and a leak that
 * books into a session nobody looked at is exactly the kind that goes
 * unnoticed.
 */
function episodeKeysOfTenant(ctx: Context, tenant: string): string[] {
  return ctx.fable51.episodes.keys().filter((key) => tenantOfScope(key) === tenant)
}

/**
 * The size of every surface a tenant owns.
 *
 * The shared rings are per tenant; the run state is per session of a tenant.
 * Both are measured here, because a leak can hide in either: a shared
 * progress ring leaves every counter untouched.
 */
interface RingCounts {
  readonly worklog: number
  readonly gateLog: number
  readonly costLedger: number
  readonly lineage: number
  readonly snapshots: number
  readonly cache: number
  readonly progress: number
  readonly stageTokens: number
  readonly replans: number
  readonly rung: number
  readonly forks: number
  readonly merges: number
  readonly failingGates: number
  readonly turns: number
}

function ringCounts(ctx: Context, scopeKey: string): RingCounts {
  const svc = ctx.fable51
  const episode = svc.episode(scopeKey)
  let stageTokens = 0
  for (const tokens of episode.stageTokens.values()) stageTokens += tokens
  return {
    worklog: svc.worklogOf(scopeKey).length,
    gateLog: svc.gateLogOf(scopeKey).length,
    costLedger: svc.costLedgerOf(scopeKey).length,
    lineage: svc.lineageOf(scopeKey).all().length,
    snapshots: svc.snapshotsOf(scopeKey).ids().length,
    cache: svc.cacheOf(scopeKey).size,
    progress: episode.progress.length,
    stageTokens,
    replans: episode.replans,
    rung: episode.rung,
    forks: episode.forksThisStage,
    merges: episode.mergesThisStage,
    failingGates: episode.failingGates,
    turns: episode.turnCount,
  }
}

/** Surface sizes rendered for a report. */
function describeRings(counts: RingCounts): string {
  return `worklog=${counts.worklog} gates=${counts.gateLog} ledger=${counts.costLedger} lineage=${counts.lineage} snapshots=${counts.snapshots} cache=${counts.cache} progress=${counts.progress} stageTokens=${counts.stageTokens} replans=${counts.replans} rung=${counts.rung} forks=${counts.forks} merges=${counts.merges} failingGates=${counts.failingGates} turns=${counts.turns}`
}

/** True when a tenant owns nothing at all. */
function isEmpty(counts: RingCounts): boolean {
  return counts.worklog === 0
    && counts.gateLog === 0
    && counts.costLedger === 0
    && counts.lineage === 0
    && counts.snapshots === 0
    && counts.cache === 0
    && counts.progress === 0
    && counts.stageTokens === 0
}

/** The sweep itself. */
export async function runTenantSweep(
  ctx: Context,
  tenantSpecs: readonly SweepTenantSpec[] = DEFAULT_SWEEP_TENANTS,
): Promise<SweepReport> {
  const svc = ctx.fable51
  const checks: SweepCheck[] = []
  const failures: string[] = []

  const record = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail })
    if (!pass) failures.push(`${name}: ${detail}`)
  }

  const specs = allToolSpecs()
  const hostErrors: string[] = []
  const rejections: string[] = []

  // Both sessions exist before either sweep runs, so both scope keys come
  // from the service itself. Computing a key by hand would use the raw
  // directory while the service normalizes it, and a directory with a
  // trailing slash would point the check at a bucket nobody ever writes to.
  //
  // The session ids carry a run number and the tenant's position, because
  // the host refuses a duplicate id. Without the run number, a second sweep
  // in the same host threw instead of reporting. Without the position, two
  // tenants that happen to name the same session threw the same way.
  const runId = ++sweepRunSeq
  const runSuffix = `-${runId}`
  const firstSession = ctx.sessions.create(SessionId(`${tenantSpecs[0]!.sessionId}-${runId}-0`), {
    meta: { cwd: tenantSpecs[0]!.cwd },
  })
  const secondSession = ctx.sessions.create(SessionId(`${tenantSpecs[1]!.sessionId}-${runId}-1`), {
    meta: { cwd: tenantSpecs[1]!.cwd },
  })
  const firstScopeKey = svc.scopeKeyOfSession(firstSession)
  const secondScopeKey = svc.scopeKeyOfSession(secondSession)
  const secondAtStart = ringCounts(ctx, secondScopeKey)
  const firstOutputs = new Map<string, Envelope>()
  const firstReplays: string[] = []

  for (const spec of specs) {
    const args = argsFor(spec.name, runSuffix)
    let envelope: Envelope
    try {
      envelope = await callAs(ctx, firstSession, spec.name, args, 'sweep-a')
    } catch (error) {
      hostErrors.push(`${spec.name}: ${String(error)}`)
      continue
    }
    firstOutputs.set(spec.name, envelope)
    if (envelope.ok === false) rejections.push(`${spec.name}: ${JSON.stringify(envelope.output).slice(0, 200)}`)
    if (envelope.rerun === true) firstReplays.push(spec.name)
  }

  // A progress note in this tenant only, so the progress ring has something
  // to be checked against later.
  svc.recordProgress(firstScopeKey, 'stage-transition', ALPHA_PROGRESS_DETAIL)

  // The generation path, in this tenant only. It runs here, between the two
  // tool sweeps, so the other tenant is watched while the generation
  // happens: a generation that charged the wrong tenant would show up in the
  // snapshot of the tenant that did nothing.
  const alphaLinesBeforeOwn = worklogLinesOfStage(ctx, firstScopeKey, GENERATION_STAGE)
  const bravoLinesBeforeOwn = worklogLinesOfStage(ctx, secondScopeKey, GENERATION_STAGE)
  const defaultLinesBeforeOwn = worklogLinesOfStage(ctx, DEFAULT_SCOPE, GENERATION_STAGE)
  await generateAs(ctx, firstSession.id)
  const alphaTokensAfterOwn = stageTokensOf(ctx, firstScopeKey, GENERATION_STAGE)
  const bravoTokensBeforeOwn = stageTokensOf(ctx, secondScopeKey, GENERATION_STAGE)
  const alphaLinesAfterOwn = worklogLinesOfStage(ctx, firstScopeKey, GENERATION_STAGE)
  const bravoLinesAfterOwn = worklogLinesOfStage(ctx, secondScopeKey, GENERATION_STAGE)
  const defaultLinesAfterOwn = worklogLinesOfStage(ctx, DEFAULT_SCOPE, GENERATION_STAGE)

  const afterFirst = ringCounts(ctx, firstScopeKey)
  const secondAfterFirst = ringCounts(ctx, secondScopeKey)
  // The default tenant's rings are sampled AFTER the first generation, so
  // the checks below that watch the default tenant also report a generation
  // that leaked into it. Their names say "call", and a generation is a call
  // into the service, so a leak there belongs in their report as well. The
  // three generation checks own the generation path on their own.
  const defaultBefore = ringCounts(ctx, DEFAULT_SCOPE)

  record(
    'every tool answers in the first tenant',
    hostErrors.length === 0 && rejections.length === 0,
    hostErrors.length === 0 && rejections.length === 0
      ? `${specs.length} tools, no host error, no refusal`
      : [...hostErrors, ...rejections].join(' | '),
  )

  record(
    'the first tenant owns the state it produced',
    afterFirst.worklog > 0 && afterFirst.costLedger > 0,
    describeRings(afterFirst),
  )

  record(
    "the first tenant's calls left the second tenant untouched",
    isDeepStrictEqual(secondAtStart, secondAfterFirst),
    `before ${describeRings(secondAtStart)} | after ${describeRings(secondAfterFirst)}`,
  )

  record(
    "the first tenant's calls left the default tenant untouched",
    isEmpty(defaultBefore),
    describeRings(defaultBefore),
  )

  // --- Phase 2: sweep the second tenant, and watch the first one. ------------
  const secondOutputs = new Map<string, Envelope>()
  const secondReplays: string[] = []

  for (const spec of specs) {
    const args = argsFor(spec.name, runSuffix)
    let envelope: Envelope
    try {
      envelope = await callAs(ctx, secondSession, spec.name, args, 'sweep-b')
    } catch (error) {
      hostErrors.push(`${spec.name}: ${String(error)}`)
      continue
    }
    secondOutputs.set(spec.name, envelope)
    if (envelope.ok === false) rejections.push(`${spec.name}: ${JSON.stringify(envelope.output).slice(0, 200)}`)
    if (envelope.rerun === true) secondReplays.push(spec.name)
  }

  svc.recordProgress(secondScopeKey, 'stage-transition', BRAVO_PROGRESS_DETAIL)

  // The generation path, in this tenant too, with the same chunks.
  const alphaLinesBeforeSecond = worklogLinesOfStage(ctx, firstScopeKey, GENERATION_STAGE)
  const bravoLinesBeforeSecond = worklogLinesOfStage(ctx, secondScopeKey, GENERATION_STAGE)
  const defaultLinesBeforeSecond = worklogLinesOfStage(ctx, DEFAULT_SCOPE, GENERATION_STAGE)
  await generateAs(ctx, secondSession.id)
  const bravoTokensAfterOwn = stageTokensOf(ctx, secondScopeKey, GENERATION_STAGE)
  const alphaTokensAfterSecond = stageTokensOf(ctx, firstScopeKey, GENERATION_STAGE)
  const alphaLinesAfterSecond = worklogLinesOfStage(ctx, firstScopeKey, GENERATION_STAGE)
  const bravoLinesAfterSecond = worklogLinesOfStage(ctx, secondScopeKey, GENERATION_STAGE)
  const defaultLinesAfterSecond = worklogLinesOfStage(ctx, DEFAULT_SCOPE, GENERATION_STAGE)

  const afterSecond = ringCounts(ctx, secondScopeKey)
  const firstAfter = ringCounts(ctx, firstScopeKey)
  const defaultAfter = ringCounts(ctx, DEFAULT_SCOPE)

  record(
    'every tool answers in the second tenant too',
    hostErrors.length === 0 && rejections.length === 0,
    hostErrors.length === 0 && rejections.length === 0
      ? `${specs.length} tools, no host error, no refusal`
      : [...hostErrors, ...rejections].join(' | '),
  )

  record(
    "the second tenant's calls did not change the first tenant's state",
    isDeepStrictEqual(afterFirst, firstAfter),
    `before ${describeRings(afterFirst)} | after ${describeRings(firstAfter)}`,
  )

  record(
    'the two tenants hold the same amount of state',
    isDeepStrictEqual(afterFirst, afterSecond),
    `alpha ${describeRings(afterFirst)} | bravo ${describeRings(afterSecond)}`,
  )

  record(
    'no tenant call landed in the default tenant',
    isEmpty(defaultAfter),
    describeRings(defaultAfter),
  )

  // The two tenants named above are the only ones allowed to own state. A
  // leak into a THIRD bucket would slip past the "the other tenant is
  // untouched" checks, because those check two known keys. This one looks at
  // every tenant the host knows and asks whether it holds anything.
  const expectedTenants = new Set<string>([
    tenantOfScope(firstScopeKey),
    tenantOfScope(secondScopeKey),
  ])
  const strayTenants: string[] = []
  for (const tenant of svc.tenants.keys()) {
    if (expectedTenants.has(tenant)) continue
    const counts = ringCounts(ctx, scopeKeyOf(tenant, 'stray'))
    if (!isEmpty(counts)) strayTenants.push(`${tenant} (${describeRings(counts)})`)
  }

  record(
    'no state landed in a tenant other than the two swept',
    strayTenants.length === 0,
    strayTenants.length === 0
      ? 'every tenant that owns state is one of the two swept'
      : strayTenants.join(' | '),
  )

  // A pure tool's answer is a function of its input alone, so it must be the
  // same answer in both tenants. An effectful tool is allowed to differ: it
  // reads live state, and the two tenants' state differs by design.
  const pureMismatches: string[] = []
  for (const spec of specs) {
    if (spec.effectful === true) continue
    const a = firstOutputs.get(spec.name)
    const b = secondOutputs.get(spec.name)
    if (a === undefined || b === undefined) continue
    if (!isDeepStrictEqual(a.output, b.output)) {
      pureMismatches.push(`${spec.name}: ${JSON.stringify(a.output).slice(0, 160)} != ${JSON.stringify(b.output).slice(0, 160)}`)
    }
    if (a.verdict !== b.verdict) {
      pureMismatches.push(`${spec.name}: verdict ${a.verdict} != ${b.verdict}`)
    }
  }

  record(
    'a pure tool answers the same in both tenants',
    pureMismatches.length === 0,
    pureMismatches.length === 0
      ? 'every pure tool gave the same answer in both tenants'
      : pureMismatches.join(' | '),
  )

  // The idempotency cache belongs to the tenant. Two things prove it: the
  // two tenants do not hold the same cache OBJECT, and they replay the same
  // number of calls. A cache shared by the host would serve the second
  // tenant from the first tenant's stored output, so the second tenant
  // would replay far more than the first. Comparing the replay counts also
  // keeps the check honest on a repeated sweep, where both tenants replay
  // their own earlier answers.
  const sameCacheObject = svc.cacheOf(firstScopeKey) === svc.cacheOf(secondScopeKey)
  const replayCountsMatch = firstReplays.length === secondReplays.length
  const cacheProblems: string[] = []
  if (sameCacheObject) cacheProblems.push('both tenants share one cache object')
  if (!replayCountsMatch) {
    cacheProblems.push(`alpha replayed ${firstReplays.length} calls, bravo replayed ${secondReplays.length}`)
  }

  record(
    'the idempotency cache is per tenant',
    cacheProblems.length === 0,
    cacheProblems.length === 0
      ? `each tenant has its own cache, ${firstReplays.length} replays on each side`
      : cacheProblems.join(' | '),
  )

  // The progress ring of a run is per session of a tenant. The sweep writes
  // one note per tenant and then checks that each tenant sees its own note
  // and never the other tenant's. A shared ring would leave both tenants
  // holding both notes. The counts are compared too, because a ring that
  // lost a note would slip past the content check alone.
  const alphaProgress = svc.progress(firstScopeKey)
  const bravoProgress = svc.progress(secondScopeKey)
  const alphaDetails = alphaProgress.map((record) => record.detail)
  const bravoDetails = bravoProgress.map((record) => record.detail)
  const progressProblems: string[] = []
  if (!alphaDetails.includes(ALPHA_PROGRESS_DETAIL)) {
    progressProblems.push('the first tenant does not hold its own progress note')
  }
  if (!bravoDetails.includes(BRAVO_PROGRESS_DETAIL)) {
    progressProblems.push('the second tenant does not hold its own progress note')
  }
  if (alphaDetails.includes(BRAVO_PROGRESS_DETAIL)) {
    progressProblems.push('the first tenant holds the second tenant progress note')
  }
  if (bravoDetails.includes(ALPHA_PROGRESS_DETAIL)) {
    progressProblems.push('the second tenant holds the first tenant progress note')
  }
  if (alphaDetails.length !== bravoDetails.length) {
    progressProblems.push(`alpha holds ${alphaDetails.length} progress records, bravo holds ${bravoDetails.length}`)
  }

  record(
    'the progress ring is per tenant',
    progressProblems.length === 0,
    progressProblems.length === 0
      ? 'each tenant holds only its own progress note'
      : progressProblems.join(' | '),
  )

  // The lineage is append-only PER TENANT, so the same pass id must be
  // accepted in both tenants, and each tenant must end up holding its own
  // copy of that pass. A shared lineage would refuse the second tenant's
  // record with "already recorded"; a lineage that was emptied would hold
  // nothing at all. Asserting only the absence of a refusal would miss both,
  // and a check that cannot fail is not a check.
  const lineageProblems: string[] = []
  for (const name of ['reasoning-dag', 'reasoning-lineage']) {
    for (const [label, outputs] of [['alpha', firstOutputs], ['bravo', secondOutputs]] as const) {
      const envelope = outputs.get(name)
      if (envelope !== undefined && envelope.ok === false) {
        lineageProblems.push(`${name} in ${label} refused: ${JSON.stringify(envelope.output).slice(0, 160)}`)
      }
    }
  }
  for (const [label, scopeKey] of [['alpha', firstScopeKey], ['bravo', secondScopeKey]] as const) {
    const lineage = svc.lineageOf(scopeKey)
    for (const passId of sweepPassIds(runSuffix)) {
      if (lineage.get(passId) === undefined) {
        lineageProblems.push(`${label} lineage does not hold ${passId}`)
      }
    }
  }
  // Two tenants holding the same lineage OBJECT is a shared lineage even when
  // the recorded ids differ, so the objects themselves are compared.
  if (svc.lineageOf(firstScopeKey) === svc.lineageOf(secondScopeKey)) {
    lineageProblems.push('both tenants share one lineage object')
  }

  record(
    'the pass lineage is per tenant',
    lineageProblems.length === 0,
    lineageProblems.length === 0
      ? `each tenant holds its own copy of ${sweepPassIds(runSuffix).join(', ')}`
      : lineageProblems.join(' | '),
  )

  // A budget spent in one tenant is not spent in another. Both tenants spend
  // the same amount here on purpose: a SHARED budget would show the double,
  // and each tenant showing exactly one spend is the proof that neither paid
  // for the other.
  const spendInAlpha = svc.episode(firstScopeKey).stageTokens.get(BUDGET_STAGE) ?? 0
  const spendInBravo = svc.episode(secondScopeKey).stageTokens.get(BUDGET_STAGE) ?? 0

  record(
    'a stage budget spent in one tenant is not spent in the other',
    spendInAlpha === BUDGET_TOKENS && spendInBravo === BUDGET_TOKENS,
    `alpha=${spendInAlpha} bravo=${spendInBravo} (each must be ${BUDGET_TOKENS})`,
  )

  // The generation path charges the tenant that asked for the generation.
  // Four tokens each is the measured value: two chunks of six characters,
  // each charged as Math.ceil(6 / 4). The zeros are the isolation proof:
  // the first tenant's generation charged the second tenant nothing, and the
  // second tenant's generation left the first tenant's count alone.
  const generationTokenProblems: string[] = []
  if (alphaTokensAfterOwn !== GENERATION_TOKENS) {
    generationTokenProblems.push(`the first tenant holds ${alphaTokensAfterOwn} ${GENERATION_STAGE} tokens, it must hold ${GENERATION_TOKENS}`)
  }
  if (bravoTokensBeforeOwn !== 0) {
    generationTokenProblems.push(`the second tenant held ${bravoTokensBeforeOwn} ${GENERATION_STAGE} tokens before its own generation`)
  }
  if (bravoTokensAfterOwn !== GENERATION_TOKENS) {
    generationTokenProblems.push(`the second tenant holds ${bravoTokensAfterOwn} ${GENERATION_STAGE} tokens, it must hold ${GENERATION_TOKENS}`)
  }
  if (alphaTokensAfterSecond !== alphaTokensAfterOwn) {
    generationTokenProblems.push(`the first tenant's count went from ${alphaTokensAfterOwn} to ${alphaTokensAfterSecond} when the second tenant generated`)
  }

  record(
    "the generation path charges the caller's tenant",
    generationTokenProblems.length === 0,
    generationTokenProblems.length === 0
      ? `each tenant charged ${GENERATION_TOKENS} tokens to ${GENERATION_STAGE}, the other tenant charged none`
      : generationTokenProblems.join(' | '),
  )

  // The hook writes one worklog line for the duplicate chunk. That line is
  // the only trace of the tenant the hook charged, so it has to sit in the
  // caller's tenant: one line there, none in the default tenant. The count
  // is the one this run added, because the worklog belongs to the tenant and
  // a second sweep in the same host finds the first sweep's line.
  const alphaGenerationLines = (alphaLinesAfterOwn - alphaLinesBeforeOwn) + (alphaLinesAfterSecond - alphaLinesBeforeSecond)
  const bravoGenerationLines = (bravoLinesAfterOwn - bravoLinesBeforeOwn) + (bravoLinesAfterSecond - bravoLinesBeforeSecond)
  const defaultGenerationLines = (defaultLinesAfterOwn - defaultLinesBeforeOwn) + (defaultLinesAfterSecond - defaultLinesBeforeSecond)
  const generationWriteProblems: string[] = []
  if (alphaGenerationLines !== 1) {
    generationWriteProblems.push(`the first tenant gained ${alphaGenerationLines} ${GENERATION_STAGE} worklog lines, it must gain exactly one`)
  }
  if (bravoGenerationLines !== 1) {
    generationWriteProblems.push(`the second tenant gained ${bravoGenerationLines} ${GENERATION_STAGE} worklog lines, it must gain exactly one`)
  }
  if (defaultGenerationLines !== 0) {
    generationWriteProblems.push(`the default tenant gained ${defaultGenerationLines} ${GENERATION_STAGE} worklog lines, it must gain none`)
  }
  // Two tenants holding one worklog OBJECT is one tenant wearing two names:
  // the line each of them counted would be the same line.
  if (svc.worklogOf(firstScopeKey) === svc.worklogOf(secondScopeKey)) {
    generationWriteProblems.push('both tenants share one worklog object')
  }

  record(
    "the generation path writes into the caller's tenant",
    generationWriteProblems.length === 0,
    generationWriteProblems.length === 0
      ? 'each tenant gained exactly one generation worklog line, the default tenant gained none'
      : generationWriteProblems.join(' | '),
  )

  // The default tenant is a real bucket, so a generation that leaked into it
  // is a tenant that owns state nobody asked for.
  //
  // Two witnesses are needed, because they fail in different ways. The
  // worklog line catches a leak that left a trail. The EPISODES catch a leak
  // that only charged tokens: a leaked generation is keyed by the session it
  // leaked for, so the default session's own episode stays empty and the
  // default tenant's rings look untouched.
  //
  // The comparison is a delta, so a default tenant that already held
  // something from an unrelated session does not make this check fail. That
  // case belongs to the check that asks whether the default tenant is empty
  // at all, and this one asks only about the generation path.
  const defaultGenerationProblems: string[] = []
  if (defaultGenerationLines !== 0) {
    defaultGenerationProblems.push(`the default tenant gained ${defaultGenerationLines} ${GENERATION_STAGE} worklog lines`)
  }
  const defaultHolders = episodeKeysOfTenant(ctx, DEFAULT_TENANT).filter(
    (key) => svc.episode(key).stageTokens.get(GENERATION_STAGE) !== undefined,
  )
  if (defaultHolders.length > 0) {
    defaultGenerationProblems.push(`the default tenant holds ${GENERATION_STAGE} tokens in ${defaultHolders.join(' | ')}`)
  }

  record(
    'the generation path leaves the default tenant untouched',
    defaultGenerationProblems.length === 0,
    defaultGenerationProblems.length === 0
      ? 'the default tenant owns no generation state'
      : defaultGenerationProblems.join(' | '),
  )

  return {
    tools: specs.length,
    tenants: [tenantSpecs[0]!.cwd, tenantSpecs[1]!.cwd],
    checks,
    failures,
    pass: failures.length === 0,
  }
}

/** Render the report as the plain lines a terminal can read. */
export function renderSweepReport(report: SweepReport): string {
  const lines: string[] = []
  lines.push('=== fable51 two-tenant sweep ===')
  lines.push('')
  lines.push(`Tools swept: ${report.tools}`)
  lines.push(`Tenants: ${report.tenants.join(', ')}`)
  lines.push('')
  lines.push('Checks:')
  for (const check of report.checks) {
    lines.push(`  ${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`)
    if (!check.pass) lines.push(`        ${check.detail}`)
  }
  lines.push('')
  lines.push(report.pass ? 'VERDICT: PASS' : `VERDICT: FAIL (${report.failures.length} check(s) failed)`)
  return lines.join('\n')
}
