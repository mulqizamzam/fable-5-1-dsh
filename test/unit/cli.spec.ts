/**
 * Unit: CLI entry point — src/cli.ts.
 *
 * The CLI boots a real Cordis host with the real dsh services, so these
 * tests exercise the same path the shipped binary runs.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { main } from '../../src/cli.ts'

/** Capture stdout/stderr for one CLI invocation. */
async function capture(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = []
  const errChunks: string[] = []
  const originalOut = process.stdout.write.bind(process.stdout)
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    outChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    errChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
  try {
    const code = await main(argv)
    return { code, out: outChunks.join(''), err: errChunks.join('') }
  } finally {
    process.stdout.write = originalOut
    process.stderr.write = originalErr
  }
}

describe('fable51 CLI', () => {
  it('prints the ASCII rendering for inspect, not the JSON envelope', async () => {
    const { code, out } = await capture(['inspect'])
    assert.equal(code, 0, 'inspect must exit 0')
    // defect guard: the rendered text lives inside the tool's output, not on
    // the envelope — reading the wrong level silently fell back to JSON.
    assert.ok(out.startsWith('=== fable51 Policy Visualizer ==='), `expected the ASCII banner, got: ${out.slice(0, 120)}`)
    assert.ok(out.includes('--- Policies ---'))
    assert.ok(out.includes('--- Lineage ---'))
    assert.ok(out.includes('--- Costs ---'))
    assert.ok(out.includes('--- Cache ---'))
    assert.ok(out.includes('--- Snapshots ---'))
    assert.ok(out.includes('--- Config ---'))
    assert.ok(!out.trimStart().startsWith('{'), 'the ASCII path must not print the JSON envelope')
  })

  it('prints the JSON envelope for inspect --format json', async () => {
    const { code, out } = await capture(['inspect', '--format', 'json'])
    assert.equal(code, 0)
    const parsed = JSON.parse(out) as { ok: boolean; spec: string; output: Record<string, unknown> }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.spec, '100')
    assert.ok('policies' in parsed.output)
    assert.ok('lineage' in parsed.output)
    assert.ok('costs' in parsed.output)
    assert.ok('cache' in parsed.output)
    assert.ok('snapshots' in parsed.output)
    assert.ok('config' in parsed.output)
  })

  it('prints the recommendation for advise-budget', async () => {
    const { code, out } = await capture(['advise-budget', 'multihop'])
    assert.equal(code, 0)
    assert.ok(out.includes('=== fable51 Budget Advisor ==='))
    assert.ok(out.includes('Task class: multihop'))
    assert.ok(out.includes('stageTokenBudget:'))
    assert.ok(out.includes('maxForkDepth:'))
    assert.ok(out.includes('effortTier:'))
  })

  it('prints JSON for advise-budget --format json', async () => {
    const { code, out } = await capture(['advise-budget', 'search', '--format', 'json'])
    assert.equal(code, 0)
    const parsed = JSON.parse(out) as { ok: boolean; spec: string; output: { taskClass: string; recommended: Record<string, unknown> } }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.spec, '11')
    assert.equal(parsed.output.taskClass, 'search')
    assert.ok('stageTokenBudget' in parsed.output.recommended)
    assert.ok('maxForkDepth' in parsed.output.recommended)
    assert.ok('effortTier' in parsed.output.recommended)
  })

  it('rejects an unknown task class with usage and a non-zero exit', async () => {
    const { code, err } = await capture(['advise-budget', 'nonsense'])
    assert.equal(code, 1)
    assert.ok(err.includes('bounded|search|multihop|open'), `expected the usage line, got: ${err}`)
  })

  it('rejects an unknown command with usage and a non-zero exit', async () => {
    const { code, err } = await capture(['nonsense'])
    assert.equal(code, 1)
    assert.ok(err.includes('inspect'), `expected the usage line, got: ${err}`)
    assert.ok(err.includes('advise-budget'))
  })

  it('rejects a non-numeric history window', async () => {
    const { code, err } = await capture(['advise-budget', 'search', '--history-window', 'abc'])
    assert.equal(code, 1)
    assert.ok(err.includes('--history-window'), `expected the flag error, got: ${err}`)
  })

  it('rejects a non-numeric min-samples', async () => {
    const { code, err } = await capture(['advise-budget', 'search', '--min-samples', 'x'])
    assert.equal(code, 1)
    assert.ok(err.includes('--min-samples'), `expected the flag error, got: ${err}`)
  })
})
