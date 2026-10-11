/**
 * Reasoning snapshots with structural diff (specs 38, 46, 77, 83).
 *
 * A snapshot is an immutable content-addressed checkpoint; diff reports
 * added/removed/changed keys between two snapshots — the drift and
 * regression detector.
 */
import { fingerprint } from './cache.ts'

export interface Snapshot {
  readonly id: string
  readonly at: number
  readonly hash: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface SnapshotDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

export class SnapshotStore {
  private readonly snapshots = new Map<string, Snapshot>()
  private order: string[] = []

  create(id: string, data: Record<string, unknown>, at = Date.now()): Snapshot {
    const snapshot: Snapshot = { id, at, hash: fingerprint(data), data: Object.freeze({ ...data }) }
    this.snapshots.set(id, snapshot)
    this.order = this.order.filter((x) => x !== id)
    this.order.push(id)
    return snapshot
  }

  get(id: string): Snapshot | undefined {
    return this.snapshots.get(id)
  }

  latest(): Snapshot | undefined {
    const id = this.order[this.order.length - 1]
    return id === undefined ? undefined : this.snapshots.get(id)
  }

  ids(): readonly string[] {
    return [...this.order]
  }

  diff(fromId: string, toId: string): SnapshotDiff {
    const from = this.snapshots.get(fromId)
    const to = this.snapshots.get(toId)
    if (!from) throw new Error(`snapshot ${fromId} not found`)
    if (!to) throw new Error(`snapshot ${toId} not found`)
    const added: string[] = []
    const removed: string[] = []
    const changed: string[] = []
    for (const key of Object.keys(to.data)) {
      if (!(key in from.data)) added.push(key)
      else if (fingerprint(from.data[key]) !== fingerprint(to.data[key])) changed.push(key)
    }
    for (const key of Object.keys(from.data)) {
      if (!(key in to.data)) removed.push(key)
    }
    return { added: added.sort(), removed: removed.sort(), changed: changed.sort() }
  }
}
