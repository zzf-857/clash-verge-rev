import { HubRounded, MoreHorizRounded } from '@mui/icons-material'
import { Box, Typography, alpha, useTheme } from '@mui/material'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ProcessAvatar } from '@/components/process-route/process-avatar'
import {
  avatarColor,
  displayName,
  routePolicy,
} from '@/components/process-route/process-utils'
import { useVerge } from '@/hooks/use-verge'
import { useProxiesData } from '@/providers/app-data-context'
import parseTraffic from '@/utils/parse-traffic'

import {
  type FlowGraph as Graph,
  type FlowLink,
  type FlowNode,
  OTHER_APPS,
  OTHER_NODES,
  UNKNOWN_APP,
} from './build-flow'

const WIDTHS = { app: 196, group: 188, node: 232 } as const
const MIN_HEIGHT = 44
const GAP = 10
const PAD = 12
const MAX_STROKE = 16

const formatSpeed = (value: number) => `${parseTraffic(value).join(' ')}/s`

const policyColor = (
  name: string,
  routeColors: Map<string, string>,
): string => {
  if (name === 'DIRECT') return '#94a3b8'
  if (name === 'REJECT' || name === 'REJECT-DROP') return '#ef4444'
  return routeColors.get(name) ?? avatarColor(name)
}

interface Box2 {
  x: number
  y: number
  w: number
  h: number
}

interface Layout {
  boxes: Map<string, Box2>
  strokes: Map<string, { width: number; y1: number; y2: number }>
  height: number
}

const layout = (graph: Graph, width: number, minHeight: number): Layout => {
  const maxTraffic = Math.max(1, ...graph.links.map((link) => link.traffic))
  const stroke = (link: FlowLink) =>
    2 + (MAX_STROKE - 2) * Math.sqrt(link.traffic / maxTraffic)

  const groupOrder = graph.nodes
    .filter((node) => node.column === 'group')
    .sort((a, b) => b.traffic - a.traffic)
    .map((node) => node.id)
  const rank = new Map(groupOrder.map((id, index) => [id, index]))
  // Apps and nodes sit next to the group they use most, which keeps lines from crossing.
  const heaviestGroup = (id: string) => {
    let best: FlowLink | undefined
    for (const link of graph.links) {
      if (
        (link.source === id || link.target === id) &&
        (!best || link.traffic > best.traffic)
      ) {
        best = link
      }
    }
    const group = best && (best.source === id ? best.target : best.source)
    return group ? (rank.get(group) ?? 0) : 0
  }
  const sortColumn = (column: FlowNode['column']) =>
    graph.nodes
      .filter((node) => node.column === column)
      .sort((a, b) => {
        if (column === 'group') return b.traffic - a.traffic
        const folded = Number(!!a.folded) - Number(!!b.folded)
        if (folded) return folded
        return (
          heaviestGroup(a.id) - heaviestGroup(b.id) || b.traffic - a.traffic
        )
      })
  const columns = {
    app: sortColumn('app'),
    group: sortColumn('group'),
    node: sortColumn('node'),
  }

  const side = (id: string, key: 'source' | 'target') =>
    graph.links
      .filter((link) => link[key] === id)
      .reduce((sum, link) => sum + stroke(link), 0)
  const heights = new Map(
    graph.nodes.map((node) => [
      node.id,
      Math.max(
        MIN_HEIGHT,
        Math.max(side(node.id, 'source'), side(node.id, 'target')) + 12,
      ),
    ]),
  )
  const columnHeight = (nodes: FlowNode[]) =>
    nodes.reduce((sum, node) => sum + heights.get(node.id)!, 0) +
    GAP * Math.max(0, nodes.length - 1)
  const height = Math.max(
    minHeight,
    ...Object.values(columns).map((nodes) => columnHeight(nodes) + PAD * 2),
  )

  const x = {
    app: 0,
    group: (width - WIDTHS.group) / 2,
    node: width - WIDTHS.node,
  }
  const boxes = new Map<string, Box2>()
  for (const [column, nodes] of Object.entries(columns) as [
    FlowNode['column'],
    FlowNode[],
  ][]) {
    let y = (height - columnHeight(nodes)) / 2
    for (const node of nodes) {
      const h = heights.get(node.id)!
      boxes.set(node.id, { x: x[column], y, w: WIDTHS[column], h })
      y += h + GAP
    }
  }

  // Stack each node's links along its edge, ordered by where their other end sits.
  const strokes = new Map<string, { width: number; y1: number; y2: number }>()
  const center = (id: string) => {
    const box = boxes.get(id)!
    return box.y + box.h / 2
  }
  for (const link of graph.links) {
    strokes.set(link.id, { width: stroke(link), y1: 0, y2: 0 })
  }
  for (const node of graph.nodes) {
    for (const [key, end, other] of [
      ['source', 'y1', 'target'],
      ['target', 'y2', 'source'],
    ] as const) {
      const attached = graph.links
        .filter((link) => link[key] === node.id)
        .sort((a, b) => center(a[other]) - center(b[other]))
      const total = attached.reduce((sum, link) => sum + stroke(link), 0)
      let y = center(node.id) - total / 2
      for (const link of attached) {
        const entry = strokes.get(link.id)!
        entry[end] = y + entry.width / 2
        y += entry.width
      }
    }
  }

  return { boxes, strokes, height }
}

