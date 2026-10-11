/**
 * Canonical fingerprint + content-addressed pass cache (specs 43, 65).
 *
 * Cache key = sha256(inputHash + specId + policyHash). Canonicalization sorts
 * object keys recursively so equal content always fingerprints equally.
 */
import { createHash } from 'node:crypto'

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`
}

export function fingerprint(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`
}

export interface CacheEntry {
  readonly key: string
  readonly output: unknown
  readonly at: number
}

export class ReasonCache {
  private readonly store = new Map<string, CacheEntry>()
  hits = 0
  misses = 0

  key(input: unknown, specId: string, policyHash: string): string {
    return fingerprint({ input, specId, policyHash })
  }

  get(key: string): CacheEntry | undefined {
    const hit = this.store.get(key)
    if (hit) this.hits += 1
    else this.misses += 1
    return hit
  }

  set(key: string, output: unknown, at = Date.now()): CacheEntry {
    const entry: CacheEntry = { key, output, at }
    this.store.set(key, entry)
    return entry
  }

  get size(): number {
    return this.store.size
  }
}
