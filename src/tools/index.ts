/**
 * Tool group registry (PRD §2/§6 Phase 4).
 *
 * Order matters: groups are registered in dependency order — context first,
 * governance last. Each group module is self-contained and owns its file;
 * this registry is the only wiring point.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolEnv, type ToolSpec } from './shared.ts'
import { DEFAULT_SESSION } from '../state/episode.ts'
import { contextTools } from './context.ts'
import { verificationTools } from './verification.ts'
import { dagTools } from './dag.ts'
import { costTools } from './cost.ts'
import { escalationTools } from './escalation.ts'
import { opsTools } from './ops.ts'
import { reasoningCoreTools } from './reasoning-core.ts'
import { reasoningFlowTools } from './reasoning-flow.ts'
import { reasoningOpsTools } from './reasoning-ops.ts'
import { governanceTools } from './governance.ts'
import { visualizeTools } from './visualize.ts'
import { budgetAdvisorTools } from './budget-advisor.ts'

const GROUPS: ReadonlyArray<() => ToolSpec[]> = [
  contextTools,
  verificationTools,
  dagTools,
  costTools,
  escalationTools,
  opsTools,
  reasoningCoreTools,
  reasoningFlowTools,
  reasoningOpsTools,
  governanceTools,
  visualizeTools,
  budgetAdvisorTools,
]

export function allToolSpecs(): ToolSpec[] {
  return GROUPS.flatMap((group) => group())
}

export function registerTools(ctx: Context): number {
  // The registration env carries only the service; the session key is
  // resolved per call from the execution the host hands the tool.
  const env: ToolEnv = { service: ctx.fable51, sessionKey: DEFAULT_SESSION }
  let count = 0
  for (const spec of allToolSpecs()) {
    ctx.tools.register(defineTool(spec, env))
    count += 1
  }
  return count
}