interface Props {
  graph: Graph
}

export const FlowGraph = ({ graph }: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const { verge } = useVerge()
  const { proxyView } = useProxiesData()
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [hovered, setHovered] = useState<string | null>(null)

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const routeColors = useMemo(
    () =>
      new Map(
        (verge?.process_route_groups ?? [])
          .filter((group) => group.color)
          .map((group) => [routePolicy(group), group.color!]),
      ),
    [verge?.process_route_groups],
  )
  const delays = useMemo(() => {
    const map = new Map<string, number>()
    for (const record of Object.values(proxyView?.records ?? {})) {
      const last = record.history.at(-1)
      if (last) map.set(record.name, last.delay)
    }
    return map
  }, [proxyView?.records])

  const width = Math.max(size.width, 640)
  const { boxes, strokes, height } = useMemo(
    () => layout(graph, width, size.height),
    [graph, width, size.height],
  )

  const groupOf = (id: string) =>
    id.startsWith('group:') ? id.slice(6) : undefined
  const linkColor = (link: FlowLink) =>
    policyColor(groupOf(link.target) ?? groupOf(link.source) ?? '', routeColors)

  const lit = useMemo(() => {
    if (!hovered) return null
    const nodes = new Set<string>()
    const links = new Set<string>()
    for (const [app, group, node] of graph.paths) {
      if (hovered !== app && hovered !== group && hovered !== node) continue
      nodes.add(app).add(group).add(node)
      links.add(`${app}->${group}`).add(`${group}->${node}`)
    }
    return { nodes, links }
  }, [graph.paths, hovered])

  const nodeLabel = (node: FlowNode) => {
    if (node.id === OTHER_APPS)
      return t('home.flow.otherApps', { count: node.folded ?? 0 })
    if (node.id === OTHER_NODES)
      return t('home.flow.otherNodes', { count: node.folded ?? 0 })
    if (node.id === UNKNOWN_APP) return t('home.flow.unknownApp')
    if (node.column === 'node' && node.label === 'DIRECT')
      return t('home.flow.direct')
    return node.column === 'app' ? displayName(node.label) : node.label
  }

  return (
    <Box
      ref={containerRef}
      sx={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'auto' }}
    >
      <Box sx={{ position: 'relative', width, height }}>
        <svg
          width={width}
          height={height}
          style={{ position: 'absolute', inset: 0, overflow: 'visible' }}
        >
          <style>{`@keyframes flow-dash { to { stroke-dashoffset: -32; } }`}</style>
          {graph.links.map((link) => {
            const source = boxes.get(link.source)
            const target = boxes.get(link.target)
            const geometry = strokes.get(link.id)
            if (!source || !target || !geometry) return null
            const x1 = source.x + source.w
            const x2 = target.x
            const mid = (x1 + x2) / 2
            const d = `M${x1},${geometry.y1} C${mid},${geometry.y1} ${mid},${geometry.y2} ${x2},${geometry.y2}`
            const color = linkColor(link)
            const dim = lit && !lit.links.has(link.id)
            // Faster dots for busier links; idle links stay still.
            const duration = Math.min(
              2.4,
              Math.max(0.45, 2.6 - Math.log10(link.rate + 1) * 0.38),
            )
            return (
              <g
                key={link.id}
                style={{ opacity: dim ? 0.12 : 1, transition: 'opacity .2s' }}
              >
                <path
                  d={d}
                  fill="none"
                  stroke={alpha(color, isDark ? 0.45 : 0.32)}
                  strokeWidth={geometry.width}
                />
                {link.rate > 0 && (
                  <path
                    d={d}
                    fill="none"
                    stroke={alpha(isDark ? '#fff' : color, isDark ? 0.55 : 0.9)}
                    strokeWidth={Math.min(3, geometry.width)}
                    strokeLinecap="round"
                    strokeDasharray="3 13"
                    style={{
                      animation: `flow-dash ${duration}s linear infinite`,
                    }}
                  />
                )}
              </g>
            )
          })}
        </svg>

        {graph.nodes.map((node) => {
          const box = boxes.get(node.id)
          if (!box) return null
          const dim = lit && !lit.nodes.has(node.id)
          const color =
            node.column === 'app'
              ? undefined
              : node.column === 'group'
                ? policyColor(node.label, routeColors)
                : undefined
          const delay =
            node.column === 'node' ? delays.get(node.label) : undefined
          const speed = node.up + node.down
          return (
            <Box
              key={node.id}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              sx={{
                position: 'absolute',
                left: box.x,
                top: box.y,
                width: box.w,
                height: box.h,
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.25,
                borderRadius: 2.5,
                bgcolor: isDark ? '#282a36' : '#ffffff',
                border: '1px solid',
                borderColor: color ? alpha(color, 0.55) : 'divider',
                boxShadow: isDark ? 'none' : '0 1px 3px rgba(15,23,42,0.06)',
                opacity: dim ? 0.35 : 1,
                transition: 'opacity .2s, top .35s ease, height .35s ease',
                cursor: 'default',
                overflow: 'hidden',
              }}
            >
              {node.column === 'app' &&
                (node.id === OTHER_APPS ? (
                  <MoreHorizRounded sx={{ color: 'text.secondary' }} />
                ) : (
                  <ProcessAvatar
                    name={nodeLabel(node)}
                    exe={node.exe}
                    processName={node.processName}
                    size={26}
                  />
                ))}
              {node.column === 'group' && (
                <Box
                  sx={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    bgcolor: color,
                    flexShrink: 0,
                  }}
                />
              )}
              {node.column === 'node' && (
                <HubRounded
                  sx={{ fontSize: 18, color: 'text.secondary', flexShrink: 0 }}
                />
              )}
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography
                  noWrap
                  sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }}
                >
                  {nodeLabel(node)}
                </Typography>
                <Typography
                  noWrap
                  sx={{
                    fontSize: 11,
                    color: 'text.secondary',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {speed > 0
                    ? `↓ ${formatSpeed(node.down)}  ↑ ${formatSpeed(node.up)}`
                    : t('home.flow.connections', { count: node.connections })}
                </Typography>
              </Box>
              {delay !== undefined && (
                <Typography
                  sx={{
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                    color:
                      delay <= 0
                        ? 'error.main'
                        : delay < 200
                          ? 'success.main'
                          : delay < 500
                            ? 'warning.main'
                            : 'error.main',
                  }}
                >
                  {delay > 0 ? `${delay}ms` : t('home.flow.timeout')}
                </Typography>
              )}
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}
