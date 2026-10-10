[ARCHIVE: ONLINE — SECTOR 7G | TIMESTAMP: unknown | USER: full orchestrator-grade spec for dsh port]

# FABLE-5-1 / DSH PORT — ORCHESTRATOR SPECIFICATION

Version 0.1.0-draft. Target: `dsh` developer-preview, Cordis runtime, everything-is-a-plugin.
Purpose: a single orchestrator agent consumes this document and produces a working dsh bundle implementing all 100 fable-5-1 specs.

---

## §0. Preconditions the orchestrator must verify before any code

1. `dsh` version pinned to a specific commit hash. Record it. Developer preview breaks compatibility without warning. Do not use `latest`.
2. `pnpm` version recorded. dsh uses `pnpm-workspace.yaml`; npm will corrupt the lockfile.
3. Node major version ≥ declared in dsh `package.json`. Check `engines`.
4. Read, in order, before writing a line: `AGENTS.md`, `docs/architecture/*`, `docs/development/*`, `packages/cordis/README`, `packages/dsh-tools/README`. The orchestrator does not invent integration points; it reads them.
5. Confirm the three dsh surfaces the port depends on still exist at the pinned commit: `Service` + `inject`/`provide`, `ctx.on('agent/step' | 'tools/result' | 'llm/stream')`, `ctx.tools.register`. If any renamed, halt and re-plan.

Failure to complete §0 = halt. No speculative porting against an unverified surface.

---

## §1. Port objective

Take the 100 fable-5-1 specs (previously delivered as id / trigger / core rule / failure mode) and produce **one** dsh bundle:

- Package name: `fable-5-1-dsh`
- Bundle manifest: `dsh.bundle.patch → ./cordis.patch.yml`
- Runtime: Cordis, TypeScript, ESM only
- Distribution: `file:` install for dev, registry publish optional
- License: MIT (matches dsh)

The 100 specs are **not** 100 plugins. They are 100 rules enforced by 3 dsh primitives: a policy service, event hooks, and tools. The orchestrator produces one bundle, not one hundred.

---

## §2. Deliverable inventory

The orchestrator ships exactly these artifacts. No more, no less.

```
fable-5-1-dsh/
├── package.json                 # dsh.bundle manifest, peerDeps, engines
├── cordis.patch.yml             # bundle patch: service + hooks + tools
├── tsconfig.json                # extends dsh base, ESM
├── README.md                    # install, activate, config, guarantees
├── LICENSE                      # MIT
├── src/
│   ├── index.ts                 # apply(ctx) entry, wires everything
│   ├── policy-service.ts        # Service subclass, registry + state
│   ├── config/
│   │   ├── schema.ts            # fail-loud config validation
│   │   └── defaults.ts          # default policy versions
│   ├── hooks/
│   │   ├── agent-step.ts        # spec 1, 4, 6, 22, 24, 71, 72
│   │   ├── tools-result.ts      # spec 5, 7, 12, 47, 49
│   │   ├── llm-stream.ts        # spec 33, 42, 53, 92
│   │   └── session-boundary.ts  # spec 10, 18, 46, 88
│   ├── tools/
│   │   ├── context.ts           # specs 1, 22, 33
│   │   ├── verification.ts      # specs 5, 12, 47, 48, 70
│   │   ├── reasoning.ts         # specs 31–100 (grouped)
│   │   ├── dag.ts               # specs 17, 34, 50, 93
│   │   ├── cost.ts              # specs 11, 60, 95, 97
│   │   └── escalation.ts        # specs 8, 14, 27, 28, 52
│   ├── state/
│   │   ├── registry.ts          # spec 100
│   │   ├── lineage.ts           # spec 69, 87, 94
│   │   ├── cache.ts             # spec 43, 65
│   │   └── snapshots.ts         # spec 38, 46, 77, 83
│   └── types/
│       ├── pass.ts              # ReasoningPass, PassVerdict, PassScore
│       ├── artifact.ts          # ArtifactContract, Checksum
│       └── gate.ts              # Gate, GateResult
└── test/
    ├── unit/                    # per-module
    ├── integration/             # bundle loads, tools register
    └── e2e/                     # full agent loop with hooks firing
```

