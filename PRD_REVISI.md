FABLE-5-1 / DSH PORT — ORCHESTRATOR SPECIFICATION
Version 0.1.1. Target: dsh developer-preview, Cordis runtime, everything-is-a-plugin.
Purpose: a single orchestrator agent consumes this document and produces a working dsh bundle implementing all 100 fable-5-1 specs. Count verified.

§0. Preconditions — verify before any code
dsh pinned to a specific commit hash. Record it. Developer preview breaks compatibility without warning. Do not use latest.

pnpm version recorded. dsh uses pnpm-workspace.yaml; npm corrupts the lockfile.

Node major version ≥ declared in dsh package.json engines.

Read, in order, before writing a line: AGENTS.md, docs/user/develop/framework/* (service.md, events.md), docs/subsystems/*, vendor/cordis (package.json + src), packages/core/tools (src). Do not invent integration points. Read them. (Paths verified against the pinned checkout; v0.1.0's packages/cordis, packages/dsh-tools, docs/architecture, docs/development do not exist there.)

Confirm the dsh surfaces the port depends on exist at the pinned commit: (1) Service + inject/provide; (2) the events ctx.on('agent/pre-step' | 'tools/result' | 'llm/stream' | 'session/event') plus the lifecycle events 'session/created' | 'session/disposed'; (3) ctx.tools.register(definition: ToolDefinition). Any rename or reshape = halt, re-plan. Verification status for this document: executed at dsh commit 23c78fcdd5ee0b497a77ca356608c51093c74bb9 (v0.2.0-rc.2); v0.1.0's agent/step and session/boundary did not exist and were corrected — evidence in §11.

Failure at §0 = halt. No speculative porting.

§1. Objective
Produce one dsh bundle from the 100 fable-5-1 specs (source inventory: sumber100specs.md — id, core rule, trigger per spec).

Package: fable-5-1-dsh

Manifest: dsh.bundle.patch → ./cordis.patch.yml

Runtime: Cordis, TypeScript, ESM only

Distribution: file: for dev, registry optional

License: MIT

100 specs are not 100 plugins. They are 100 rules enforced by 3 dsh primitives — a policy service, event hooks, tools. One bundle.

§2. Deliverable inventory
text
fable-5-1-dsh/
├── package.json                 # dsh.bundle manifest, peerDeps, engines
├── cordis.patch.yml             # bundle patch: service + hooks + tools
├── tsconfig.json                # extends dsh base, ESM
├── README.md                    # install, activate, config, guarantees
├── LICENSE                      # MIT
├── .editorconfig                # LF, UTF-8 no BOM, final newline
├── src/
│   ├── index.ts                 # apply(ctx) entry, wires everything
│   ├── policy-service.ts        # Service subclass, registry + state
│   ├── config/
│   │   ├── schema.ts            # fail-loud config validation
│   │   └── defaults.ts          # default policy versions
│   ├── hooks/
│   │   ├── agent-pre-step.ts
│   │   ├── tools-result.ts
│   │   ├── llm-stream.ts
│   │   └── session-event.ts
│   ├── tools/
│   │   ├── context.ts
│   │   ├── verification.ts
│   │   ├── reasoning.ts
│   │   ├── dag.ts
│   │   ├── cost.ts
│   │   ├── escalation.ts
│   │   ├── ops.ts               # specs 21, 23–26, 29, 30
│   │   └── governance.ts        # specs 13, 20, 91, 92, 94, 98, 99
│   ├── state/
│   │   ├── registry.ts
│   │   ├── lineage.ts
│   │   ├── cache.ts
│   │   └── snapshots.ts
│   └── types/
│       ├── pass.ts
│       ├── artifact.ts
│       └── gate.ts
└── test/
    ├── unit/
    ├── integration/
    └── e2e/
§3. Cordis integration contract
3.1 Service
policy-service extends Service, registered under ctx.fable51.

inject: ['tools', 'llm', 'sessions'] as a module-level export const (or static on the Service class) — names verified: tools and llm are documented built-in services; the session service is registered under the name 'sessions' (packages/core/session/src/index.ts). When a required service is not ready, dsh docs state the plugin waits instead of running — treat that as no-activation and test for it at Gate 1.

provide declares downstream surface.

Holds: policy registry, active versions, pass lineage, snapshot index, cache index, cost ledger.

3.2 Events
agent/pre-step — waterfall; fires once per proposed step before the step opens. Payload { agent, messages, turn, step, signal }; a listener returns a PreStepDecision and may reject or steer the step, and must call next() to admit it. Long work queues to a tool, never inline.

tools/result — emit-mode; fires after tool execution with (exec, result). Observers only: a listener can tag or gate downstream work but cannot rewrite the returned result.

llm/stream — waterfall over the token stream; a listener must call next() and pass chunks through. Interleaved budget, early exit, dedup.

session/event — emit-mode; fires with (session, event) where event.type is a durable type (turn/start, step/end, tool/result, compaction/*, ...). Session start/end is covered by the lifecycle events session/created and session/disposed. Durable types are not Cordis event names; inspect event.type. Handoff, rollback, deadline propagation.

3.3 Tools
Each spec becomes a model-callable tool via ctx.tools.register(definition: ToolDefinition): () => void — one object (name, schema, output: { schema, render, presentationMeta? }, optional timeoutMs), returning a disposer. Registration throws on a missing output.render and on the reserved name run_code (packages/core/tools/src/index.ts).

Namespace: fable51.*. Never pollute root.

Every tool returns a typed result. No void.

Every tool idempotent (spec 19). Rerun = same output hash for same input hash.

3.4 Bundle manifest
package.json must contain "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }.

Missing manifest = silent install, never activates. Verify activation in e2e, not by assumption.

Patch inserts service, hooks, tools in dependency order. Wrong order = boot failure.

3.5 Peer dependencies
@deepseek-ai/cordis, @deepseek-ai/dsh-tools in peerDependencies, not dependencies.

Stateful core packages in dependencies shadow host, break desktop builds.

Version constraint: inside the dsh repo use workspace:~ (the convention of @deepseek-ai/dsh-experimental-inspector); for an install into an external host use github:deepseek-ai/deepseek-harness#<commit>. A semver range alone does not pin a snapshot; record the dsh commit from §0 beside it.

3.6 Encoding
LF. UTF-8 no BOM. Final newline on every file.

BOM kills dsh startup. Enforce via .editorconfig + pre-commit hook.

§4. The 100 specs — dsh mapping matrix
Every spec appears exactly once. Row = spec, surface, mechanism, failure mode killed.

4.1 Context & session
#	Spec	Surface	Mechanism	Kills
1	context-management	agent/pre-step	thresholds 70/85/90 → compact/drop/spill	silent truncation
2	subagent-contracts	tools	spawn validates input/output schema, depth=1	recursive fanout
3	tool-call-batching	agent/pre-step	pre-step: partition by dependency edge, emit batch	serialized latency
4	progress-reporting	agent/pre-step	stage transition or gate fail → progress record	narration spam
5	verification-gates	tools/result	gate returns {check,cmd,expected,actual,pass}	green-by-assertion
6	effort-escalation	agent/pre-step	pre-first-tool: search/multi-hop → escalate tier	under-search
7	research-provenance	tools/result	tag claim [fetch:url]/[mem:era]/[inf]	memory-as-fact
8	spec-clarification	agent/pre-step	≥2 readings, conflict, or replan=3 → halt+ask	speculative build
9	artifact-contracts	tools	stage emits {path,shape,schema,checksum}	implicit coupling
10	session-handoff	session/event	persist stage map + state + last hash	amnesia restart
4.2 Cost, effort, ops
#	Spec	Surface	Mechanism	Kills
11	cost-accuracy-tradeoff	service	task class → tier → expected curve	over/under-spend
12	anti-introspection	tools/result	"verified" needs artifact+command+output	false confidence
13	worklog-format	tools	emit stage/output/check/verdict/unverified	vague delivery
14	replan-budget	agent/pre-step	counter, max 2, third → escalate	replan loop
21	timeboxing	agent/pre-step + service	per-stage wall clock; expiry → snapshot + UNVERIFIED + escalate	open-ended stall
23	conflict-resolution	service	precedence: spec > contract > subagent > memory; log	silent override
24	observability	agent/pre-step + service	per-stage trace id, start, end, tokens, verdict — one line	blind execution
25	determinism	service + test	seed fixed, iteration order fixed, versions pinned	unreproducible
26	sandbox-boundaries	tools + service	declared allow-list; escape = hard abort + log	boundary leak
27	human-in-the-loop	tools	irreversible/external/cost>budget → approval	unilateral action
28	escalation-ladder	service	retry→replan→downgrade→ask, one rung per failure	panic escalation
29	dependency-pinning	session/event	verify pins at session start, block on drift	version skew
30	postmortem-format	session/event	emit what-failed/why/fix/catching-test	repeated failure
22	token-budget-per-stage	agent/pre-step + llm/stream	per-stage allocation, alert 80%, stop 100%	runaway context
4.3 Reasoning pass structure
#	Spec	Surface	Mechanism	Kills
15	parallel-vs-sequential-reasoning	service	label passes; interleaved ≠ parallel	fake parallelism
16	cold-verifier-isolation	tools	verifier accepts spec+artifact only	contamination
17	stage-graph-dag	service	topo sort; cycle = hard fail	circular dep
18	rollback-protocol	session/event	revert to last verified ancestor	cascade corruption
19	idempotency	tools	hash check before rerun	double-write
20	partial-delivery	tools	final unverified → ship prior + explicit list	false completion
31	reasoning-forking	tools	fork/merge/discard decision tool	monolithic reasoning
32	hypothesis-pruning	tools	score-gated prune, retain top-k	premature discard
33	interleaved-budget	llm/stream	cap thinking tokens per tool call	overthinking
34	reasoning-dag	service	passes as DAG, edges recorded	hidden coupling
35	chain-vs-tree	tools	topology selector by branch factor	wrong topology
36	verifier-forking	tools	fork verifier from spec not producer	contaminated verify
37	parallel-tool-feed	agent/pre-step	pre-reasoning batch	starved reasoning
38	reasoning-checkpoint	service	snapshot at pass boundary	unrecoverable
39	contradiction-detection	tools	pairwise compare pre-merge	silent conflict merge
40	confidence-scoring	tools	weighted score, not majority	popularity merge
4.4 Reasoning execution
#	Spec	Surface	Mechanism	Kills
41	speculative-execution	tools	reuse-prob > cost → run; miss → log	lazy stall
42	early-exit	llm/stream	ε-change < threshold over N turns → stop	run-to-budget
43	reasoning-cache	service	key = input+spec+policy hash	recompute waste
44	divergence-control	tools	branch cap per fork	branch explosion
45	merge-strategy	tools	union/intersection/weighted-vote per task	wrong merge
46	reasoning-rollback	session/event	revert to consistent checkpoint	corrupted merge
47	chain-of-verification	tools	pass2 checks pass1, pass3 checks pass2	single-layer trust
48	independent-replication	tools	replicate with different seed/order	correlated error
49	reasoning-trace-format	tools	emit {id,in_hash,out_hash,deps,verdict,score}	untraceable
50	deadlock-detection	service	detect mutual wait in DAG	frozen pipeline
4.5 Reasoning scheduling
#	Spec	Surface	Mechanism	Kills
51	reasoning-priority	service	verify > critical-path > explore	misordered
52	abort-criteria	tools	budget/convergence/contradiction → abort	zombie pass
53	reasoning-dedup	llm/stream	fingerprint = hash(canonical content)	redundant work
54	hypothesis-scoring	tools	w1·ev − w2·contra + w3·cov	gut pruning
55	reasoning-bandwidth	service	max concurrent passes, excess queued	saturation
56	failure-isolation	service	pass fail ≠ pipeline fail	cascade
57	reasoning-replay	tools	replay from trace, hash compare	unreproducible debug
58	convergence-criteria	service	distance<δ for N turns AND no new evidence	false convergence
59	reasoning-audit	tools	classify: contributed/neutral/discarded	opaque contribution
60	reasoning-cost-model	service	cost = tokens+latency+risk_weight	blind scheduling
4.6 Reasoning topology
#	Spec	Surface	Mechanism	Kills
61	reasoning-topology	tools	star/chain/mesh/ring selector	wrong shape
62	adaptive-branching	tools	branch count ∝ ambiguity score	static branching
63	reasoning-heatmap	tools	pass → token vs contribution map	hidden waste
64	cross-pass-consistency	tools	shared-fact drift flag pre-merge	silent divergence
65	reasoning-fingerprint	service	canonical hash for dedup+cache	missed dupes
66	pass-scheduling	service	FIFO/priority/SJF declared	arbitrary order
67	reasoning-window	service	bounded pass: turns+tokens+tools	unbounded pass
68	merge-conflict-resolution	tools	vote/weight/escalate	deadlock merge
69	reasoning-lineage	service	parent→child edges recorded	orphan passes
70	speculative-verify	tools	verifier on partial artifact, abort on diverge	serial verify latency
4.7 Reasoning flow control
#	Spec	Surface	Mechanism	Kills
71	reasoning-backpressure	agent/pre-step	queue depth > threshold → throttle forks	queue overflow
72	pass-timeout	agent/pre-step	per-pass deadline → snapshot + unverified + escalate	stuck pass
73	reasoning-quorum	tools	≥N agree or weighted ≥ threshold	premature commit
74	diversity-injection	tools	seed/prompt/source variation	echo chamber
75	reasoning-decay	service	weight ∝ exp(−λ·age)	stale dominance
76	pass-prioritization	service	risk/uncertainty/cost-first per context	wrong-first
77	reasoning-snapshot-diff	tools	diff snapshots for drift/regression	invisible change
78	reasoning-federation	service	passes on workers, contract merge	centralized bottleneck
79	pass-observability	service	per-pass trace id/start/end/tokens/verdict	unobservable
80	reasoning-budget-pool	service	shared pool, per-pass cap, rebalance	monopoly
4.8 Reasoning ops
#	Spec	Surface	Mechanism	Kills
81	pass-retry-policy	tools	max 2, exp backoff, abort 3rd	retry storm
82	reasoning-quarantine	tools	suspect pass isolated pre-merge	contaminated merge
83	pass-checkpoint-strategy	service	per-turn/critical, N-token/bulk, milestone/long	over/under checkpoint
84	reasoning-lane	service	fast/slow/verify lane routing	wrong lane
85	pass-cancellation	tools	premise invalidated → cancel + descendants	zombie work
86	reasoning-affinity	service	similar passes → same worker	cache miss
87	pass-lineage-prune	service	drop unreferenced ancestry, keep audit	memory bloat
88	reasoning-deadline-propagation	session/event	child deadline = min(parent, own)	deadline leak
89	pass-quality-score	tools	w1·ev+w2·coh+w3·cov−w4·contra	unscored passes
90	reasoning-warmup	tools	short calibration pre-pass	cold-start waste
4.9 Reasoning merge & governance
#	Spec	Surface	Mechanism	Kills
91	pass-merge-idempotency	tools	merge associative + order-independent	order-dependent
92	reasoning-drift-detection	llm/stream	pass output vs spec anchor, ε threshold	goal drift
93	pass-dependency-inference	service	infer edges from content+flow, record inferred vs declared	hidden deps
94	reasoning-garbage-collection	service	collect unreferenced, keep last N	orphan accumulation
95	pass-cost-accounting	service	per-pass tokens+latency+retries+verifier	invisible cost
96	reasoning-fork-merge-budget	service	cap forks/merges/depth per stage	runaway structure
97	pass-sla	service	latency/token/accuracy targets, breach → log+degrade	silent SLA miss
98	reasoning-ab-test	service	A vs B policy on same input, pick by score/cost	dogmatic policy
99	pass-migration	tools	migrate pass across models, verify output, log divergence	untracked migration
100	reasoning-policy-registry	service	registry: id/version/owner/active/hash; change = new version	policy drift
Count check: 4.1 = 10, 4.2 = 14, 4.3 = 16, 4.4 = 10, 4.5 = 10, 4.6 = 10, 4.7 = 10, 4.8 = 10, 4.9 = 10. Sum = 100. (v0.1.0 stated 4.2 = 11 — its own numbers summed to 97; actual §4.2 row count is 14. Corrected.)

§5. Config schema
Fail loudly on invalid config. Silent misconfiguration is the top dsh port failure mode.

typescript
export interface Fable51Config {
  context: {                       // spec 1
    compactAt: number              // 0.70
    dropAt: number                 // 0.85
    spillAt: number                // 0.90
    spillPath: string
  }
  effort: {                        // specs 6, 11
    defaultTier: 'low'|'mid'|'high'|'max'
    escalateOn: Array<'search'|'multihop'|'ambiguity'>
    costCeiling: number
  }
  budget: {                        // specs 14, 21, 22, 72, 81, 96 (52 abort-criteria enforced in service logic, no config field)
    maxReplans: 2
    maxPassRetries: 2
    passTimeoutMs: number
    stageTimeoutMs: number
    stageTokenBudget: number
    maxForkDepth: number
    maxForksPerStage: number
    maxMergesPerStage: number
  }
  reasoning: {                     // specs 55, 58, 73, 75 (43 cache key derived at runtime; 96's fields live in the budget block)
    maxConcurrentPasses: number
    convergenceDelta: number
    convergenceTurns: number
    decayLambda: number
    quorumThreshold: number
  }
  determinism: {                   // spec 25
    seed: number
    iterationOrder: 'stable'|'sorted'
    pinnedVersions: Record<string, string>
  }
  sandbox: {                       // spec 26
    allowList: Record<string, string[]>
    escapeAction: 'abort'|'halt'
  }
  hitl: {                          // spec 27
    requireOnIrreversible: boolean
    requireOnExternal: boolean
    requireAboveCost: number
  }
  observability: {                 // spec 24, 79
    traceLevel: 'stage'|'pass'|'both'
    logFormat: 'line'|'json'
  }
  registry: {                      // spec 100
    policies: Array<{
      id: string; version: string; owner: string
      active: boolean; hash: string
    }>
  }
}
Validation on load: violation → throw with explicit field path. No silent default on conflict.

§6. Execution protocol
Order is load-bearing. Do not reorder.

Phase 0 — Reconnaissance (no code)
Clone dsh at pinned commit.

Read AGENTS.md, docs/user/develop/framework/*, docs/subsystems/*, vendor/cordis, packages/core/tools. (Same list as §0; v0.1.0's docs/architecture/* and docs/development/* do not exist at the pinned commit.)

Locate: Service, event names, tool registration, bundle manifest schema, patch schema.

Write RECON.md recording exact symbols, paths, versions.

Halt if any surface differs from §3.

Phase 1 — Skeleton
Package dir.

package.json with dsh.bundle + peerDeps.

cordis.patch.yml with empty inserts.

src/index.ts with apply(ctx) logging "fable-5-1 loaded".

Install as file: in scratch profile.

Verify activation: log appears, no PENDING, no error.

Gate 1: activation verified. No proceed on assumption.

Phase 2 — Service + config
policy-service as Service subclass.

Config schema, fail-loud.

Register under ctx.fable51. This phase also owns the service-surface specs not carried by a Phase 4 group or Phase 3 hooks: 15, 55, 58, 96.

inject: ['tools','llm','sessions'].

Gate 2: service resolves, config validates, bad config throws with field path.

Phase 3 — Event hooks
agent-pre-step, tools-result, llm-stream, session-event. This phase also owns the event-surface specs not carried by a Phase 4 tool group: 3, 4, 6, 10, 18.

Each logs on entry (dev only).

Each wires to service state.

Gate 3: all four hooks fire in synthetic session.

Phase 4 — Tools (grouped, test after each)
Context tools (1, 2, 9, 22, 33) — Gate 4a

Verification tools (5, 7, 12, 16, 19, 36, 47, 48, 70) — Gate 4b

DAG tools (17, 34, 50, 93) — Gate 4c

Cost tools (11, 60, 95, 97) — Gate 4d

Escalation tools (8, 14, 27, 28, 52, 72, 81) — Gate 4e

Ops tools (21, 23, 24, 25, 26, 29, 30) — Gate 4f

Reasoning tools (31, 32, 35, 37, 38, 39, 40, 41, 42, 44, 45, 46, 49, 51, 53, 54, 56, 57, 59, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 76, 77, 78, 79, 80, 82, 83, 84, 85, 86, 87, 88, 89, 90) — Gates 4g–4n (batched)

Governance tools (13, 20, 91, 92, 94, 98, 99) — Gate 4o

Coverage rule (enumerability per §8): every spec 1–100 has at least one enumerated phase home — Phase 5 for the state specs it lists (38, 43, 46, 65, 69, 77, 83, 87, 94, 100; of these, 38, 46, 65, 69, 77, 83, 87, 94 are dual-listed on purpose — implemented in the state layer, driven by their tool groups — while 43 and 100 are Phase 5-only), Phase 4 for the tool groups above, Phase 3 for the remaining event-surface specs (3, 4, 6, 10, 18), Phase 2 for the remaining service-surface specs (15, 55, 58, 96). Checked against the §4 matrix: 100/100 covered, no orphan spec.

Each gate: tool registers, invocable via dsh, returns typed result, idempotent on rerun.

Phase 5 — State
Registry (spec 100): immutable versioned policy store.

Lineage (69, 87, 94): pass tree, prune + GC.

Cache (43, 65): key = input+spec+policy hash.

Snapshots (38, 46, 77, 83): checkpoint index with diff.

Gate 5: state survives session boundary, replays deterministically (spec 25).

Phase 6 — Integration
Full loop, all hooks + tools active.

Representative task: context overflow → compact → verify → fork → merge → deliver.

Confirm: worklog (13), provenance (7), unverified list (20).

Gate 6: end-to-end pass. Log + replay hash match (spec 25).

Phase 7 — Packaging
README.md: install, activate, config, guarantees, limits.

LICENSE: MIT.

Encoding check: LF, UTF-8 no BOM, final newline.

Publish path: file: for dev, registry optional.

Gate 7: fresh dsh install from clean checkout loads plugin, all gates re-pass.

§7. Hard constraints
Violation = halt + re-plan, not workaround.

No dependencies on stateful dsh core. peerDependencies only.

No silent config fallback. Invalid = throw with field path.

No tool without typed result or idempotency check.

No hook doing long work inline. Queue to tool.

No policy mutation. New version only (spec 100).

No assumption of activation. Verify in e2e (Gate 1).

No latest for dsh. Pinned commit only.

No BOM. No CRLF. No missing final newline.

No spec implemented as stub. Every spec has a test.

No merge without contradiction check (39) and consistency check (64).

§8. Definition of done
All 100 specs implemented, each with a passing test. Enumerable against §4 tables.

All 7 phase gates pass on clean checkout.

Bundle installs via file: and activates without PENDING.

Synthetic session exercises: context compaction, gate fail + rollback, fork + merge, cost accounting, escalation, handoff + resume.

Worklog (13) emitted, provenance (7) present, unverified list (20) explicit.

README documents install, config, guarantees, pinned dsh commit.

No file has BOM, CRLF, or missing final newline.

pnpm lint, pnpm typecheck, pnpm test green.

Anything less = not done. Partial delivery permitted as shipping state, but must declare exactly which specs are unverified.

§9. Escalation triggers for the orchestrator
Halt and escalate when:

dsh surface in §3 no longer exists at pinned commit.

Any phase gate fails twice.

Replan count reaches 3 (spec 14).

A spec requires modifying dsh core. Out of scope.

Config schema conflicts with dsh-provided config.

Test suite produces nondeterministic failures (spec 25 violation).

Cost ledger exceeds declared ceiling (spec 11).

Format: halt | phase | spec | what-broke | what-was-tried | what-is-needed. No prose.

§10. Summary
One bundle. Three primitives: service, hooks, tools. 100 specs, mapped once each, count verified in §4. Seven gates, each able to fail. Pinned commit. Peer deps only. Fail-loud config. Every spec tested. Escalation ladder enforced. Worklog emitted. Done means done.

§11. Revision record (v0.1.1 — surface corrections applied against dsh commit 23c78fcdd5ee0b497a77ca356608c51093c74bb9, v0.2.0-rc.2)

1. Event names: v0.1.0 used 'agent/step' and 'session/boundary'. Neither exists in dsh (zero matches repo-wide; agent/pre-step, session/event, session/created, session/disposed all verified in packages/core). Corrected everywhere: §0, §3.2, §4 matrix Surface cells, §2 tree, §6 Phase 3.
2. Event semantics: agent/pre-step is a waterfall that returns PreStepDecision and can reject a step — not a "synchronous or fast" emit hook; listeners must call next(). tools/result is emit-mode and cannot rewrite results. llm/stream is a waterfall. session/event carries durable event types via event.type. Rewritten in §3.2.
3. Tool registration: v0.1.0's ctx.tools.register(name, schema, handler) does not exist; the real API is register(definition: ToolDefinition): () => void (packages/core/tools/src/index.ts). Corrected in §3.3.
4. Service name: inject 'session' corrected to 'sessions' — the service is registered as super(ctx, 'sessions') (packages/core/session/src/index.ts). The "PENDING forever, silent" wording replaced with the documented behavior: the plugin waits instead of running; activation is tested at Gate 1.
5. §0 and §6 Phase 0 reading lists: packages/cordis, packages/dsh-tools, docs/architecture, docs/development do not exist at the pinned commit (glob-verified). Corrected in both places to vendor/cordis, packages/core/tools, docs/user/develop/framework, docs/subsystems.
6. Count check: v0.1.0 stated 4.2 = 11 (its own numbers sum to 97 while claiming 100). Actual §4.2 = 14 rows. Corrected; matrix independently re-counted at 100 rows, specs 1–100 each exactly once.
7. §6 coverage: v0.1.0's Phase 4 groups enumerated only 85 specs; 13 of the remaining 15 had no home in any phase (specs 43 and 100 were already enumerated in Phase 5, so the true gap was 13). Fixed by rehoming 2, 9 into Context tools; 7, 19 into Verification tools; declaring Phase 3 ownership of event-surface specs 3, 4, 6, 10, 18; Phase 2 ownership of service-surface specs 15, 55, 58, 96; and the coverage rule after the Phase 4 list. Re-checked: 100/100 with no orphan.
8. §2 tree: hook files renamed to agent-pre-step.ts and session-event.ts; ops.ts comment corrected to (21, 23–26, 29, 30) and governance.ts to (13, 20, 91, 92, 94, 98, 99) to match §6 Phase 4.
9. §3.5 peerDeps pin: commit-hash pinning replaced with the repo's actual convention (workspace:~ inside the dsh repo; github:deepseek-ai/deepseek-harness#<commit> for external hosts).
10. Encoding: file normalized to LF with a final newline (v0.1.0 was CRLF), per §3.6, the encoding bullet in §7, and §8's encoding requirement.
11. Post-edit audit: an independent review of this v0.1.1 draft caught five residual defects, all fixed in place — the stale read list in §6 Phase 0 (line 311), the "four surfaces" count phrasing in §0 (it enumerates three items), the dual-listed set in the coverage rule (all eight state specs, not three), item 7's own arithmetic above (13, not 15), and two §5 block comments citing specs with no field in that block (52, 43, 96 — annotations only, no schema change).

Source verification (closed): the 100-spec source inventory is in the workspace as sumber100specs.md. Cross-checked against the §4 matrix: all 100 ids and names match exactly, including the five specs added by the operator in v0.1.0 (21 timeboxing, 23 conflict-resolution, 24 observability, 25 determinism, 26 sandbox-boundaries). Provenance of every spec definition is confirmed; no spec definition remains unsourced. The one check that could not be automated: the PRD's "Kills" mechanism column is an operator-layer addition on top of the source's core rule + trigger — consistent on the five checked specs, not line-by-line diffed for all 100.

