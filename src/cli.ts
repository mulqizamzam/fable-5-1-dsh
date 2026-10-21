/**
 * fable51 CLI: Policy Visualizer, Budget Advisor & two-tenant sweep.
 *
 * Compiled to lib/cli.js by the main build so the published package ships a
 * working `fable51` binary: bin/fable51.js is a thin shim onto this module.
 *
 * Usage:
 *   fable51 inspect [--format json|ascii] [--include-worklog] [--include-gate-log]
 *   fable51 advise-budget <taskClass> [--history-window N] [--min-samples N] [--format json|ascii]
 *   fable51 sweep [--format json|ascii]
 */
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from './index.ts'
import { runTenantSweep, renderSweepReport } from './sweep.ts'

const USAGE = [
  'Usage: fable51 <inspect|advise-budget|sweep> [options]',
  '',
  'Commands:',
  '  inspect          Render policy visualizer',
  '                 --format json|ascii  --include-worklog  --include-gate-log',
  '  advise-budget    Recommend budget config for a task class',
  '                 <bounded|search|multihop|open>',
  '                 --history-window N  --min-samples N  --format json|ascii',
  '  sweep            Run every tool in two tenants of one host and report the checks',
  '                 --format json|ascii',
].join('\n')

/** Boot the real Cordis host with the bundle and the four services it injects. */
async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Fable51Policy)
  return ctx
}

/** Read `--flag value` or `--flag=value` from argv; returns undefined when the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`))
  if (inline !== undefined) return inline.slice(flag.length + 1)
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

/** Read `--format`; only the two documented formats are accepted. */
function formatValue(args: string[]): { ok: true; format: 'json' | 'ascii' } | { ok: false; error: string } {
  const raw = flagValue(args, '--format')
  if (raw === undefined) {
    return args.includes('--format')
      ? { ok: false, error: '--format requires a value: json or ascii' }
      : { ok: true, format: 'ascii' }
  }
  if (raw === 'json' || raw === 'ascii') return { ok: true, format: raw }
  return { ok: false, error: `--format must be json or ascii, got '${raw}'` }
}

async function runInspect(args: string[]): Promise<number> {
  const parsed = formatValue(args)
  if (!parsed.ok) {
    console.error(parsed.error)
    return 1
  }
  const format = parsed.format
  const includeWorklog = hasFlag(args, '--include-worklog')
  const includeGateLog = hasFlag(args, '--include-gate-log')

  const ctx = await boot()
  try {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'cli-inspect' as never,
      name: 'fable51_inspect',
      arguments: { format, includeWorklog, includeGateLog },
    })

    if (result.isError) {
      console.error('Error:', result.content)
      return 1
    }

    const value = result.value as { output?: { ascii?: string } } & Record<string, unknown>
    if (format === 'json') {
      console.log(JSON.stringify(value, null, 2))
      return 0
    }
    // The rendered text lives inside the tool's output, not on the envelope.
    const ascii = value.output?.ascii
    if (typeof ascii === 'string') {
      console.log(ascii)
    } else {
      console.log(JSON.stringify(value, null, 2))
    }
    return 0
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runAdviseBudget(args: string[]): Promise<number> {
  const taskClass = args[0]
  if (taskClass === undefined || !['bounded', 'search', 'multihop', 'open'].includes(taskClass)) {
    console.error('Usage: fable51 advise-budget <bounded|search|multihop|open> [--history-window N] [--min-samples N] [--format json|ascii]')
    return 1
  }

  const historyWindowRaw = flagValue(args, '--history-window')
  const minSamplesRaw = flagValue(args, '--min-samples')
  const parsed = formatValue(args)
  if (!parsed.ok) {
    console.error(parsed.error)
    return 1
  }
  const format = parsed.format
  const historyWindow = historyWindowRaw === undefined ? 5000 : Number.parseInt(historyWindowRaw, 10)
  const minSamples = minSamplesRaw === undefined ? 2 : Number.parseInt(minSamplesRaw, 10)
  if (!Number.isSafeInteger(historyWindow) || historyWindow < 1) {
    console.error('--history-window must be a positive integer')
    return 1
  }
  if (!Number.isSafeInteger(minSamples) || minSamples < 1) {
    console.error('--min-samples must be a positive integer')
    return 1
  }

  const ctx = await boot()
  try {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'cli-advise-budget' as never,
      name: 'fable51_budget-advisor',
      arguments: { taskClass, historyWindow, minSamplesPerStage: minSamples },
    })

    if (result.isError) {
      console.error('Error:', result.content)
      return 1
    }

    const value = result.value as { output?: Record<string, unknown> } & Record<string, unknown>
    if (format === 'json') {
      console.log(JSON.stringify(value, null, 2))
      return 0
    }

    const out = value.output
    if (out === undefined) {
      console.log(JSON.stringify(value, null, 2))
      return 0
    }
    const recommended = out.recommended as { stageTokenBudget: number; maxForkDepth: number; effortTier: string }
    const stageStats = out.stageStats as Array<{
      stage: string
      count: number
      p50Tokens: number
      p90Tokens: number
      p50LatencyMs: number
      p90LatencyMs: number
      avgRisk: number
    }>

    console.log('=== fable51 Budget Advisor ===')
    console.log('')
    console.log(`Task class: ${String(out.taskClass)}`)
    console.log(`Confidence: ${String(out.confidence)}`)
    console.log(`Sample size: ${String(out.sampleSize)}`)
    console.log('')
    console.log('Recommended config:')
    console.log(`  stageTokenBudget: ${recommended.stageTokenBudget.toLocaleString('en-US')}`)
    console.log(`  maxForkDepth: ${recommended.maxForkDepth}`)
    console.log(`  effortTier: ${recommended.effortTier}`)
    console.log('')
    console.log('Rationale:')
    console.log(`  ${String(out.rationale)}`)
    if (stageStats.length > 0) {
      console.log('')
      console.log('Stage stats (count, p50/p90 tokens, p50/p90 latency, avg risk):')
      for (const s of stageStats) {
        console.log(`  ${s.stage}: ${s.count} samples | tokens p50=${s.p50Tokens} p90=${s.p90Tokens} | latency p50=${s.p50LatencyMs}ms p90=${s.p90LatencyMs}ms | risk=${s.avgRisk.toFixed(2)}`)
      }
    }
    return 0
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * Run every tool in two tenants of one host and report what the sweep found.
 *
 * The sweep is the command that proves the tenant boundary holds, so it runs
 * against a REAL host: the registry, the hooks and the dsh services are the
 * shipped ones. A failing sweep exits 1, because a green exit code must mean
 * the boundary held.
 */
async function runSweep(args: string[]): Promise<number> {
  const parsed = formatValue(args)
  if (!parsed.ok) {
    console.error(parsed.error)
    return 1
  }
  const format = parsed.format

  const ctx = await boot()
  try {
    const report = await runTenantSweep(ctx)

    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(renderSweepReport(report))
    }

    if (!report.pass) {
      console.error(`sweep failed: ${report.failures.length} check(s) failed`)
      return 1
    }
    return 0
  } finally {
    await ctx.fiber.dispose()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const command = argv[0]
  if (command === 'inspect') return runInspect(argv.slice(1))
  if (command === 'advise-budget') return runAdviseBudget(argv.slice(1))
  if (command === 'sweep') return runSweep(argv.slice(1))
  console.error(USAGE)
  return 1
}
