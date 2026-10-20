# fable-5-1-dsh

Fable-5.1 reasoning discipline for DeepSeek Harness (`dsh`). One bundle: a
policy service at `ctx.fable51`, four event hooks, and 92 tools prefixed
`fable51_`. It records tool outcomes, verification verdicts, and per-stage
costs, so a long run can be audited after the fact.

Measured at commit `3b701d6`:

| Item | Value |
|---|---|
| Target dsh | developer preview `0.2.0-rc.2`, commit `23c78fcdd5ee0b497a77ca356608c51093c74bb9` |
| Runtime | Cordis, TypeScript, ESM only |
| Tools | 92, one per implemented spec id |
| Hooks | 4 (`agent/pre-step`, `tools/result`, `llm/stream`, `session/event`) |
| Service | `ctx.fable51` |
| CLI | `fable51 inspect`, `fable51 advise-budget` |
| License | MIT |

Coverage of the 100 specs in `sumber100specs.md`:

| Class | Count | Where |
|---|---|---|
| Tool-backed | 92 | `fable51_<name>` on the tool surface |
| Service method driven by a hook | 6 | specs 10, 15, 18, 43, 58, 96 |
| Not implemented | 2 | spec 4 `progress-reporting`, spec 55 `reasoning-bandwidth` |

