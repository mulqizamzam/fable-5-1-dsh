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
import { sessionKeyFromExec } from '../state/session-key.ts'
import type { Gate } from '../types/gate.ts'

export interface ToolEnv {
  readonly service: Fable51Policy
  /**
   * The session this call belongs to.
   *
   * Resolved per call from the execution the host handed us, so a tool that
   * spends a budget and the hook that resets it land on the same run's
   * episode. DEFAULT_SESSION when the host named no session.
   */
  readonly sessionKey: string
}

/** Uniform tool result: never void, always typed (PRD §3.3, spec 13). */
export interface ToolResult<T = unknown> {
  readonly ok: boolean
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
  /** Tool name without the fable51_ namespace prefix. */
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly outputSchema: Record<string, unknown>
  /**
   * An effectful tool mutates service state: a cached answer would skip the
   * mutation, so it never reads or writes the cache (spec 19 covers pure tools).
   */
  readonly effectful?: boolean
  /** Declarative gates; executed by the verification tool, never inline. */
  readonly gates?: readonly Gate[]
  execute(args: unknown, env: ToolEnv): Promise<unknown> | unknown
}

export function toolName(spec: ToolSpec): string {
  // Dotted names break OpenAI-compatible provider tool validation
  // (^[a-zA-Z0-9_-]+$); keep the namespace with an underscore instead.
  return `fable51_${spec.name}`
}

function renderText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Envelope verdict rule: only a tool's own verification status can downgrade the
 * envelope — a normal outcome (abort, escape, expiry, approval) is an answer,
 * not an unproven claim, so it must not certify or de-certify the tool.
 */
function judge(spec: ToolSpec, output: unknown): { verdict: 'verified' | 'unverified'; unverified: string[] } {
  const out = (typeof output === 'object' && output !== null ? output : {}) as Record<string, unknown>
  const listed = [...stringList(out.missing), ...stringList(out.unverified)]
  if (listed.length === 0 && out.verdict !== 'unverified' && out.pass !== false) {
    return { verdict: 'verified', unverified: [] }
  }
  return {
    verdict: 'unverified',
    unverified: listed.length > 0 ? listed : [`${spec.name} (spec ${spec.spec}) returned an unverified result`],
  }
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
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      let output: unknown
      let rerun = false
      // The session key is per call: the env is shared by every tool, but the
      // session belongs to the execution, not to the registration.
      const callEnv: ToolEnv = { service: env.service, sessionKey: sessionKeyFromExec(exec) }
      try {
        if (spec.effectful === true) {
          output = await spec.execute(args, callEnv)
        } else {
          // spec 19/43: idempotency — same input hash + same spec + same config
          // fingerprint replays the cached output instead of re-running.
          const key = env.service.cache.key(args, spec.spec, fingerprint(env.service.config))
          const hit = env.service.cache.get(key)
          if (hit !== undefined) {
            rerun = true
            output = hit.output
          } else {
            output = await spec.execute(args, callEnv)
            env.service.cache.set(key, output)
          }
        }
      } catch (error) {
        // A malformed argument is a tool-level answer: the host must never see a throw.
        const message = error instanceof Error ? error.message : String(error)
        return {
          ok: false,
          spec: spec.spec,
          output: { error: message },
          verdict: 'unverified',
          unverified: [message],
          rerun: false,
          gates,
        }
      }
      const judged = judge(spec, output)
      const result: ToolResult = {
        ok: true,
        spec: spec.spec,
        output,
        verdict: judged.verdict,
        unverified: judged.unverified,
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
  // The host validates the returned envelope and rejects an unmatched shape, so a
  // failed tool's {error} answer needs its own branch beside the inner schema.
  const output = Object.keys(inner).length > 0
    ? { oneOf: [inner, { type: 'object', required: ['error'], properties: { error: { type: 'string' } } }] }
    : inner
  return {
    type: 'object',
    required: ['ok', 'spec', 'output', 'verdict', 'unverified', 'rerun', 'gates'],
    properties: {
      ok: { type: 'boolean' },
      spec: { type: 'string' },
      output,
      verdict: { type: 'string', enum: ['verified', 'unverified'] },
      unverified: { type: 'array', items: { type: 'string' } },
      rerun: { type: 'boolean' },
      gates: { type: 'array' },
    },
  }
}
