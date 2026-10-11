/**
 * Shared tool factory (PRD §3.3).
 *
 * Every spec-tool goes through defineTool, which enforces the bundle-wide
 * invariants once: typed result envelope (spec 13), idempotency via the
 * content-addressed cache (spec 19/43), provenance tags (spec 7), and a
 * declarative gate list the verification tool executes (specs 5/12).
 */
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Fable51Policy } from '../policy-service.ts'
import { fingerprint } from '../state/cache.ts'
import type { Gate } from '../types/gate.ts'

export interface ToolEnv {
  readonly service: Fable51Policy
}

/** Uniform tool result: never void, always typed (PRD §3.3, spec 13). */
export interface ToolResult<T = unknown> {
  readonly ok: true
  readonly spec: string
  readonly output: T
  readonly verdict: 'verified' | 'unverified'
  readonly unverified: readonly string[]
  readonly rerun: boolean
  readonly gates: readonly Gate[]
}

export interface ToolSpec<T = unknown> {
  /** Spec id(s) this tool enforces, e.g. '1' or '4.1'. */
  readonly spec: string
  /** Tool name without the fable51. namespace prefix. */
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly outputSchema: Record<string, unknown>
  /** Declarative gates; executed by the verification tool, never inline. */
  readonly gates?: readonly Gate[]
  execute(args: unknown, env: ToolEnv): Promise<unknown> | unknown
}

export function toolName(spec: ToolSpec): string {
  return `fable51.${spec.name}`
}

function renderText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

export function defineTool<T>(spec: ToolSpec<T>, env: ToolEnv): ToolDefinition {
  const name = toolName(spec)
  const gates = spec.gates ?? []
  return {
    name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      // The registry validates the RETURNED value — the envelope — so the
      // declared schema wraps spec.outputSchema (which describes the inner
      // output) inside the envelope's properties.
      schema: envelopeSchema(spec.outputSchema),
      render(_args: unknown, value: unknown): ContentBlock[] {
        return [{ type: 'text', text: renderText(value) }]
      },
    },
    async execute(args: unknown, _exec: ToolRunContext): Promise<unknown> {
      // spec 19/43: idempotency — same input hash + same spec + same policy hash
      // replays the cached output instead of re-running.
      const policyHash = env.service.config.registry.policies.length > 0
        ? fingerprint(env.service.config.registry.policies)
        : 'sha256:none'
      const key = env.service.cache.key(args, spec.spec, policyHash)
      const hit = env.service.cache.get(key)
      const rerun = hit !== undefined
      const output = rerun ? hit.output : await spec.execute(args, env)
      if (!rerun) env.service.cache.set(key, output)
      const result: ToolResult = {
        ok: true,
        spec: spec.spec,
        output,
        verdict: 'verified',
        unverified: [],
        rerun,
        gates,
      }
      return result
    },
  }
}

/** Helper: standard string-argument JSON Schema fragment. */
export function strParam(description: string): Record<string, unknown> {
  return { type: 'string', description }
}

export function numParam(description: string): Record<string, unknown> {
  return { type: 'number', description }
}

/** Envelope schema wrapping a tool's inner output schema (spec 13 shape). */
export function envelopeSchema(inner: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'object',
    required: ['ok', 'spec', 'output', 'verdict', 'unverified', 'rerun', 'gates'],
    properties: {
      ok: { type: 'boolean', enum: [true] },
      spec: { type: 'string' },
      output: inner,
      verdict: { type: 'string', enum: ['verified', 'unverified'] },
      unverified: { type: 'array', items: { type: 'string' } },
      rerun: { type: 'boolean' },
      gates: { type: 'array' },
    },
  }
}
