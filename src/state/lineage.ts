/**
 * Pass lineage tree with pruning and garbage collection
 * (specs 69, 87, 94).
 *
 * Parent→child edges are recorded at pass creation; lineage pruning drops
 * unreferenced ancestry while keeping an audit slice; GC collects passes no
 * longer referenced, keeping the most recent N.
 */
import type { PassVerdict, ReasoningPass } from '../types/pass.ts'

export class PassLineage {
  private readonly passes = new Map<string, ReasoningPass>()
  private readonly childrenOf = new Map<string, Set<string>>()
  private readonly auditKeep = new Set<string>()

  record(pass: ReasoningPass): ReasoningPass {
    if (this.passes.has(pass.id)) {
      throw new Error(`pass ${pass.id} already recorded — lineage is append-only`)
    }
    if (pass.parentId !== null && !this.passes.has(pass.parentId)) {
      throw new Error(`pass ${pass.id} references unknown parent ${pass.parentId}`)
    }
    this.passes.set(pass.id, pass)
    if (pass.parentId !== null) {
      const siblings = this.childrenOf.get(pass.parentId) ?? new Set<string>()
      siblings.add(pass.id)
      this.childrenOf.set(pass.parentId, siblings)
    }
    return pass
  }

  get(id: string): ReasoningPass | undefined {
    return this.passes.get(id)
  }

  children(id: string): readonly string[] {
    return [...(this.childrenOf.get(id) ?? [])].sort()
  }

  /** All ancestor ids of a pass, nearest first. */
  ancestors(id: string): readonly string[] {
    const out: string[] = []
    let cursor = this.passes.get(id)?.parentId ?? null
    const seen = new Set<string>()
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor)
      out.push(cursor)
      cursor = this.passes.get(cursor)?.parentId ?? null
    }
    return out
  }

  /** Mark a pass id as audit-protected (survives prune/GC). */
  protect(id: string): void {
    this.auditKeep.add(id)
  }

  /** Drop passes not referenced by any live id or audit protection. Returns dropped ids. */
  gc(liveIds: Iterable<string>, keepLastN: number): readonly string[] {
    const live = new Set(liveIds)
    for (const id of live) {
      let cursor: string | null = id
      const seen = new Set<string>()
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor)
        live.add(cursor)
        cursor = this.passes.get(cursor)?.parentId ?? null
      }
    }
    // Map iteration order is creation order, so the tail of it IS the most
    // recent slice; sorting by id kept the lexicographically largest ids
    // (pass-9 over pass-10) and collected the newest pass instead.
    const ordered = [...this.passes.keys()]
    for (const id of ordered.slice(Math.max(0, ordered.length - Math.max(0, keepLastN)))) live.add(id)
    for (const id of this.auditKeep) live.add(id)
    const dropped: string[] = []
    for (const id of ordered) {
      if (!live.has(id)) {
        this.passes.delete(id)
        for (const [parent, kids] of this.childrenOf) {
          kids.delete(id)
          if (kids.size === 0) this.childrenOf.delete(parent)
        }
        dropped.push(id)
      }
    }
    return dropped
  }

  size(): number {
    return this.passes.size
  }

  /**
   * Spec 87 (pass-lineage-prune): drop passes that no live pass needs, keeping
   * audit-protected ids and the ancestor chain of every live pass — without the
   * chain a live pass keeps reporting parents that were just dropped.
   */
  prune(liveIds: Iterable<string>): readonly string[] {
    const keep = new Set(this.auditKeep)
    for (const id of liveIds) keep.add(id)
    for (const id of [...keep]) {
      let cursor: string | null = id
      const seen = new Set<string>()
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor)
        keep.add(cursor)
        cursor = this.passes.get(cursor)?.parentId ?? null
      }
    }
    const dropped: string[] = []
    for (const id of [...this.passes.keys()]) {
      if (keep.has(id)) continue
      this.passes.delete(id)
      for (const [parent, kids] of this.childrenOf) {
        kids.delete(id)
        if (kids.size === 0) this.childrenOf.delete(parent)
      }
      dropped.push(id)
    }
    return dropped
  }

  verdicts(): Record<PassVerdict, number> {
    const out: Record<PassVerdict, number> = { contributed: 0, neutral: 0, discarded: 0 }
    // An out-of-contract verdict would add a phantom key and count NaN.
    for (const pass of this.passes.values()) {
      if (Object.hasOwn(out, pass.verdict)) out[pass.verdict] += 1
    }
    return out
  }

  /** All passes in creation order. */
  all(): readonly ReasoningPass[] {
    return [...this.passes.values()]
  }
}