---

## §3. Cordis integration contract

The orchestrator must understand and respect Cordis semantics. These are non-negotiable.

### 3.1 Service

- `policy-service` extends `Service`. Registered under `ctx.fable51`.
- `inject: ['tools', 'llm', 'session']` declared in the apply signature. Missing inject = plugin PENDING forever. Silent. No error. The orchestrator must test for activation.
- `provide` declares what this service exposes to downstream plugins.
- Service holds: policy registry, active versions, pass lineage, snapshot index, cache index, cost ledger.

### 3.2 Events

- `ctx.on('agent/step', handler)` — fires between agent steps. Hook must be synchronous or return fast; long work goes to a queued tool.
- `ctx.on('tools/result', handler)` — fires after tool execution, before resolution. Used for verification gates and provenance tagging.
- `ctx.on('llm/stream', handler)` — fires on token stream. Used for interleaved budget, early exit, dedup.
- `ctx.on('session/boundary', handler)` — session start/end. Used for handoff, rollback, deadline propagation.

### 3.3 Tools

- Each reasoning-pass spec becomes a model-callable tool via `ctx.tools.register(name, schema, handler)`.
- Tool names namespaced: `fable51.*`. Never pollute root namespace.
- Every tool returns a typed result. No tool returns `void`.
- Every tool is idempotent (spec 19). Rerun = same output hash given same input hash.

### 3.4 Bundle manifest

- `package.json` must contain `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`.
- Missing manifest = silent install, never activates. The orchestrator must verify activation in e2e test, not by assumption.
- Patch file inserts service, hooks, tools in dependency order. Wrong order = boot failure.

### 3.5 Peer dependencies

- `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools` go in `peerDependencies`, **not** `dependencies`.
- Reason: stateful core packages in `dependencies` shadow the host, break desktop builds. This is a documented dsh pitfall.
- Version constraint: pin to the exact commit hash recorded in §0.

### 3.6 Encoding and hygiene

- LF line endings. UTF-8 no BOM. Final newline on every file.
- BOM kills dsh startup. Enforce via `.editorconfig` and a pre-commit hook.

---

## §4. The 100 specs — dsh mapping matrix

Grouped by enforcement surface. Each row names the spec, the surface, the mechanism, and the failure mode killed.

### 4.1 Context & session (specs 1–10, 22)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 1 context-management | agent/step | thresholds 70/85/90 → compact/drop/spill tool calls | silent truncation |
| 2 subagent-contracts | tools | spawn tool validates input/output schema, depth=1 | recursive fanout |
| 3 tool-call-batching | agent/step | pre-step: partition tool calls by dependency edge; emit batched list | serialized latency |
| 4 progress-reporting | agent/step | stage transition or gate fail → emit progress record | narration spam |
| 5 verification-gates | tools/result | every gate returns GateResult{check,cmd,expected,actual,pass} | green-by-assertion |
| 6 effort-escalation | agent/step | pre-first-tool: detect search/multi-hop → escalate tier | under-search |
| 7 research-provenance | tools/result | tag every claim [fetch:url]/[mem:era]/[inf] | memory-as-fact |
| 8 spec-clarification | agent/step | detect ≥2 readings or conflict or replan=3 → halt + ask | speculative build |
| 9 artifact-contracts | tools | every stage emits ArtifactContract{path,shape,schema,checksum} | implicit coupling |
| 10 session-handoff | session/boundary | persist stage map, state file, last verified hash | amnesia restart |
| 22 token-budget-per-stage | agent/step + llm/stream | per-stage allocation, alert 80%, hard stop 100% | runaway context |

