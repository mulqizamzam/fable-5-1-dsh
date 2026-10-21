/**
 * Unit: package manifest, packaging contract.
 *
 * A runtime import that only lives in devDependencies resolves in this
 * workspace and breaks on a clean install, so the peer list is the contract
 * the published package promises.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../../', import.meta.url).pathname

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  devDependencies?: Record<string, string>
}

/** Every .ts file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') ? [path] : []
  })
}

/** Package names imported by the sources, node builtins excluded. */
function runtimeImports(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/from '([^.'][^']*)'/g)) {
      const specifier = match[1]
      if (specifier === undefined || specifier.startsWith('node:')) continue
      const parts = specifier.split('/')
      names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier)
    }
  }
  return names
}

describe('package manifest', () => {
  it('declares every runtime import in dependencies or peerDependencies', () => {
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    const undeclared = [...runtimeImports()].filter((name) => !declared.has(name))
    assert.deepEqual(
      undeclared,
      [],
      `runtime imports missing from dependencies and peerDependencies: ${undeclared.join(', ')}`,
    )
  })

  it('keeps the optional peers optional, so the plugin path does not demand the CLI ones', () => {
    const meta = manifest.peerDependenciesMeta ?? {}
    const cliOnly = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-system-prompt']
    for (const name of cliOnly) {
      assert.equal(meta[name]?.optional, true, `${name} must stay an optional peer`)
    }
  })

  it('pins no peer dependency to a wildcard or a caret range on 0.x', () => {
    const loose = Object.entries(manifest.peerDependencies ?? {}).filter(
      ([, range]) => range === '*' || range.startsWith('^0.'),
    )
    assert.deepEqual(
      loose,
      [],
      `peer ranges that remove the review gate: ${loose.map(([name, range]) => `${name}@${range}`).join(', ')}`,
    )
  })
})
