interface ConfiguredProcessRule {
  type: unknown
  payload: string
  proxy: string
}

const PROCESS_KINDS: Partial<Record<string, ProcessMatchKind>> = {
  ProcessName: 'PROCESS-NAME',
  ProcessPath: 'PROCESS-PATH',
  ProcessPathRegex: 'PROCESS-PATH-REGEX',
  'PROCESS-NAME': 'PROCESS-NAME',
  'PROCESS-PATH': 'PROCESS-PATH',
  'PROCESS-PATH-REGEX': 'PROCESS-PATH-REGEX',
}

const matcherKey = (kind: ProcessMatchKind, value: string) =>
  JSON.stringify([kind, value])

export const configuredProcessMatchers = (
  rules: readonly ConfiguredProcessRule[],
  storedGroups: readonly IProcessRouteGroup[],
): Map<string, IProcessMatcher[]> => {
  const seen = new Set(
    storedGroups
      .filter((group) => group.enabled !== false)
      .flatMap((group) =>
        group.matchers.map(({ kind, value }) => matcherKey(kind, value)),
      ),
  )
  const policies = new Map<string, IProcessMatcher[]>()

  for (const rule of rules) {
    if (typeof rule.type !== 'string') continue
    const kind = PROCESS_KINDS[rule.type]
    if (!kind || !rule.payload || !rule.proxy.trim()) continue

    const key = matcherKey(kind, rule.payload)
    if (seen.has(key)) continue
    seen.add(key)

    const matchers = policies.get(rule.proxy) ?? []
    matchers.push({ kind, value: rule.payload })
    policies.set(rule.proxy, matchers)
  }

  return policies
}
