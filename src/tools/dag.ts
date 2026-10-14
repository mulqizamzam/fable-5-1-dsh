/**
 * DAG tools — specs 17, 34, 50, 93 (Gate 4c).
 *
 * A stage graph and a reasoning-pass graph are DAGs, never linear lists: the
 * stage graph is topologically sorted and a cycle is reported in place of an
 * order (17), a reasoning pass is recorded with its dependency edges (34), a
 * cycle in the wait-for graph is a deadlock (50), and edges inferred from
 * shared facts are reported apart from the declared ones (93).
 */
import type { ToolSpec } from './shared.ts'
import { fingerprint } from '../state/cache.ts'
import type { PassVerdict, ReasoningPass } from '../types/pass.ts'

/** [from, to] pair: `from` depends on `to`. */
type Edge = readonly [string, string]

interface Graph {
  readonly nodes: readonly string[]
  readonly adjacency: Map<string, string[]>
}

function parseStringList(raw: unknown, label: string): string[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array of strings`)
  return raw.map((entry: unknown, index: number) => {
    if (typeof entry !== 'string') throw new Error(`${label}[${index}] must be a string`)
    return entry
  })
}

function parseEdges(raw: unknown, label: string): Edge[] {
  if (!Array.isArray(raw)) throw new Error(`${label} must be an array of [from, to] pairs`)
  return raw.map((entry: unknown, index: number) => {
    if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`${label}[${index}] must be a [from, to] pair`)
    const from: unknown = entry[0]
    const to: unknown = entry[1]
    if (typeof from !== 'string' || typeof to !== 'string') throw new Error(`${label}[${index}] must pair two strings`)
    return [from, to] as Edge
  })
}

function edgeKey(edge: Edge): string {
  return `${edge[0]}\u0000${edge[1]}`
}

/** Node set of an edge list, in first-encounter order across every edge. */
function nodesOf(edges: readonly Edge[]): string[] {
  const nodes: string[] = []
  const seen = new Set<string>()
  for (const edge of edges) {
    for (const node of edge) {
      if (seen.has(node)) continue
      seen.add(node)
      nodes.push(node)
    }
  }
  return nodes
}

function graphOf(nodes: readonly string[], edges: readonly Edge[]): Graph {
  const declared = new Set(nodes)
  // A repeated id is not a second stage: it made the topological order list the
  // same stage twice, and a consumer walking the order would run it twice.
  if (declared.size !== nodes.length) throw new Error(`stage graph repeats a node id: ${nodes.join(', ')}`)
  const adjacency = new Map<string, string[]>()
  for (const node of nodes) adjacency.set(node, [])
  for (const edge of edges) {
    for (const endpoint of edge) {
      if (!declared.has(endpoint)) throw new Error(`edge ${edge[0]} -> ${edge[1]} references undeclared node ${endpoint}`)
    }
    adjacency.get(edge[0])?.push(edge[1])
  }
  return { nodes, adjacency }
}

/** One cycle as a closed walk: the entry id repeats at the end. */
function findCycle(graph: Graph): string[] {
  const onPath = new Set<string>()
  const done = new Set<string>()
  const path: string[] = []
  for (const start of graph.nodes) {
    if (done.has(start)) continue
    const stack: Array<{ node: string; next: number }> = [{ node: start, next: 0 }]
    onPath.add(start)
    path.push(start)
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const neighbors = graph.adjacency.get(frame.node) ?? []
      if (frame.next >= neighbors.length) {
        onPath.delete(frame.node)
        done.add(frame.node)
        stack.pop()
        path.pop()
        continue
      }
      const neighbor = neighbors[frame.next]!
      frame.next += 1
      if (onPath.has(neighbor)) {
        const at = path.indexOf(neighbor)
        return [...path.slice(at), neighbor]
      }
      if (done.has(neighbor)) continue
      onPath.add(neighbor)
      path.push(neighbor)
      stack.push({ node: neighbor, next: 0 })
    }
  }
  return []
}

/** Kahn topological sort; an unsortable graph comes back with its cycle. */
function topoSort(graph: Graph): { order: string[]; cycle: string[] } {
  const indegree = new Map<string, number>()
  for (const node of graph.nodes) indegree.set(node, 0)
  for (const node of graph.nodes) {
    for (const next of graph.adjacency.get(node) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) + 1)
    }
  }
  const queue = graph.nodes.filter(node => indegree.get(node) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    order.push(node)
    for (const next of graph.adjacency.get(node) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1
      indegree.set(next, left)
      if (left === 0) queue.push(next)
    }
  }
  if (order.length === graph.nodes.length) return { order, cycle: [] }
  return { order: [], cycle: findCycle(graph) }
}

export function dagTools(): ToolSpec[] {
  return [
    {
      spec: '17',
      name: 'stage-graph-dag',
      description: 'Kahn topological sort of a stage graph; a cyclic graph is a hard fail — order comes back null with the offending cycle path (spec 17).',
      parameters: {
        type: 'object',
        required: ['nodes', 'edges'],
        properties: {
          nodes: { type: 'array', items: { type: 'string' }, description: 'stage ids of the stage graph' },
          edges: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: '[from, to] pairs where from is a prerequisite of to',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['order', 'cycle'],
        properties: {
          order: {
            oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
            description: 'topological order, or null when the graph is cyclic',
          },
          cycle: { type: 'array', items: { type: 'string' }, description: 'closed cycle walk, empty for an acyclic graph' },
        },
      },
      execute(args) {
        const { nodes, edges } = args as { nodes: unknown; edges: unknown }
        const graph = graphOf(parseStringList(nodes, 'nodes'), parseEdges(edges, 'edges'))
        const sorted = topoSort(graph)
        return {
          order: sorted.order.length === 0 && sorted.cycle.length > 0 ? null : sorted.order,
          cycle: sorted.cycle,
        }
      },
    },
    {
      spec: '34',
      effectful: true,
      name: 'reasoning-dag',
      description: 'Record a reasoning pass with its dependency edges into the pass lineage and report its ancestor chain (spec 34).',
      parameters: {
        type: 'object',
        required: ['passId', 'deps'],
        properties: {
          passId: { type: 'string', description: 'identity of the pass being recorded' },
          deps: {
            type: 'array',
            items: { type: 'string' },
            description: 'pass ids this pass depends on; the first dependency becomes the lineage parent',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['recorded', 'ancestors'],
        properties: {
          recorded: { type: 'boolean', enum: [true] },
          ancestors: { type: 'array', items: { type: 'string' }, description: 'ancestor ids, nearest first' },
        },
      },
      execute(args, env) {
        const { passId, deps } = args as { passId: unknown; deps: unknown }
        const { service } = env
        if (typeof passId !== 'string' || passId.length === 0) throw new Error('passId must be a non-empty string')
        if (service.lineage.get(passId) !== undefined) {
          throw new Error(`pass ${passId} is already recorded — lineage is append-only`)
        }
        const unique = [...new Set(parseStringList(deps, 'deps'))]
        const unknown = unique.filter(dep => service.lineage.get(dep) === undefined)
        if (unknown.length > 0) throw new Error(`pass ${passId} depends on unrecorded passes: ${unknown.join(', ')}`)
        const verdict: PassVerdict = 'contributed'
        // Every dep is an edge on the pass; the lineage tree models one parent,
        // so the first dep carries the parent->child edge.
        const pass: ReasoningPass = {
          id: passId,
          spec: '34',
          parentId: unique[0] ?? null,
          inHash: fingerprint({ passId, deps: unique }),
          outHash: fingerprint({ passId, deps: unique, verdict }),
          deps: unique,
          verdict,
          // No evidence arguments exist for this call, so the pass carries the
          // neutral contributed baseline of the weighted score (spec 89).
          score: service.score({ evidence: 1, coherence: 1, coverage: 1, contradiction: 0 }),
          startedAt: 0,
          endedAt: 0,
          tokens: 0,
          latencyMs: 0,
          unverified: [],
        }
        service.recordPass(pass)
        // Spec 15: label the pass's reasoning mode by its dependency shape —
        // a join of several branches is parallel, a single link is sequential.
        service.labelPass(passId, unique.length > 1 ? 'parallel' : 'sequential')
        return { recorded: true, ancestors: service.lineage.ancestors(passId) }
      },
    },
    {
      spec: '50',
      name: 'deadlock-detection',
      description: 'Detect mutual wait in a pass dependency graph: a cycle in the wait-for graph is a deadlock (spec 50).',
      parameters: {
        type: 'object',
        required: ['waits'],
        properties: {
          waits: {
            type: 'array',
            items: { type: 'array', items: { type: 'string' } },
            description: '[waiter, waiting-for] pairs',
          },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['deadlock', 'cycle'],
        properties: {
          deadlock: { type: 'boolean' },
          cycle: { type: 'array', items: { type: 'string' }, description: 'closed wait-for cycle walk, empty when no deadlock' },
        },
      },
      execute(args) {
        const { waits } = args as { waits: unknown }
        const edges = parseEdges(waits, 'waits')
        const { cycle } = topoSort(graphOf(nodesOf(edges), edges))
        return { deadlock: cycle.length > 0, cycle }
      },
    },
    {
      spec: '93',
      name: 'pass-dependency-inference',
      description: 'Infer pass dependency edges from shared facts and report them apart from the declared edges; edges are compared by direction (spec 93).',
      parameters: {
        type: 'object',
        required: ['declaredEdges', 'sharedFacts'],
        properties: {
          declaredEdges: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'declared [dependent, dependency] pairs' },
          sharedFacts: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: '[dependent, dependency] pairs implied by a shared fact' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['inferred', 'declared'],
        properties: {
          inferred: { type: 'array', items: { type: 'array', items: { type: 'string' } }, description: 'shared-fact edges that are not declared' },
          declared: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        },
      },
      execute(args) {
        const { declaredEdges, sharedFacts } = args as { declaredEdges: unknown; sharedFacts: unknown }
        const declared = parseEdges(declaredEdges, 'declaredEdges')
        const shared = parseEdges(sharedFacts, 'sharedFacts')
        const declaredKeys = new Set(declared.map(edgeKey))
        const inferred: Edge[] = []
        const seen = new Set<string>()
        for (const edge of shared) {
          const key = edgeKey(edge)
          if (declaredKeys.has(key) || seen.has(key)) continue
          seen.add(key)
          inferred.push(edge)
        }
        return { inferred, declared }
      },
    },
  ]
}