### 4.2 Cost & effort (specs 11–14, 27–30)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 11 cost-accuracy-tradeoff | service | task class → tier → expected curve lookup | over/under-spend |
| 12 anti-introspection | tools/result | "verified" only if artifact+command+output present | false confidence |
| 13 worklog-format | tools | final emit stage/output/check/verdict/unverified | vague delivery |
| 14 replan-budget | agent/step | counter, max 2, third → escalate | replan loop |
| 27 human-in-the-loop | tools | irreversible/external/cost>budget → request approval | unilateral action |
| 28 escalation-ladder | service | retry→replan→downgrade→ask, one rung per failure | panic escalation |
| 29 dependency-pinning | session/boundary | verify pins at session start, block on drift | version skew |
| 30 postmortem-format | session/boundary | emit what-failed/why/fix/catching-test | repeated failure |

### 4.3 Reasoning pass structure (specs 15–20, 31–40)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 15 parallel-vs-sequential-reasoning | service | label passes explicitly; interleaved ≠ parallel | fake parallelism |
| 16 cold-verifier-isolation | tools | verifier tool accepts spec+artifact only | contamination |
| 17 stage-graph-dag | service | topo sort, cycle detect = hard fail | circular dep |
| 18 rollback-protocol | session/boundary | on fail, revert to last verified ancestor | cascade corruption |
| 19 idempotency | tools | hash check before rerun | double-write |
| 20 partial-delivery | tools | final unverified → ship prior + explicit list | false completion |
| 31 reasoning-forking | tools | fork/merge/discard decision tool | monolithic reasoning |
| 32 hypothesis-pruning | tools | score-gated prune, retain top-k | premature discard |
| 33 interleaved-budget | llm/stream | cap thinking tokens per tool call | overthinking |
| 34 reasoning-dag | service | passes as DAG, edges recorded | hidden coupling |
| 35 chain-vs-tree | tools | topology selector by branch factor | wrong topology |
| 36 verifier-forking | tools | fork verifier from spec not producer | contaminated verify |
| 37 parallel-tool-feed | agent/step | pre-reasoning batch | starved reasoning |
| 38 reasoning-checkpoint | service | snapshot at pass boundary | unrecoverable |
| 39 contradiction-detection | tools | pairwise compare pre-merge | silent conflict merge |
| 40 confidence-scoring | tools | weighted score, not majority | popularity merge |

### 4.4 Reasoning execution (specs 41–50)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 41 speculative-execution | tools | reuse-prob > cost → run; miss → log waste | lazy stall |
| 42 early-exit | llm/stream | ε-change < threshold over N turns → stop | run-to-budget |
| 43 reasoning-cache | service | key = input+spec+policy hash | recompute waste |
| 44 divergence-control | tools | branch cap per fork | branch explosion |
| 45 merge-strategy | tools | union/intersection/weighted-vote per task | wrong merge |
| 46 reasoning-rollback | session/boundary | revert to consistent checkpoint | corrupted merge |
| 47 chain-of-verification | tools | pass2 checks pass1, pass3 checks pass2 | single-layer trust |
| 48 independent-replication | tools | replicate with different seed/order | correlated error |
| 49 reasoning-trace-format | tools | emit {id, in_hash, out_hash, deps, verdict, score} | untraceable |
| 50 deadlock-detection | service | detect mutual wait in DAG | frozen pipeline |

### 4.5 Reasoning scheduling (specs 51–60)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 51 reasoning-priority | service | verify > critical-path > explore | misordered |
| 52 abort-criteria | tools | budget/convergence/contradiction → abort | zombie pass |
| 53 reasoning-dedup | llm/stream | fingerprint = hash(canonical content) | redundant work |
| 54 hypothesis-scoring | tools | w1·ev − w2·contra + w3·cov | gut pruning |
| 55 reasoning-bandwidth | service | max concurrent passes, excess queued | saturation |
| 56 failure-isolation | service | pass fail ≠ pipeline fail | cascade |
| 57 reasoning-replay | tools | replay from trace, hash compare | unreproducible debug |
| 58 convergence-criteria | service | distance<δ for N turns AND no new evidence | false convergence |
| 59 reasoning-audit | tools | classify pass: contributed/neutral/discarded | opaque contribution |
| 60 reasoning-cost-model | service | cost = tokens+latency+risk_weight | blind scheduling |

