# RECON — Phase 0 artifact

Date: 2026-10-11. Scope: fable-5-1 / dsh port. All facts below were read from the
pinned checkout, not from memory.

## Pin (§0.1–0.3)

| Item | Value | Evidence |
|---|---|---|
| dsh commit | `23c78fcdd5ee0b497a77ca356608c51093c74bb9` | `git -C /home/administrator/deepseek-harness rev-parse HEAD` |
| dsh version | `0.2.0-rc.2` | package.json `version` |
| pnpm | `11.7.0` | package.json `packageManager`; local `pnpm --version` = 11.7.0 |
| node | `v24.19.0` (engines `^22.19.0 \|\| >=24.0.0` satisfied) | local `node --version`; package.json `engines` |
| dsh CLI | installed globally, `0.2.0-rc.2` | `which dsh`, `dsh --version` |
| checkout node_modules | present (1.9G); `tsx`, `tsc`, `vitest` binaries available | filesystem |

## Verified integration surfaces (§0.5)

| PRD claim (v0.1.1) | Reality at pin | Evidence |
|---|---|---|
| `agent/pre-step` | exists. Waterfall; payload `{ agent, messages, turn, step, signal }`; listener returns `PreStepDecision`, may reject/steer, must call `next()` | `packages/core/agent-loop/src/agent.ts:277`; `packages/core/agent/src/runtime-types.ts:320`; events declared `runtime-types.ts:246` (`interface Events`) |
| `tools/result` | exists. Emit-mode `(exec, result)`; observers cannot rewrite the result | `packages/core/tools/src/index.ts:198` |
| `llm/stream` | exists. Waterfall `(options, next)` over token stream | `packages/llm/llm/src/index.ts:75` |
| `session/event` | exists. Emit-mode `(session, event)`; `event.type` is a durable type | `packages/core/session/src/index.ts:77` |
| `session/created` / `session/disposed` | exist (lifecycle) | `packages/core/session/src/index.ts:405` |
| `agent/step`, `session/boundary` | DO NOT EXIST (0 matches repo-wide) | grep over full checkout |
| Service + inject/provide | exists. `class X extends Service { constructor(ctx) { super(ctx, 'name') } }`; `declare module '@deepseek-ai/cordis' { interface Context { x: X } }`; missing inject = plugin waits instead of running | `vendor/cordis/lib/types/service.d.ts:38`; `docs/user/develop/framework/service.md:9-32`; reference impl `packages/spill/spill/src/index.ts:45` |
| service names | built-ins: `tools`, `llm`, `agents`; session service registered as `'sessions'` (`ctx.sessions`) | service.md:9-15; `packages/core/session/src/index.ts:953` |
| `ctx.tools.register` | `register(definition: ToolDefinition): () => void` — one object, returns disposer; throws on missing `output.render`; name `run_code` reserved | `packages/core/tools/src/index.ts:1063-1088` |
| ToolDefinition | extends `ToolSchema { deferLoading?, name, description, parameters }` + mandatory `output { schema, render, presentationMeta? }` + `execute(args, exec: ToolRunContext)` | tools/src/index.ts:223; `packages/llm/llm/src/types.ts:473`; ToolRunContext at tools/src/index.ts:418 |
| bundle manifest | `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` | `packages/experimental/inspector/package.json:37-39` |
| patch file schema | YAML entry-list: `- insert: [{ id, name }]` | `packages/experimental/inspector/cordis.patch.yml`; `dsh --profile web --dump-config-schema` |
| peerDeps convention | in-repo: `workspace:~` (inspector:59); external host: `github:deepseek-ai/deepseek-harness#<commit>` | inspector package.json |

## Non-existent paths (do not use)

`packages/cordis`, `packages/dsh-tools`, `docs/architecture`, `docs/development` (glob-verified absent). Real locations: `vendor/cordis`, `packages/core/tools`, `docs/user/develop/framework/`, `docs/subsystems/`.

## Dependency resolution for this bundle

`@deepseek-ai/cordis` → `/home/administrator/deepseek-harness/vendor/cordis` (lib built; deps cosmokit/cordis-plugin-* in its own node_modules).
`@deepseek-ai/dsh-tools` → `/home/administrator/deepseek-harness/packages/core/tools` (lib built; full peer graph in its node_modules).
Type-only host types additionally consumed: `@deepseek-ai/dsh-llm` (ToolSchema), `@deepseek-ai/dsh-agent` (agent Events), `@deepseek-ai/dsh-session` (SessionEvent). Runtime imports: cordis only.

## Known gap carried into implementation

PreStepDecision/SessionEvent/etc. types come from host packages the PRD's §3.5 peerDep list did not name. Resolution: type-only imports; peerDep list extended and recorded in §11 of the PRD at package time.

## Gate execution plan

- Gate 1: bundle loads in a real Cordis app (from checkout) AND composes in a real dsh profile (`dsh --profile <p> --dump-config`) — activation observed, no PENDING.
- Gate 2: config validation unit tests (bad config throws with field path).
- Gate 3: all four hooks fire in a synthetic session driven through the real Cordis ctx.
- Gates 4a–4o: per tool group — registration contract + invocation + idempotency rerun hash equality.
- Gate 5: state survives simulated session boundary; replay hash equality.
- Gate 6: e2e synthetic session exercise.
- Gate 7: encoding + fresh-install composition re-check.
