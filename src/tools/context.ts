/**
 * Context & session tools — specs 1, 2, 9, 22, 33 (Gate 4a).
 *
 * Reference implementation for all tool groups: typed envelope via
 * defineTool, idempotent by construction, no silent side effects. Arguments
 * are validated inside execute (fail-loud) — the registry does not validate
 * `parameters` at execution time.
 */
import type { ToolSpec } from './shared.ts'
import { createHash } from 'node:crypto'
import type { ArtifactContract } from '../types/gate.ts'

function checksum(data: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new Error('arguments must be an object')
  return args as Record<string, unknown>
}

function requireNumber(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${key} must be a finite number within [${min}, ${max}]`)
  }
  return value
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function requireObjectArg(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${key} must be an object`)
  return value as Record<string, unknown>
}

export function contextTools(): ToolSpec[] {
  return [
    {
      spec: '1',
      name: 'context-management',
      description: 'Classify context fill against compact/drop/spill thresholds and emit the required action (spec 1).',
      parameters: {
        type: 'object',
        required: ['fillRatio'],
        properties: { fillRatio: { type: 'number' } },
      },
      outputSchema: {
        type: 'object',
        required: ['action', 'thresholds', 'spillPath'],
        properties: {
          action: { type: 'string', enum: ['ok', 'compact', 'drop', 'spill'] },
          thresholds: { type: 'object' },
          spillPath: { type: 'string' },
        },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const fillRatio = requireNumber(record, 'fillRatio', 0, 1)
        const action = service.contextAction(fillRatio)
        return {
          action,
          thresholds: service.config.context,
          spillPath: action === 'spill' ? service.config.context.spillPath : '',
        }
      },
    },
    {
      spec: '2',
      name: 'subagent-contracts',
      description: 'Validate a subagent spawn contract: input/output schema present and spawn depth ≤ 1 (spec 2).',
      parameters: {
        type: 'object',
        required: ['inputSchema', 'outputSchema', 'depth'],
        properties: {
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          depth: { type: 'number' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['valid', 'violations'],
        properties: { valid: { type: 'boolean' }, violations: { type: 'array', items: { type: 'string' } } },
      },
      execute(args) {
        const record = asRecord(args)
        const inputSchema = requireObjectArg(record, 'inputSchema')
        const outputSchema = requireObjectArg(record, 'outputSchema')
        const depth = requireNumber(record, 'depth', 0, 100)
        const violations: string[] = []
        if (Object.keys(inputSchema).length === 0) violations.push('inputSchema missing')
        if (Object.keys(outputSchema).length === 0) violations.push('outputSchema missing')
        if (depth > 1) violations.push(`spawn depth ${depth} > 1 — recursive fanout blocked`)
        return { valid: violations.length === 0, violations }
      },
    },
    {
      spec: '9',
      name: 'artifact-contracts',
      description: 'Emit the artifact contract for a stage output: path, shape, schema, checksum (spec 9).',
      parameters: {
        type: 'object',
        required: ['path', 'shape', 'schema', 'data'],
        properties: {
          path: { type: 'string' },
          shape: { type: 'string' },
          schema: { type: 'string' },
          data: {},
        },
      },
      outputSchema: {
        type: 'object',
        required: ['path', 'shape', 'schema', 'checksum'],
        properties: { path: { type: 'string' }, shape: { type: 'string' }, schema: { type: 'string' }, checksum: { type: 'string' } },
      },
      execute(args): ArtifactContract {
        const record = asRecord(args)
        const path = requireString(record, 'path')
        const shape = requireString(record, 'shape')
        const schema = requireString(record, 'schema')
        if (!('data' in record)) throw new Error('data is required')
        return { path, shape, schema, checksum: checksum(record.data) }
      },
    },
    {
      spec: '22',
      name: 'token-budget-per-stage',
      description: 'Account tokens against the per-stage budget; alert at 80%, hard-stop signal at 100% (spec 22).',
      parameters: {
        type: 'object',
        required: ['stage', 'tokens'],
        properties: { stage: { type: 'string' }, tokens: { type: 'number' } },
      },
      outputSchema: {
        type: 'object',
        required: ['used', 'alert', 'stop', 'limit'],
        properties: { used: { type: 'number' }, alert: { type: 'boolean' }, stop: { type: 'boolean' }, limit: { type: 'number' } },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const stage = requireString(record, 'stage')
        const tokens = requireNumber(record, 'tokens', 0, Number.MAX_SAFE_INTEGER)
        const budget = service.addStageTokens(stage, tokens)
        return { used: budget.used, alert: budget.alert, stop: budget.stop, limit: service.config.budget.stageTokenBudget }
      },
    },
    {
      spec: '33',
      name: 'interleaved-budget',
      description: 'Cap interleaved-thinking tokens per tool call against the stage budget headroom (spec 33).',
      parameters: {
        type: 'object',
        required: ['requested'],
        properties: { requested: { type: 'number' } },
      },
      outputSchema: {
        type: 'object',
        required: ['granted', 'headroom'],
        properties: { granted: { type: 'number' }, headroom: { type: 'number' } },
      },
      execute(args, { service }) {
        const record = asRecord(args)
        const requested = requireNumber(record, 'requested', 0, Number.MAX_SAFE_INTEGER)
        const limit = service.config.budget.stageTokenBudget
        const used = [...service.stageTokens.values()].reduce((a, b) => a + b, 0)
        const headroom = Math.max(0, limit - used)
        return { granted: Math.min(requested, headroom), headroom }
      },
    },
  ]
}