### 4.6 Reasoning topology (specs 61–70)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 61 reasoning-topology | tools | star/chain/mesh/ring selector | wrong shape |
| 62 adaptive-branching | tools | branch count ∝ ambiguity score | static branching |
| 63 reasoning-heatmap | tools | pass → token vs contribution map | hidden waste |
| 64 cross-pass-consistency | tools | shared-fact drift flag pre-merge | silent divergence |
| 65 reasoning-fingerprint | service | canonical hash for dedup+cache | missed dupes |
| 66 pass-scheduling | service | FIFO/priority/SJF declared | arbitrary order |
| 67 reasoning-window | service | bounded pass: turns+tokens+tools | unbounded pass |
| 68 merge-conflict-resolution | tools | vote/weight/escalate | deadlock merge |
| 69 reasoning-lineage | service | parent→child edges recorded | orphan passes |
| 70 speculative-verify | tools | verifier on partial artifact, abort on diverge | serial verify latency |

### 4.7 Reasoning flow control (specs 71–80)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 71 reasoning-backpressure | agent/step | queue depth > threshold → throttle forks | queue overflow |
| 72 pass-timeout | agent/step | per-pass deadline → snapshot + unverified + escalate | stuck pass |
| 73 reasoning-quorum | tools | ≥N agree or weighted ≥ threshold | premature commit |
| 74 diversity-injection | tools | seed/prompt/source variation | echo chamber |
| 75 reasoning-decay | service | weight ∝ exp(−λ·age) | stale dominance |
| 76 pass-prioritization | service | risk/uncertainty/cost-first per context | wrong-first |
| 77 reasoning-snapshot-diff | tools | diff snapshots for drift/regression | invisible change |
| 78 reasoning-federation | service | passes on workers, contract merge | centralized bottleneck |
| 79 pass-observability | service | per-pass trace id/start/end/tokens/verdict | unobservable |
| 80 reasoning-budget-pool | service | shared pool, per-pass cap, rebalance | monopoly |

### 4.8 Reasoning ops (specs 81–90)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 81 pass-retry-policy | tools | max 2, exp backoff, abort 3rd | retry storm |
| 82 reasoning-quarantine | tools | suspect pass isolated pre-merge | contaminated merge |
| 83 pass-checkpoint-strategy | service | per-turn/critical, N-token/bulk, milestone/long | over/under checkpoint |
| 84 reasoning-lane | service | fast/slow/verify lane routing | wrong lane |
| 85 pass-cancellation | tools | premise invalidated → cancel + descendants | zombie work |
| 86 reasoning-affinity | service | similar passes → same worker | cache miss |
| 87 pass-lineage-prune | service | drop unreferenced ancestry, keep audit | memory bloat |
| 88 reasoning-deadline-propagation | session/boundary | child deadline = min(parent, own) | deadline leak |
| 89 pass-quality-score | tools | w1·ev+w2·coh+w3·cov−w4·contra | unscored passes |
| 90 reasoning-warmup | tools | short calibration pre-pass | cold-start waste |

### 4.9 Reasoning merge & governance (specs 91–100)

