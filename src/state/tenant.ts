/**
 * Tenant scope, the boundary between two users of one host.
 *
 * A host runs many sessions. Before this, every one of them shared the same
 * worklog, the same cost ledger, the same pass lineage, the same snapshots
 * and the same cache, so one tenant could read another's spend and another's
 * history, and the budget advisor computed a recommendation from bookings
 * the caller never made.
 *
 * A tenant is a key, and every piece of shared state lives under one. The
 * key comes from the session's working directory by default, because that is
 * the boundary a host already draws: a session created in one project
 * belongs to that project. A session that names no directory lands in the
 * default tenant, which is a real bucket and never a wildcard.
 *
 * The scope key composes the tenant with the session, so an episode is
 * per-session AND per-tenant without the episode store knowing anything
 * about tenants. Two tenants may name the same session id; they will not
 * share an episode, a budget or a ledger.
 */
import { DEFAULT_SESSION } from './episode.ts'
import { PassLineage } from './lineage.ts'
import { ReasonCache } from './cache.ts'
import { SnapshotStore } from './snapshots.ts'
import type { GateResult } from '../types/gate.ts'
import type { CostLedgerEntry, WorklogEntry } from '../types/log.ts'

/** The tenant a session with no directory belongs to. */
export const DEFAULT_TENANT = 'default'

/** Separates the tenant from the session inside a scope key. */
export const SCOPE_SEPARATOR = '::'

/** The scope of a call that named no session and no directory. */
export const DEFAULT_SCOPE = `${DEFAULT_TENANT}${SCOPE_SEPARATOR}${DEFAULT_SESSION}`

/** How a session is mapped onto a tenant. */
export type TenantMode =
  /** By the session's working directory. The default. */
  | 'cwd'
  /** By the session id: every session is its own tenant. */
  | 'session'
  /** One tenant for the whole host, which is the behaviour before isolation. */
  | 'none'

/** Compose the key a session's state lives under. */
export function scopeKeyOf(tenant: string, session: string): string {
  return `${tenant}${SCOPE_SEPARATOR}${session}`
}

/** The tenant half of a scope key. */
export function tenantOfScope(scopeKey: string): string {
  const at = scopeKey.indexOf(SCOPE_SEPARATOR)
  if (at <= 0) return DEFAULT_TENANT
  return scopeKey.slice(0, at)
}

/** The session half of a scope key. */
export function sessionOfScope(scopeKey: string): string {
  const at = scopeKey.indexOf(SCOPE_SEPARATOR)
  if (at < 0) return scopeKey
  return scopeKey.slice(at + SCOPE_SEPARATOR.length)
}

/**
 * The tenant a working directory belongs to.
 *
 * The path is normalized so that `/work` and `/work/` are one tenant, and a
 * missing or empty directory falls back to the default tenant.
 */
export function tenantKeyFromCwd(cwd: string | undefined, fallback: string = DEFAULT_TENANT): string {
  if (cwd === undefined) return fallback
  const trimmed = cwd.endsWith('/') && cwd.length > 1 ? cwd.slice(0, -1) : cwd
  return trimmed.length === 0 ? fallback : trimmed
}

/** One tenant's shared state. */
export class TenantState {
  readonly worklog: WorklogEntry[] = []
  readonly gateLog: GateResult[] = []
  readonly costLedger: CostLedgerEntry[] = []
  readonly stageCosts = new Map<string, { tokens: number; latencyMs: number; risk: number }>()
  readonly snapshots: SnapshotStore
  readonly lineage = new PassLineage()
  readonly cache: ReasonCache

  constructor(snapshotCap: number, cacheCap: number) {
    this.snapshots = new SnapshotStore(snapshotCap)
    this.cache = new ReasonCache(cacheCap)
  }
}

/**
 * The tenants of one host, and which tenant each session belongs to.
 *
 * Bounded: a long-lived host must not grow one scope per directory for the
 * process lifetime. Eviction is oldest-first over insertion order, and it
 * drops that tenant's history, which is the same bargain the episode store
 * makes. A session that comes back after its tenant was evicted starts over
 * rather than resurrecting a half-remembered run.
 */
export class TenantRegistry {
  private readonly tenants = new Map<string, TenantState>()
  private readonly sessionTenant = new Map<string, string>()

  constructor(
    private readonly snapshotCap: number,
    private readonly cacheCap: number,
    private readonly max = 64,
  ) {}

  /** One tenant's state, created on first use. */
  scope(tenant: string): TenantState {
    const existing = this.tenants.get(tenant)
    if (existing !== undefined) return existing
    const created = new TenantState(this.snapshotCap, this.cacheCap)
    this.tenants.set(tenant, created)
    while (this.tenants.size > this.max) {
      const oldest = this.tenants.keys().next()
      if (oldest.done === true) break
      this.tenants.delete(oldest.value)
    }
    return created
  }

  /** Remember which tenant a session belongs to. */
  remember(sessionId: string, tenant: string): void {
    this.sessionTenant.set(sessionId, tenant)
    // The map is bounded too, and a session that is forgotten simply falls
    // back to the default tenant.
    while (this.sessionTenant.size > this.max * 4) {
      const oldest = this.sessionTenant.keys().next()
      if (oldest.done === true) break
      this.sessionTenant.delete(oldest.value)
    }
  }

  /** The tenant a session belongs to, if it has been seen. */
  tenantFor(sessionId: string): string | undefined {
    return this.sessionTenant.get(sessionId)
  }

  /** Forget a session's tenant (session disposed). */
  forget(sessionId: string): void {
    this.sessionTenant.delete(sessionId)
  }

  /** Every known tenant key. */
  keys(): string[] {
    return [...this.tenants.keys()]
  }

  get size(): number {
    return this.tenants.size
  }
}
