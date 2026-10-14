/**
 * Canonical fingerprint + content-addressed pass cache (specs 43, 65).
 *
 * Cache key = sha256(inputHash + specId + policyHash). Canonicalization sorts
 * object keys recursively so equal content always fingerprints equally.
 */
import { createHash } from 'node:crypto'

export function canonicalize(value: unknown): string {
  // `JSON.stringify(undefined)` is undefined, so the `?? 'null'` fallback made a
  // missing artifact fingerprint identically to a null one, and a verification
  // tool then certified "absent" as "matches null".
  if (value === undefined) return 'undefined'
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

  /** Mirrors CACHE_CAP in policy-service.ts, which passes it explicitly. */
  constructor(private readonly max = 2000) {}

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
    // Re-insert moves the key to the newest slot, so a hot key is not evicted by a stale position.
    this.store.delete(key)
    this.store.set(key, entry)
    // FIFO eviction: entries hold full outputs, so a long-lived host must not retain all of them.
    while (this.store.size > this.max) {
      const oldest = this.store.keys().next()
      if (oldest.done === true) break
      this.store.delete(oldest.value)
    }
    return entry
  }

  get size(): number {
    return this.store.size
  }
}
