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
      throw new Error(`policy ${policy.id}@${policy.version} already exists, mutation is forbidden, register a new version`)
    }
    // Store a frozen copy: the service hands over a live reference into
    // config.registry.policies, and a registered policy is immutable (spec 100).
    const record: PolicyRecord = Object.freeze({ ...policy })
    const candidates = [...versions, record]
    // Exactly one active record per id, and it is the highest active version,
    // not simply the one registered last.
    const winner = candidates.filter((v) => v.active).sort(compareVersion).at(-1)
    this.records.set(policy.id, candidates
      .map((v) => (winner !== undefined && v.version !== winner.version
        ? Object.freeze({ ...v, active: false })
        : v))
      .sort(compareVersion))
    if (winner !== undefined) this.active.set(policy.id, winner.version)
    return record
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
