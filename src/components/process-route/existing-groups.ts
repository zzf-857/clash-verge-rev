import type { ProxyGroupView } from '@/types/proxy-view'

export interface ProcessRouteGroupItem {
  group: IProcessRouteGroup
  source: 'stored' | 'runtime'
}

export const mergeProcessRouteGroups = (
  storedGroups: readonly IProcessRouteGroup[],
  runtimeGroups: readonly Pick<ProxyGroupView, 'name' | 'hidden'>[],
): ProcessRouteGroupItem[] => {
  const items: ProcessRouteGroupItem[] = storedGroups.map((group) => ({
    group,
    source: 'stored',
  }))
  const policies = new Set(
    storedGroups.map((group) => group.target || group.name.trim()),
  )

  for (const { name, hidden } of runtimeGroups) {
    if (hidden || !name.trim() || name === 'GLOBAL' || policies.has(name)) {
      continue
    }
    policies.add(name)
    items.push({
      group: {
        id: `runtime:${encodeURIComponent(name)}`,
        name,
        target: name,
        enabled: true,
        matchers: [],
      },
      source: 'runtime',
    })
  }

  return items
}

export const updateProcessRouteGroups = (
  storedGroups: readonly IProcessRouteGroup[],
  runtimeGroups: readonly Pick<ProxyGroupView, 'name' | 'hidden'>[],
  updater: (groups: IProcessRouteGroup[]) => IProcessRouteGroup[],
): IProcessRouteGroup[] => {
  const items = mergeProcessRouteGroups(storedGroups, runtimeGroups)
  const virtualIds = new Set(
    items
      .filter(({ source }) => source === 'runtime')
      .map(({ group }) => group.id),
  )

  return updater(items.map(({ group }) => group)).filter(
    (group) => !virtualIds.has(group.id) || group.matchers.length > 0,
  )
}