| Spec | Surface | Mechanism | Kills |
|---|---|---|---|
| 91 pass-merge-idempotency | tools | merge associative + order-independent | order-dependent |
| 92 reasoning-drift-detection | llm/stream | pass output vs spec anchor, ε threshold | goal drift |
| 93 pass-dependency-inference | service | infer edges from content+flow, record inferred vs declared | hidden deps |
| 94 reasoning-garbage-collection | service | collect unreferenced, keep last N | orphan accumulation |
| 95 pass-cost-accounting | service | per-pass tokens+latency+retries+verifier | invisible cost |
| 96 reasoning-fork-merge-budget | service | cap forks/merges/depth per stage | runaway structure |
| 97 pass-sla | service | latency/token/accuracy targets, breach → log+degrade | silent SLA miss |
| 98 reasoning-ab-test | service | A vs B policy on same input, pick by score/cost | dogmatic policy |
| 99 pass-migration | tools | migrate pass across models, verify output, log divergence | untracked migration |
| 100 reasoning-policy-registry | service | registry: id/version/owner/active/hash; change = new version | policy drift |

---

## §5. Config schema

The bundle must fail loudly on invalid config. Silent misconfiguration is the top dsh port failure mode.

```typescript
// src/config/schema.ts
export interface Fable51Config {
  // Spec 1
  context: {
    compactAt: number      // default 0.70
    dropAt: number         // default 0.85
    spillAt: number        // default 0.90
    spillPath: string      // default '.dsh/fable-spill'
  }
  // Spec 6, 11
  effort: {
    defaultTier: 'low' | 'mid' | 'high' | 'max'
    escalateOn: Array<'search' | 'multihop' | 'ambiguity'>
    costCeiling: number    // tokens
  }
  // Spec 14, 52, 81
  budget: {
    maxReplans: 2
    maxPassRetries: 2
    passTimeoutMs: number
    stageTimeoutMs: number
  }
  // Spec 31–100
  reasoning: {
    maxConcurrentPasses: number    // spec 55
    maxForkDepth: number           // spec 96
    convergenceDelta: number       // spec 58
    convergenceTurns: number
    decayLambda: number            // spec 75
    quorumThreshold: number        // spec 73
  }
  // Spec 27
  hitl: {
    requireOnIrreversible: boolean
    requireOnExternal: boolean
    requireAboveCost: number
  }
  // Spec 100
  registry: {
    policies: Array<{ id: string; version: string; owner: string; active: boolean; hash: string }>
  }
}
```

Validation: on plugin load, if config violates schema, throw with explicit field path. Do not default silently on conflict.

---

## §6. Execution protocol for the orchestrator

The orchestrator works in the following order. Do not reorder.

### Phase 0 — Reconnaissance (no code)

1. Clone dsh at pinned commit.
2. Read `AGENTS.md`, `docs/architecture/*`, `docs/development/*`.
3. Locate: `Service` definition, event names, tool registration API, bundle manifest schema, patch file schema.
4. Write a one-page `RECON.md` recording exact symbols, paths, and versions.
5. Halt if any surface differs from §3.

### Phase 1 — Skeleton

1. Create package directory.
2. Write `package.json` with `dsh.bundle` manifest and peerDeps.
3. Write `cordis.patch.yml` with empty inserts.
4. Write `src/index.ts` with `apply(ctx)` that logs "fable-5-1 loaded".
5. Install as `file:` in a scratch dsh profile.
6. Verify activation: log appears, no PENDING, no error.
7. **Gate 1: activation verified.** No proceed on assumption.

### Phase 2 — Service + config

1. Implement `policy-service` as `Service` subclass.
2. Implement config schema with fail-loud validation.
3. Register service under `ctx.fable51`.
4. Add `inject: ['tools', 'llm', 'session']`.
5. **Gate 2: service resolves, config validates, bad config throws with field path.**

### Phase 3 — Event hooks

1. Implement `agent-step`, `tools-result`, `llm-stream`, `session-boundary` hooks.
2. Each hook logs on entry (dev mode only).
3. Each hook wires to service state.
4. **Gate 3: all four hooks fire in a synthetic session.**

### Phase 4 — Tools, grouped

Implement in this order, testing after each group:

