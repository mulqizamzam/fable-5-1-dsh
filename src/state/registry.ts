/**
 * Immutable versioned policy registry (spec 100).
 *
 * A policy is never mutated: a change is a new version. Duplicate
 * id+version is a loud error. Exactly one active version per id.
 */
export interface PolicyRecord {
  readonly id: string
  readonly version: string
  readonly owner: string
  readonly active: boolean
  readonly hash: string
}

export class PolicyRegistry {
  private readonly records = new Map<string, PolicyRecord[]>()
  private readonly active = new Map<string, string>()

  register(policy: PolicyRecord): PolicyRecord {
    if (!policy.id || !policy.version || !policy.owner || !policy.hash) {
      throw new Error('policy requires id, version, owner, and hash')
    }
    const versions = this.records.get(policy.id) ?? []
    if (versions.some((v) => v.version === policy.version)) {
      throw new Error(`policy ${policy.id}@${policy.version} already exists — mutation is forbidden, register a new version`)
    }
    const next = [...versions, policy].sort(compareVersion)
    this.records.set(policy.id, next)
    if (policy.active) {
      for (const prior of next) {
        if (prior !== policy && this.active.get(policy.id) === prior.version) this.active.set(policy.id, policy.version)
      }
      this.active.set(policy.id, policy.version)
    }
    return policy
  }

  getActive(id: string): PolicyRecord | undefined {
    const version = this.active.get(id)
    if (!version) return undefined
    return this.versions(id).find((v) => v.version === version)
  }

  versions(id: string): readonly PolicyRecord[] {
    return this.records.get(id) ?? []
  }

  all(): readonly PolicyRecord[] {
    return [...this.records.values()].flat()
  }
}

/**
 * Version ordering: numeric-aware segment comparison so 1.10.0 sorts after
 * 1.9.0 (plain string compare puts 1.10.0 first). Non-numeric segments fall
 * back to string order, which keeps date-style versions deterministic.
 */
function compareVersion(a: PolicyRecord, b: PolicyRecord): number {
  if (a.version === b.version) return 0
  const left = a.version.split('.')
  const right = b.version.split('.')
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const x = left[i] ?? ''
    const y = right[i] ?? ''
    if (x === y) continue
    const nx = Number(x)
    const ny = Number(y)
    if (Number.isFinite(nx) && Number.isFinite(ny) && x !== '' && y !== '') return nx - ny
    return x < y ? -1 : 1
  }
  return 0
}
