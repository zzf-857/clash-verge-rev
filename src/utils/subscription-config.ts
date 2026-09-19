import { dump, load } from 'js-yaml'

type Mapping = Record<string, unknown>

export interface SubscriptionInput {
  name: string
  url: string
  minutes: number
  groups: string[]
}

export interface SubscriptionSource extends SubscriptionInput {
  type: string
}

export class SubscriptionConfigError extends Error {}

function mapping(value: unknown): Mapping {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SubscriptionConfigError('invalidConfig')
  }
  return value as Mapping
}

function read(text: string) {
  const config = mapping(load(text))
  const providers = mapping(config['proxy-providers'] ?? {})
  const groups = config['proxy-groups'] ?? []
  if (!Array.isArray(groups)) throw new SubscriptionConfigError('invalidConfig')
  return { config, providers, groups: groups.map(mapping) }
}

export function inspectSubscriptions(text: string) {
  const { providers, groups } = read(text)
  return {
    sources: Object.entries(providers).map(([name, value]) => {
      const provider = mapping(value)
      return {
        name,
        type: String(provider.type ?? 'inline'),
        url: typeof provider.url === 'string' ? provider.url : '',
        minutes: Number(provider.interval ?? 0) / 60,
        groups: groups
          .filter(
            (group) => Array.isArray(group.use) && group.use.includes(name),
          )
          .map((group) => String(group.name)),
      }
    }),
    groups: groups.map((group) => ({
      name: String(group.name),
      automatic:
        group['include-all'] === true ||
        group['include-all-providers'] === true,
    })),
  }
}

export function editSubscription(
  text: string,
  input: SubscriptionInput,
  originalName: string | null,
  cachePath: string,
) {
  const { config, providers, groups } = read(text)
  const name = input.name.trim()
  if (
    !name ||
    name.length > 80 ||
    [...name].some((character) => character.charCodeAt(0) < 32) ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  ) {
    throw new SubscriptionConfigError('invalidName')
  }
  if (
    originalName !== null &&
    (originalName !== name || !Object.hasOwn(providers, name))
  ) {
    throw new SubscriptionConfigError('configChanged')
  }
  if (originalName === null && Object.hasOwn(providers, name)) {
    throw new SubscriptionConfigError('duplicateName')
  }
  let url: URL
  try {
    url = new URL(input.url.trim())
  } catch {
    throw new SubscriptionConfigError('invalidUrl')
  }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) {
    throw new SubscriptionConfigError('invalidUrl')
  }
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < 1 ||
    input.minutes > 10080
  ) {
    throw new SubscriptionConfigError('invalidInterval')
  }
  const knownGroups = groups.map((group) => String(group.name))
  if (
    !Array.isArray(input.groups) ||
    input.groups.some((group) => !knownGroups.includes(group))
  ) {
    throw new SubscriptionConfigError('configChanged')
  }
  if (
    !input.groups.length &&
    !groups.some(
      (group) =>
        group['include-all'] === true ||
        group['include-all-providers'] === true,
    )
  ) {
    throw new SubscriptionConfigError('chooseGroups')
  }
  const previous = originalName === null ? {} : mapping(providers[name])
  if (originalName !== null && previous.type !== 'http')
    throw new SubscriptionConfigError('localSource')
  providers[name] = {
    ...(originalName === null
      ? {
          path: cachePath,
          override: { 'additional-prefix': `[${name}] ` },
          'health-check': {
            enable: true,
            url: 'https://www.gstatic.com/generate_204',
            interval: 300,
          },
        }
      : previous),
    type: 'http',
    url: input.url.trim(),
    interval: input.minutes * 60,
  }
  config['proxy-providers'] = providers
  for (const group of groups) {
    const uses = Array.isArray(group.use) ? (group.use as string[]) : []
    const selected = input.groups.includes(String(group.name))
    const next = selected ? [...uses] : uses.filter((item) => item !== name)
    if (selected && !uses.includes(name)) next.push(name)
    if (next.length || uses.length) group.use = next
    ensureGroupNotEmptied(group, uses, next, config)
  }
  return dump(config, { lineWidth: -1, noRefs: true })
}

function ensureGroupNotEmptied(
  group: Mapping,
  before: string[],
  after: string[],
  config: Mapping,
) {
  if (
    before.length &&
    !after.length &&
    !(Array.isArray(group.proxies) && group.proxies.length) &&
    group['include-all'] !== true &&
    group['include-all-providers'] !== true &&
    !(
      group['include-all-proxies'] === true &&
      Array.isArray(config.proxies) &&
      config.proxies.length
    )
  ) {
    throw new SubscriptionConfigError('emptyGroup')
  }
}

export function removeSubscription(text: string, name: string) {
  const { config, providers, groups } = read(text)
  if (!Object.hasOwn(providers, name))
    throw new SubscriptionConfigError('configChanged')
  delete providers[name]
  for (const group of groups) {
    if (
      (group['include-all'] === true ||
        group['include-all-providers'] === true) &&
      !Object.keys(providers).length &&
      !(Array.isArray(group.proxies) && group.proxies.length) &&
      !(
        (group['include-all'] === true ||
          group['include-all-proxies'] === true) &&
        Array.isArray(config.proxies) &&
        config.proxies.length
      )
    ) {
      throw new SubscriptionConfigError('emptyGroup')
    }
    if (!Array.isArray(group.use)) continue
    const before = group.use as string[]
    const after = before.filter((item) => item !== name)
    ensureGroupNotEmptied(group, before, after, config)
    group.use = after
  }
  return dump(config, { lineWidth: -1, noRefs: true })
}
