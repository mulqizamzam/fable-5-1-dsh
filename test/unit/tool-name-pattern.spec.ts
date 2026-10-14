/**
 * Provider tool-name validation: OpenAI-compatible providers reject any
 * tool name outside ^[a-zA-Z0-9_-]+$ (dots included). Every registered
 * fable-5-1 tool name must match, or the whole model request 400s.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { allToolSpecs } from '../../src/tools/index.ts'
import { toolName } from '../../src/tools/shared.ts'

const PROVIDER_TOOL_NAME = /^[a-zA-Z0-9_-]+$/

describe('provider tool-name validation', () => {
  it('every registered tool name matches ^[a-zA-Z0-9_-]+$', () => {
    const names = allToolSpecs().map((spec) => toolName(spec))
    assert.ok(names.length > 0, 'expected registered tool specs')
    for (const name of names) {
      assert.match(name, PROVIDER_TOOL_NAME, `tool name "${name}" would 400 the provider request`)
    }
  })

  it('registers no tool with a dotted name', () => {
    for (const spec of allToolSpecs()) {
      assert.doesNotMatch(toolName(spec), /\./, `tool "${toolName(spec)}" still contains a dot`)
    }
  })
})
