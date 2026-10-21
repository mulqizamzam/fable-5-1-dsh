/**
 * Session identity resolution.
 *
 * The host stamps session identity on every surface the bundle touches, but
 * in four different shapes. Resolving them in one place is what makes the
 * per-session episode store correct: a tool that charges a budget and the
 * hook that resets it must land on the same key, or the run splits into two
 * half-budgets.
 *
 * Every resolver falls back to DEFAULT_SESSION when the host named no
 * session. That fallback is a real bucket, never a wildcard.
 */
import { DEFAULT_SESSION } from './episode.ts'

/** A session id, however the surface spells it. */
function readId(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  if (typeof id === 'string') return id.length > 0 ? id : undefined
  if (typeof id === 'object' && id !== null) {
    // Branded session ids are objects in some host versions.
    const inner = (id as { value?: unknown }).value
    if (typeof inner === 'string' && inner.length > 0) return inner
  }
  return undefined
}

/** Key for a session object: `session.id` (dsh-session). */
export function sessionKeyOf(session: unknown): string {
  return readId(session) ?? DEFAULT_SESSION
}

/** Key for an agent: `agent.session.id` (dsh-agent runtime-types). */
export function sessionKeyFromAgent(agent: unknown): string {
  if (typeof agent !== 'object' || agent === null) return DEFAULT_SESSION
  const session = (agent as { session?: unknown }).session
  return sessionKeyOf(session)
}

/** Key for a tool execution: `exec.agent.session.id` (dsh-tools ToolExecution). */
export function sessionKeyFromExec(exec: unknown): string {
  if (typeof exec !== 'object' || exec === null) return DEFAULT_SESSION
  const agent = (exec as { agent?: unknown }).agent
  return sessionKeyFromAgent(agent)
}

/** Key for a generation request: `options.sessionId` (dsh-llm GenerateOptions). */
export function sessionKeyFromOptions(options: unknown): string {
  if (typeof options !== 'object' || options === null) return DEFAULT_SESSION
  return readId((options as { sessionId?: unknown }).sessionId) ?? DEFAULT_SESSION
}

/**
 * The working directory a session was created in, however the surface
 * spells it.
 *
 * This is the tenant boundary: a host already draws it when it creates a
 * session, and two sessions in different directories are two users of the
 * host even when they share it.
 */
export function cwdOfSession(session: unknown): string | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  // The live session carries the directory on its HEADER, which is where the
  // host reads it from too (packages/core/tools/src/ptc.ts reads
  // exec.agent.session.header.cwd). A flat `cwd` is accepted as well, for a
  // surface that spells it that way.
  const header = (session as { header?: unknown }).header
  const fromHeader = typeof header === 'object' && header !== null
    ? (header as { cwd?: unknown }).cwd
    : undefined
  const flat = (session as { cwd?: unknown }).cwd
  const cwd = fromHeader ?? flat
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** The working directory behind a tool execution: `exec.agent.session.cwd`. */
export function cwdOfExec(exec: unknown): string | undefined {
  if (typeof exec !== 'object' || exec === null) return undefined
  const agent = (exec as { agent?: unknown }).agent
  if (typeof agent !== 'object' || agent === null) return undefined
  const session = (agent as { session?: unknown }).session
  return cwdOfSession(session)
}