The two missing specs are not claimed as features. Spec 4 has no progress
format, and spec 55 validates `maxConcurrentPasses` in config without enforcing
a concurrency cap. Read [What enforces and what only reports](#what-enforces-and-what-only-reports)
before relying on a spec as a control: several are classifiers, not gates.

## Install

Development install into a scratch profile (the pattern used by other local
plugins here: a `link:` dependency plus a `dsh.profile.bundles` entry):

```jsonc
// <profile>/package.json
{
  "dependencies": { "fable-5-1-dsh": "link:/path/to/fable-5-1-dsh" },
  "dsh": { "profile": { "bundles": ["...", "fable-5-1-dsh"] } }
}
```

```sh
pnpm install                       # in the profile directory
dsh --profile <name> --dump-config # entry id must appear: fable-5-1
```

For an external host install, the peer dependencies resolve from the host tree.
Registry publish is optional; `file:` and `link:` are the supported dev paths.

## Activate

The bundle is a class plugin. `lib/index.js` default-exports `Fable51Policy`,
which registers as `ctx.fable51` and wires the hooks and tools in its
constructor. Activation is observable: the service logs a line containing
`fable-5-1 loaded` and the number of registered tools, and the tools appear in
`ctx.tools.schemas()`.

If a required service (`tools`, `llm`, `sessions`) is missing, the plugin waits
instead of running, which is documented dsh behavior. Verify activation; do not
assume it from a successful install.

## Use

| Route | What you do |
|---|---|
| Skill | Ask for `fable-5-1-discipline`. It orders stage map, fork, verify, merge, so you do not need tool names. |
| Manual | Call one tool for one check. Common ones: `fable51_verification-gates`, `fable51_stage-graph-dag`, `fable51_sandbox-boundaries`, `fable51_worklog-format`. |
| CLI | `fable51 inspect` renders the live service state; `fable51 advise-budget <taskClass>` recommends a budget config. |

`PLAYBOOK.md` has the full tool map and the operator procedures.

### CLI

```sh
pnpm build                        # emits lib/, including lib/cli.js

fable51 inspect                              # ASCII: policies, lineage, costs, cache, snapshots, config
fable51 inspect --format json                # the same state as JSON
fable51 inspect --include-worklog --include-gate-log

fable51 advise-budget multihop               # recommended stageTokenBudget, maxForkDepth, effortTier
fable51 advise-budget search --format json
fable51 advise-budget open --history-window 200 --min-samples 5
```

`fable51 inspect` is read-only: it reads the policy registry, pass lineage, cost
ledger, reason cache, snapshot index, and worklog of a booted bundle. It mutates
nothing.

`fable51 advise-budget` derives its recommendation from the cost ledger
(`spec 11`, `spec 60`): per-stage p50/p90 token and latency quantiles, scaled by
a task-class multiplier, with a confidence label from the sample count. With an
empty ledger it falls back to task-class defaults and reports `low` confidence —
the recommendation is then a floor, not a measurement.

The CLI boots a real Cordis host with the real dsh services, so it needs the
bundle's peer dependencies resolvable at run time.

## Result contract

Every tool returns the same envelope:

```json
{
  "ok": true,
  "spec": "5",
  "output": { "check": "...", "pass": true },
  "verdict": "verified",
  "unverified": [],
  "rerun": false,
  "gates": []
}
```

`ok` is `false` for a rejected argument or a tool failure, never a throw into
the host. `verdict` can only fall to `unverified`: a tool that reports
`pass:false`, `missing[]`, or `unverified[]` does not come back as `verified`.
`rerun` is `true` when the answer came from the idempotency cache. Effectful
tools always re-execute; the cache covers pure computations only.

The host registry validates the returned envelope against its declared schema.
It does not validate input arguments, so a wrong argument schema shows up at
call time, not at registration time.

## Config

Config is optional and partial: `resolveConfig` deep-merges your object onto the
full defaults, then validates. Defaults are not a silent fallback. An unknown
key, a wrong type, an out-of-range value, or unordered context thresholds throws
`ConfigError` with the exact field path, and a supplied `config:` value that is
not an object is rejected instead of being read as empty. A typo cannot merge
into nothing and read as active.

| Block | Specs | Keys and defaults |
|---|---|---|
| `context` | 1 | `compactAt 0.70`, `dropAt 0.85`, `spillAt 0.90`, `spillPath .dsh/fable-spill` |
| `effort` | 6, 11 | `defaultTier mid`, `escalateOn [search, multihop, ambiguity]`, `costCeiling 2000000` |
| `budget` | 14, 21, 22, 52, 72, 81, 96 | `maxReplans 2`, `maxPassRetries 2`, `passTimeoutMs 120000`, `stageTimeoutMs 600000`, `stageTokenBudget 400000`, `maxForkDepth 4`, `maxForksPerStage 8`, `maxMergesPerStage 8` |
| `reasoning` | 55, 58, 73, 75 | `maxConcurrentPasses 4`, `convergenceDelta 0.02`, `convergenceTurns 3`, `decayLambda 0.15`, `quorumThreshold 0.6` |
| `determinism` | 25 | `seed 20261011`, `iterationOrder stable`, `pinnedVersions { dsh: 23c78fcd... }` |
| `sandbox` | 26 | `allowList {}`, `escapeAction abort` |
| `hitl` | 27 | `requireOnIrreversible true`, `requireOnExternal true`, `requireAboveCost 500000` |
| `observability` | 24, 79 | `traceLevel stage`, `logFormat line` |
| `registry` | 100 | `policies []` |

Supply changes through the bundle patch entry (`cordis.patch.yml` `config:`
block) or a profile overlay.

## What enforces and what only reports

Most specs classify and report; they do not block. Know which is which before
you rely on one as a control.

| Enforces | How |
|---|---|
| `sandbox-boundaries` (26) | An escape is logged with verdict `discarded`; when `escapeAction: 'abort'`, the tool throws and the envelope becomes `ok:false` instead of a result that looks usable. An empty allow-list allows reads and denies writes. A declared list is exact-match. |
| `human-in-the-loop` (27) | Fails closed: an omitted `irreversible`, `external`, or `estimatedCost` still requests approval. It only runs when the model calls it. |
| Hook fault isolation | A fault in `agent/pre-step` or `llm/stream` is logged, then the step or stream continues. A plugin cannot veto a turn. |

| Reports only | Consequence |
|---|---|
| `context-management` (1) | The compact, drop, or spill action is classified and logged. No message list is truncated or spilled. |
| Effort escalation (6) | `effortTier` is raised and logged. No model parameter changes. |
| Backpressure (71) | Reported from a queue depth the caller supplies; not measured. |
| Tool cache | Idempotent replay covers pure computations. Tools marked `effectful` always re-execute. |

In short: do not use this bundle as a sandbox or an approval mechanism. It is a
ledger, a classifier, and a discipline helper. The controls that bind are dsh's
own permissions.

## Guarantees

- **Surface-verified integration.** Every hook and API this bundle touches was
  checked against the pinned dsh commit's source: `agent/pre-step` (waterfall,
  `PreStepDecision`), `tools/result` (emit), `llm/stream` (waterfall),
  `session/event` plus `session/created` and `session/disposed` (emit),
  `ctx.tools.register(definition)` returning a disposer. `RECON.md` holds the
  file and line evidence.