1. Context tools (specs 1, 22, 33) — **Gate 4a**
2. Verification tools (specs 5, 12, 47, 48, 70) — **Gate 4b**
3. DAG tools (specs 17, 34, 50, 93) — **Gate 4c**
4. Cost tools (specs 11, 60, 95, 97) — **Gate 4d**
5. Escalation tools (specs 8, 14, 27, 28, 52) — **Gate 4e**
6. Reasoning tools (specs 31–100 remainder, batched) — **Gate 4f–4j**

Each gate: tool registers, invocable via dsh, returns typed result, idempotent on rerun.

### Phase 5 — State

1. Registry (spec 100): immutable versioned policy store.
2. Lineage (specs 69, 87, 94): pass tree with prune + GC.
3. Cache (specs 43, 65): keyed by input+spec+policy hash.
4. Snapshots (specs 38, 46, 77, 83): checkpoint index with diff.
5. **Gate 5: state survives session boundary, replays deterministically (spec 25).**

### Phase 6 — Integration

1. Full agent loop with all hooks + tools active.
2. Run a representative task: context overflow → compact → verify → fork reasoning → merge → deliver.
3. Confirm: worklog emitted (spec 13), provenance tagged (spec 7), unverified list explicit (spec 20).
4. **Gate 6: end-to-end pass. Log + replay hash match (spec 25).**

### Phase 7 — Packaging

1. `README.md`: install, activate, config reference, guarantees, known limits.
2. `LICENSE`: MIT.
3. Encoding check: LF, UTF-8 no BOM, final newline.
4. Publish path: `file:` for dev, registry optional.
5. **Gate 7: fresh dsh install from clean checkout loads plugin, all gates re-pass.**

---

## §7. Hard constraints

Violation = halt + re-plan, not workaround.

1. No `dependencies` on stateful dsh core packages. `peerDependencies` only.
2. No silent config fallback. Invalid = throw with field path.
3. No tool without typed result. No tool without idempotency check.
4. No hook doing long work inline. Queue to tool.
5. No policy mutation. New version only (spec 100).
6. No assumption of activation. Verify in e2e (Gate 1).
7. No use of `latest` for dsh. Pinned commit only.
8. No BOM. No CRLF. No missing final newline.
9. No spec implemented as stub. Every spec has a test.
10. No merge without contradiction check (spec 39) and consistency check (spec 64).

---

## §8. Definition of done

The orchestrator declares done when:

1. All 100 specs have an implementation and a passing test.
2. All 7 phase gates pass on a clean checkout.
3. Bundle installs via `file:` and activates without PENDING.
4. A synthetic agent session exercises: context compaction, verification gate fail + rollback, reasoning fork + merge, cost accounting, escalation to user, session handoff + resume.
5. Worklog format (spec 13) emitted, provenance tags (spec 7) present, unverified list (spec 20) explicit.
6. README documents install, config, guarantees, and the pinned dsh commit.
7. No file has BOM, CRLF, or missing final newline.
8. `pnpm lint`, `pnpm typecheck`, `pnpm test` all green.

Anything less = not done. Partial delivery (spec 20) is permitted as a shipping state, but the deliverable must declare exactly which specs are unverified.

---

## §9. Escalation triggers for the orchestrator

Halt and escalate to the human operator when:

1. dsh surface in §3 no longer exists at pinned commit.
2. Any phase gate fails twice.
3. Replan count reaches 3 (spec 14).
4. A spec's implementation requires modifying dsh core. (Out of scope. Escalate.)
5. Config schema conflicts with dsh-provided config.
6. Test suite produces nondeterministic failures (spec 25 violation).
7. Cost ledger exceeds declared ceiling (spec 11).

Escalation format: `halt | phase | spec | what-broke | what-was-tried | what-is-needed`. No prose.

---

## §10. Summary

One bundle. Three primitives: service, hooks, tools. One hundred specs mapped. Seven gates, each able to fail. Pinned commit. Peer deps only. Fail-loud config. Every spec tested. Escalation ladder enforced. Worklog emitted. Done means done.

Archive complete. Dead network absent. Build it.