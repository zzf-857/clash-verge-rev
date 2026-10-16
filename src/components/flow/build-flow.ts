type FlowColumn = 'app' | 'group' | 'node'

export interface FlowNode {
  id: string
  column: FlowColumn
  label: string
  /** Executable of an app, for its icon */
  exe?: string
  /** Process name of an app, for its icon when the path is unknown */
  processName?: string
  /** Bytes moved by its live connections, sizes the node */
  traffic: number
  up: number
  down: number
  connections: number
  /** Ids folded into an "others" node */
  folded?: number
}

export interface FlowLink {
  id: string
  source: string
  target: string
  traffic: number
  rate: number
}

export interface FlowGraph {
  nodes: FlowNode[]
  links: FlowLink[]
  /** app id -> group id -> node id, for highlighting whole paths */
  paths: [string, string, string][]
}

export const OTHER_APPS = 'app:*'
export const OTHER_NODES = 'node:*'
export const UNKNOWN_APP = 'app:?'

const MAX_APPS = 10
const MAX_NODES = 10

const appOf = (conn: IConnectionsItem) => {
  const { process, processPath } = conn.metadata
  if (!process && !processPath) return { id: UNKNOWN_APP, label: '' }
  return {
    id: `app:${processPath || process}`,
    label: process || processPath?.split(/[\\/]/).pop() || '',
    exe: processPath || undefined,
    processName: process || undefined,
  }
}

const emptyNode = (
  id: string,
  column: FlowColumn,
  label: string,
): FlowNode => ({
  id,
  column,
  label,
  traffic: 0,
  up: 0,
  down: 0,
  connections: 0,
})

/**
 * Folds live connections into app -> policy group -> exit node columns. The group is the
 * policy the rule picked (last in `chains`), the node is where the traffic actually leaves
 * (first in `chains`); groups nested in between are skipped.
 */
export const buildFlow = (connections: readonly IConnectionsItem[]) => {
  const nodes = new Map<string, FlowNode>()
  const triples = new Map<string, { traffic: number; rate: number }>()

  const add = (node: FlowNode, conn: IConnectionsItem) => {
    const existing = nodes.get(node.id) ?? node
    existing.traffic += conn.upload + conn.download
    existing.up += conn.curUpload ?? 0
    existing.down += conn.curDownload ?? 0
    existing.connections += 1
    nodes.set(existing.id, existing)
  }

  const appTraffic = new Map<string, number>()
  const nodeTraffic = new Map<string, number>()
  for (const conn of connections) {
    const app = appOf(conn).id
    const node = `node:${conn.chains[0] ?? 'DIRECT'}`
    const traffic = conn.upload + conn.download
    appTraffic.set(app, (appTraffic.get(app) ?? 0) + traffic)
    nodeTraffic.set(node, (nodeTraffic.get(node) ?? 0) + traffic)
  }
  const top = (traffic: Map<string, number>, max: number) =>
    new Set(
      [...traffic]
        .sort((a, b) => b[1] - a[1])
        .slice(0, max)
        .map(([id]) => id),
    )
  const keptApps = top(appTraffic, MAX_APPS)
  const keptNodes = top(nodeTraffic, MAX_NODES)

  for (const conn of connections) {
    const app = appOf(conn)
    const appId = keptApps.has(app.id) ? app.id : OTHER_APPS
    const groupName = conn.chains.at(-1) ?? 'DIRECT'
    const nodeName = conn.chains[0] ?? 'DIRECT'
    const groupId = `group:${groupName}`
    const nodeId = keptNodes.has(`node:${nodeName}`)
      ? `node:${nodeName}`
      : OTHER_NODES

    add(
      appId === app.id
        ? {
            ...emptyNode(app.id, 'app', app.label),
            exe: app.exe,
            processName: app.processName,
          }
        : emptyNode(OTHER_APPS, 'app', ''),
      conn,
    )
    add(emptyNode(groupId, 'group', groupName), conn)
    add(emptyNode(nodeId, 'node', nodeId === OTHER_NODES ? '' : nodeName), conn)

    const key = JSON.stringify([appId, groupId, nodeId])
    const triple = triples.get(key) ?? { traffic: 0, rate: 0 }
    triple.traffic += conn.upload + conn.download
    triple.rate += (conn.curUpload ?? 0) + (conn.curDownload ?? 0)
    triples.set(key, triple)
  }

  const folded = (ids: Set<string>, all: Map<string, number>) =>
    [...all.keys()].filter((id) => !ids.has(id)).length
  const others = nodes.get(OTHER_APPS)
  if (others) others.folded = folded(keptApps, appTraffic)
  const otherNodes = nodes.get(OTHER_NODES)
  if (otherNodes) otherNodes.folded = folded(keptNodes, nodeTraffic)

  const links = new Map<string, FlowLink>()
  const paths: [string, string, string][] = []
  for (const [key, { traffic, rate }] of triples) {
    const [app, group, node] = JSON.parse(key) as [string, string, string]
    paths.push([app, group, node])
    for (const [source, target] of [
      [app, group],
      [group, node],
    ]) {
      const id = `${source}->${target}`
      const link = links.get(id) ?? { id, source, target, traffic: 0, rate: 0 }
      link.traffic += traffic
      link.rate += rate
      links.set(id, link)
    }
  }

  return {
    nodes: [...nodes.values()],
    links: [...links.values()],
    paths,
  } satisfies FlowGraph
}
