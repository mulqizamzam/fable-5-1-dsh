FABLE-5-1 / DSH PORT — ORCHESTRATOR SPECIFICATION
Version 0.1.0. Target: dsh developer-preview, Cordis runtime, everything-is-a-plugin.
Purpose: a single orchestrator agent consumes this document and produces a working dsh bundle implementing all 100 fable-5-1 specs. Count verified.

§0. Preconditions — verify before any code
dsh pinned to a specific commit hash. Record it. Developer preview breaks compatibility without warning. Do not use latest.

pnpm version recorded. dsh uses pnpm-workspace.yaml; npm corrupts the lockfile.

Node major version ≥ declared in dsh package.json engines.

Read, in order, before writing a line: AGENTS.md, docs/architecture/*, docs/development/*, packages/cordis/README, packages/dsh-tools/README. Do not invent integration points. Read them.

Confirm the three surfaces the port depends on exist at the pinned commit: Service + inject/provide; ctx.on('agent/step' | 'tools/result' | 'llm/stream' | 'session/boundary'); ctx.tools.register. Any rename = halt, re-plan.

Failure at §0 = halt. No speculative porting.

§1. Objective
Produce one dsh bundle from the 100 fable-5-1 specs.

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
│   │   ├── agent-step.ts
│   │   ├── tools-result.ts
│   │   ├── llm-stream.ts
│   │   └── session-boundary.ts
│   ├── tools/
│   │   ├── context.ts
│   │   ├── verification.ts
│   │   ├── reasoning.ts
│   │   ├── dag.ts
│   │   ├── cost.ts
│   │   ├── escalation.ts
│   │   ├── ops.ts               # specs 21, 23–26, 27
│   │   └── governance.ts        # specs 91–100
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

inject: ['tools', 'llm', 'session'] in apply signature. Missing inject = PENDING forever, silent.

provide declares downstream surface.

Holds: policy registry, active versions, pass lineage, snapshot index, cache index, cost ledger.

3.2 Events
agent/step — between agent steps. Hook synchronous or fast; long work queues to a tool.

tools/result — after tool execution, before resolution. Verification gates, provenance tagging.

llm/stream — token stream. Interleaved budget, early exit, dedup.

session/boundary — session start/end. Handoff, rollback, deadline propagation.

3.3 Tools
Each spec becomes a model-callable tool via ctx.tools.register(name, schema, handler).

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

Version constraint: exact commit hash from §0.

3.6 Encoding
LF. UTF-8 no BOM. Final newline on every file.

BOM kills dsh startup. Enforce via .editorconfig + pre-commit hook.

§4. The 100 specs — dsh mapping matrix
Every spec appears exactly once. Row = spec, surface, mechanism, failure mode killed.

4.1 Context & session
#	Spec	Surface	Mechanism	Kills
1	context-management	agent/step	thresholds 70/85/90 → compact/drop/spill	silent truncation
2	subagent-contracts	tools	spawn validates input/output schema, depth=1	recursive fanout
3	tool-call-batching	agent/step	pre-step: partition by dependency edge, emit batch	serialized latency
4	progress-reporting	agent/step	stage transition or gate fail → progress record	narration spam
5	verification-gates	tools/result	gate returns {check,cmd,expected,actual,pass}	green-by-assertion
6	effort-escalation	agent/step	pre-first-tool: search/multi-hop → escalate tier	under-search
7	research-provenance	tools/result	tag claim [fetch:url]/[mem:era]/[inf]	memory-as-fact
8	spec-clarification	agent/step	≥2 readings, conflict, or replan=3 → halt+ask	speculative build
9	artifact-contracts	tools	stage emits {path,shape,schema,checksum}	implicit coupling
10	session-handoff	session/boundary	persist stage map + state + last hash	amnesia restart
4.2 Cost, effort, ops
#	Spec	Surface	Mechanism	Kills
11	cost-accuracy-tradeoff	service	task class → tier → expected curve	over/under-spend
12	anti-introspection	tools/result	"verified" needs artifact+command+output	false confidence
13	worklog-format	tools	emit stage/output/check/verdict/unverified	vague delivery
14	replan-budget	agent/step	counter, max 2, third → escalate	replan loop
21	timeboxing	agent/step + service	per-stage wall clock; expiry → snapshot + UNVERIFIED + escalate	open-ended stall
23	conflict-resolution	service	precedence: spec > contract > subagent > memory; log	silent override
24	observability	agent/step + service	per-stage trace id, start, end, tokens, verdict — one line	blind execution
25	determinism	service + test	seed fixed, iteration order fixed, versions pinned	unreproducible
26	sandbox-boundaries	tools + service	declared allow-list; escape = hard abort + log	boundary leak
27	human-in-the-loop	tools	irreversible/external/cost>budget → approval	unilateral action
28	escalation-ladder	service	retry→replan→downgrade→ask, one rung per failure	panic escalation
29	dependency-pinning	session/boundary	verify pins at session start, block on drift	version skew
30	postmortem-format	session/boundary	emit what-failed/why/fix/catching-test	repeated failure
22	token-budget-per-stage	agent/step + llm/stream	per-stage allocation, alert 80%, stop 100%	runaway context
4.3 Reasoning pass structure
#	Spec	Surface	Mechanism	Kills
15	parallel-vs-sequential-reasoning	service	label passes; interleaved ≠ parallel	fake parallelism
16	cold-verifier-isolation	tools	verifier accepts spec+artifact only	contamination
17	stage-graph-dag	service	topo sort; cycle = hard fail	circular dep
18	rollback-protocol	session/boundary	revert to last verified ancestor	cascade corruption
19	idempotency	tools	hash check before rerun	double-write
20	partial-delivery	tools	final unverified → ship prior + explicit list	false completion
31	reasoning-forking	tools	fork/merge/discard decision tool	monolithic reasoning
32	hypothesis-pruning	tools	score-gated prune, retain top-k	premature discard
33	interleaved-budget	llm/stream	cap thinking tokens per tool call	overthinking
34	reasoning-dag	service	passes as DAG, edges recorded	hidden coupling
35	chain-vs-tree	tools	topology selector by branch factor	wrong topology
36	verifier-forking	tools	fork verifier from spec not producer	contaminated verify
37	parallel-tool-feed	agent/step	pre-reasoning batch	starved reasoning
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
46	reasoning-rollback	session/boundary	revert to consistent checkpoint	corrupted merge
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
71	reasoning-backpressure	agent/step	queue depth > threshold → throttle forks	queue overflow
72	pass-timeout	agent/step	per-pass deadline → snapshot + unverified + escalate	stuck pass
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
88	reasoning-deadline-propagation	session/boundary	child deadline = min(parent, own)	deadline leak
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
Count check: 4.1 = 10, 4.2 = 11, 4.3 = 16, 4.4 = 10, 4.5 = 10, 4.6 = 10, 4.7 = 10, 4.8 = 10, 4.9 = 10. Sum = 100.

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
  budget: {                        // specs 14, 21, 22, 52, 72, 81, 96
    maxReplans: 2
    maxPassRetries: 2
    passTimeoutMs: number
    stageTimeoutMs: number
    stageTokenBudget: number
    maxForkDepth: number
    maxForksPerStage: number
    maxMergesPerStage: number
  }
  reasoning: {                     // specs 43, 55, 58, 73, 75, 96
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

Read AGENTS.md, docs/architecture/*, docs/development/*.

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

Register under ctx.fable51.

inject: ['tools','llm','session'].

Gate 2: service resolves, config validates, bad config throws with field path.

Phase 3 — Event hooks
agent-step, tools-result, llm-stream, session-boundary.

Each logs on entry (dev only).

Each wires to service state.

Gate 3: all four hooks fire in synthetic session.

Phase 4 — Tools (grouped, test after each)
Context tools (1, 22, 33) — Gate 4a

Verification tools (5, 12, 16, 36, 47, 48, 70) — Gate 4b

DAG tools (17, 34, 50, 93) — Gate 4c

Cost tools (11, 60, 95, 97) — Gate 4d

Escalation tools (8, 14, 27, 28, 52, 72, 81) — Gate 4e

Ops tools (21, 23, 24, 25, 26, 29, 30) — Gate 4f

Reasoning tools (31, 32, 35, 37, 38, 39, 40, 41, 42, 44, 45, 46, 49, 51, 53, 54, 56, 57, 59, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 76, 77, 78, 79, 80, 82, 83, 84, 85, 86, 87, 88, 89, 90) — Gates 4g–4n (batched)

Governance tools (13, 20, 91, 92, 94, 98, 99) — Gate 4o

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

