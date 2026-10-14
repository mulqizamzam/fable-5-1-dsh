# fable-5-1-dsh

Fable-5.1 reasoning-orchestration bundle for DeepSeek Harness (`dsh`). One bundle
implements all 100 fable-5-1 specs through three dsh primitives: a policy service,
four event hooks, and namespaced tools.

- 90 of the 100 specs are reachable through the `fable51.*` tool surface (one tool
  per spec id); the other 10 exist as service methods driven by the hooks. Two spec
  ids — `progress-reporting` (4) and `reasoning-bandwidth` (55) — have no
  implementation in this bundle.
- Read [What enforces and what only reports](#what-enforces-and-what-only-reports)
  before relying on a spec as a control: several are classifiers, not gates.

- Target dsh: developer preview, pinned at commit `23c78fcdd5ee0b497a77ca356608c51093c74bb9` (v0.2.0-rc.2)
- Runtime: Cordis, TypeScript, ESM only
- License: MIT
- Source of truth for the spec mapping: `PRD_REVISI.md`; the 100-spec source inventory: `sumber100specs.md`

## Install

Development, into a scratch profile (pattern proven by other local plugins in
this workspace — a `link:` dependency plus a `dsh.profile.bundles` entry):

```json
// <profile>/package.json
{
  "dependencies": { "fable-5-1-dsh": "link:/path/to/fable-5-1-dsh" },
  "dsh": { "profile": { "bundles": ["...", "fable-5-1-dsh"] } }
}
```

```sh
pnpm install                       # in the profile directory
dsh --profile <name> --dump-config # verify the bundle composes (entry id: fable-5-1)
```

For an external host install, the peer dependencies resolve from the host tree.
Registry publish is optional; `file:`/`link:` is the supported dev path.

## Activate

The bundle is a class plugin: `lib/index.js` default-exports `Fable51Policy`,
which registers as `ctx.fable51` and wires everything at construction.
Activation is observable — the service logs `fable-5-1 loaded — N tools
registered` and the tools appear in `ctx.tools.schemas()` under the `fable51.*`
namespace. If a required service (`tools`, `llm`, `sessions`) is absent, the
plugin waits instead of running — dsh's documented silent-pending behavior —
so activation must be verified, never assumed.

## Config

The bundle fails loudly: a malformed config — a non-object `config:`, an unknown
key at any level, a wrong value type, unordered context thresholds — throws at load
with the exact field path. There are no silent defaults and no silent fallback: a
key you typo is rejected, not dropped. Configuration is supplied via the bundle
patch entry (`cordis.patch.yml` `config:` block) or the profile overlay. A profile
that was silently running on defaults will now refuse to start.

| Block | Specs | Keys |
|---|---|---|
| `context` | 1 | `compactAt` 0.70, `dropAt` 0.85, `spillAt` 0.90, `spillPath` |
| `effort` | 6, 11 | `defaultTier`, `escalateOn[]`, `costCeiling` |
| `budget` | 14, 21, 22, 52, 72, 81, 96 | `maxReplans`, `maxPassRetries`, `passTimeoutMs`, `stageTimeoutMs`, `stageTokenBudget`, `maxForkDepth`, `maxForksPerStage`, `maxMergesPerStage` |
| `reasoning` | 55, 58, 73, 75 | `maxConcurrentPasses`, `convergenceDelta`, `convergenceTurns`, `decayLambda`, `quorumThreshold` |
| `determinism` | 25 | `seed`, `iterationOrder`, `pinnedVersions` |
| `sandbox` | 26 | `allowList`, `escapeAction` |
| `hitl` | 27 | `requireOnIrreversible`, `requireOnExternal`, `requireAboveCost` |
| `observability` | 24, 79 | `traceLevel`, `logFormat` |
| `registry` | 100 | `policies[]` (id/version/owner/active/hash) |

## What enforces and what only reports

Most specs here classify and report; they do not block. Know which is which before
you rely on one as a control.

| Enforces | How |
|---|---|
| `sandbox-boundaries` (26) | An escape is logged and, when `escapeAction: 'abort'`, the call returns `ok:false` instead of a result that looks usable |
| `human-in-the-loop` (27) | Fails closed — an omitted `irreversible`/`external`/`estimatedCost` requests approval. Still only reachable if the model calls it |
| Hook fault isolation | A fault in `agent/pre-step` or `llm/stream` is logged and the step/stream continues; a plugin can no longer veto a turn |

| Reports only | Consequence |
|---|---|
| `context-management` (1) | The compact/drop/spill action is classified and logged; nothing truncates or spills a message list |
| Effort escalation (6) | `effortTier` is advanced and logged; no model parameter is changed |
| Backpressure (71) | Reported from a caller-supplied queue depth |
| Tool cache | Idempotent replay applies to pure computations; tools marked `effectful` always re-execute |

## Guarantees

- **Surface-verified integration.** Every hook and API this bundle touches was
  verified against the pinned dsh commit's source: `agent/pre-step` (waterfall,
  `PreStepDecision`), `tools/result` (emit), `llm/stream` (waterfall),
  `session/event` + `session/created`/`session/disposed` (emit),
  `ctx.tools.register(definition)` → disposer. See `RECON.md` for file:line evidence.
- **Uniform result envelope.** Every tool returns
  `{ok, spec, output, verdict, unverified, rerun, gates}`. `ok` is `false` for a
  rejected argument instead of throwing out of the call. `verdict`/`unverified`
  follow the tool's own reported status — a tool that says it could not verify
  does not come back as `verified`.
- **Fail-loud config** with field-path errors; **immutable policy registry**
  (change = new version); **append-only pass lineage** with GC and audit keep.
- **Bounded state.** The worklog, gate log, cost ledger, reason cache and snapshot
  store evict oldest-first; the per-turn stage token budget resets on `turn/start`.
- **Encoding hygiene**: LF, UTF-8 no BOM, final newline everywhere.

## Testing

```sh
pnpm test              # unit + integration + e2e (node:test via tsx)
pnpm typecheck         # tsc -b, then the test project
pnpm build             # emit lib/
```

The integration and e2e suites load the bundle into a real Cordis host with the
real dsh services (`dsh-tools`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`) and
drive real event dispatches. The registry checks that a tool declares an `output`
block and that the returned value matches the declared output schema — it does NOT
validate input arguments, so a bad schema is caught at return time, not at
registration time. `pnpm typecheck` covers `test/**` as well as `src/**`.

## Known limits

- **State is per-host, not per-session.** One `ctx.fable51` instance serves every
  session in the host: the worklog, ledger, cache, snapshots, lineage and the
  scalar counters are shared. A `turn/start` from one session clears the stage
  token budget another session was still charging against, and per-stage fork and
  merge budgets reset for everyone at once. Isolating this needs session identity
  plumbed through `ToolRunContext` into the tools and hooks; it is not done here.
- **No CI and no lockfile.** `lib/` is gitignored, so the artifact a host runs is
  whatever was built locally.
- The full agent-loop path (LLM streaming through the bundle's hooks) was not
  executed in the authoring environment: the scratch profile's API key is
  invalid (environment blocker, not bundle behavior). Hook semantics are covered
  by the e2e suite driving the real event dispatchers.
- The spec 21/23–26 definitions are operator-authored additions cross-checked
  against `sumber100specs.md` (100/100 id+name match, verified). The PRD's
  "Kills" column is an operator-layer annotation on top of the source core
  rules.
- Peer dependencies are type-only for the `dsh-llm`/`dsh-agent`/`dsh-session`
  packages; runtime imports are `@deepseek-ai/cordis` only.