- **Uniform envelope.** Every tool returns
  `{ok, spec, output, verdict, unverified, rerun, gates}`. Rejected arguments
  come back as `ok:false`, not as an exception.
- **Fail-loud config** with field-path errors. The policy registry is immutable:
  a change is a new version, and a duplicate id plus version is an error.
- **Append-only pass lineage** with prune, GC, and audit protection. A pass that
  references an unknown parent is rejected.
- **Bounded state.** The worklog, gate log, cost ledger, reason cache, and
  snapshot store evict oldest-first. Per-stage cost totals survive eviction. The
  per-turn stage token budget resets on `turn/start`.
- **Encoding hygiene:** LF, UTF-8 without BOM, final newline on every text file.

## Testing

```sh
pnpm test        # unit + integration + e2e, node:test via tsx
pnpm typecheck   # tsc -b, then the test project
pnpm build       # emit lib/ (including lib/cli.js, the CLI entry point)
```

At commit `3b701d6`: 227 tests in 89 suites pass, and `pnpm typecheck` exits 0.
With the visualizer, budget advisor, and CLI added: 256 tests in 92 suites pass.
The integration and e2e suites load the bundle into a real Cordis host with the
real dsh services (`dsh-tools`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`)
and drive real event dispatches. `pnpm typecheck` covers `test/**` as well as
`src/**`.

## Known limits

- **State is per host, not per session.** One `ctx.fable51` serves every session
  in the host: worklog, ledger, cache, snapshots, lineage, and scalar counters
  are shared. A `turn/start` from one session clears the stage token budget
  another session was charging against, and per-stage fork and merge budgets
  reset for everyone at once. Isolating this needs session identity plumbed
  through `ToolRunContext` into the tools and hooks; it is not done here.
- **No CI and no lockfile.** `lib/` is gitignored, so the artifact a host runs is
  whatever was built locally. The same applies to the CLI: `bin/fable51.js` is a
  shim onto `lib/cli.js`, so it needs a `pnpm build` first.
- **The full agent-loop path was not executed in the authoring environment.**
  The scratch profile's API key was invalid, an environment blocker rather than
  bundle behavior. Hook semantics are covered by the suites driving the real
  event dispatchers.
- **Spec definitions 21 and 23 to 26** are operator-authored additions.
  `PRD_REVISI.md` section 11 records the cross-check against
  `sumber100specs.md`: 100 ids and names match. The "Kills" column in the older
  spec document is an operator annotation on top of the source rules.
- **Two specs have no implementation** (4 and 55). Config for 55 is validated but
  nothing enforces it.
- **Runtime imports** are `@deepseek-ai/cordis` (service and context),
  `@deepseek-ai/schemastery` (the `Config` schema), and `node:crypto`. The
  `dsh-llm`, `dsh-agent`, and `dsh-session` imports are type-only.
  `schemastery` resolves through the host's `dsh-tools` dependency and is not
  declared directly in this package's `peerDependencies`.

## Docs

| File | Role |
|---|---|
| `PRD.md` | As-built requirements, evidence, and open questions |
| `PLAYBOOK.md` | Operator guide: install, config, tool map, limits |
| `PRD_REVISI.md` | Pre-code specification v0.1.1 and the 100-spec mapping |
| `sumber100specs.md` | 100-spec inventory: id, core rule, trigger |
| `RECON.md` | File and line evidence for each dsh surface |
| `cordis.patch.yml` | Bundle patch entry |

## License

MIT. See `LICENSE`.
