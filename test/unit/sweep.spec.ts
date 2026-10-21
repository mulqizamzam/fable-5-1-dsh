/**
 * Sweep every registered tool once, in a real host.
 *
 * The registry, the hooks and the dsh services are the real ones, so a tool
 * that misbehaves here misbehaves in production. Each tool gets one call
 * with arguments derived from its own declared schema, and the tool must
 * accept them: a tool that refuses the arguments its own schema promises is
 * broken.
 *
 * This is the sweep that found the two live-state readers serving stale
 * cached answers, and it is here to catch the next one.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Fable51Policy from '../../src/index.ts'
import { allToolSpecs } from '../../src/tools/index.ts'
import { argsFor } from '../helpers/tool-args.ts'

interface SweepResult {
  name: string
  hostError: boolean
  rejected: boolean
  verdict: string
  detail: string
}

async function sweep(ctx: Context): Promise<SweepResult[]> {
  const results: SweepResult[] = []
  for (const spec of allToolSpecs()) {
    const toolName = `fable51_${spec.name}`
    const args = argsFor(spec.name)
    let hostError = false
    let rejected = false
    let verdict = 'unknown'
    let detail = ''
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`sweep-${spec.name}`),
        name: toolName,
        arguments: args,
      })
      if (result.isError) {
        hostError = true
        detail = JSON.stringify(result.content).slice(0, 200)
      } else {
        const envelope = result.value as unknown as {
          ok?: boolean
          verdict?: string
          output?: unknown
          unverified?: string[]
        }
        verdict = String(envelope.verdict)
        if (envelope.ok === false) {
          rejected = true
          detail = String((envelope.output as { error?: string } | undefined)?.error ?? '').slice(0, 200)
        } else if (verdict === 'unverified') {
          detail = (envelope.unverified ?? []).join('; ').slice(0, 200)
        }
      }
    } catch (error) {
      hostError = true
      detail = String(error).slice(0, 200)
    }
    results.push({ name: spec.name, hostError, rejected, verdict, detail })
  }
  return results
}

describe('tool sweep in a real host', () => {
  it('every tool accepts the arguments its own schema promises', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(Fable51Policy)

      const results = await sweep(ctx)
      assert.equal(results.length, allToolSpecs().length, 'every registered tool must be swept')

      const hostErrors = results.filter((r) => r.hostError)
      const rejections = results.filter((r) => r.rejected)
      assert.deepEqual(
        hostErrors.map((r) => `${r.name}: ${r.detail}`),
        [],
        'no tool may fail at the host level',
      )
      assert.deepEqual(
        rejections.map((r) => `${r.name}: ${r.detail}`),
        [],
        'no tool may refuse arguments its own schema declares',
      )
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('every tool answers with a verdict the envelope allows', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SessionStore)
      await ctx.plugin(Fable51Policy)

      for (const result of await sweep(ctx)) {
        assert.ok(
          result.verdict === 'verified' || result.verdict === 'unverified',
          `${result.name} returned verdict ${result.verdict}, which is not one the envelope allows`,
        )
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
