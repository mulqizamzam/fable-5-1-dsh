# fable-5-1-dsh

Fable-5.1 reasoning-orchestration bundle for DeepSeek Harness (`dsh`). One bundle
implements all 100 fable-5-1 specs through three dsh primitives: a policy service,
four event hooks, and namespaced tools. No spec is implemented as a stub.

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

The bundle fails loudly: an invalid config throws with the exact field path
(no silent defaults, no silent fallback). Configuration is supplied via the
bundle patch entry (`cordis.patch.yml` `config:` block) or the profile overlay.

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

## Guarantees

- **Surface-verified integration.** Every hook and API this bundle touches was
  verified against the pinned dsh commit's source: `agent/pre-step` (waterfall,
  `PreStepDecision`), `tools/result` (emit), `llm/stream` (waterfall),
  `session/event` + `session/created`/`session/disposed` (emit),
  `ctx.tools.register(definition)` → disposer. See `RECON.md` for file:line evidence.
- **Typed, idempotent tools.** Every tool returns the standard envelope
  (`{ok, spec, output, verdict, unverified, rerun, gates}`) and replays its
  cached output for identical input hashes.
- **Fail-loud config** with field-path errors; **immutable policy registry**
  (change = new version); **append-only pass lineage** with GC and audit keep.
- **Encoding hygiene**: LF, UTF-8 no BOM, final newline everywhere.

## Testing

```sh
pnpm test              # unit + integration + e2e (node:test via tsx)
pnpm typecheck         # tsc -b
pnpm build             # emit lib/
```

The integration and e2e suites load the bundle into a real Cordis host with the
real dsh services (`dsh-tools`, `dsh-llm`, `dsh-session`, `dsh-system-prompt`) —
the tool registry validates every registration, so a bad schema fails the test,
not production.

## Known limits

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
