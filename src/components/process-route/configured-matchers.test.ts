import { expect, test } from 'vitest'

import { configuredProcessMatchers } from './configured-matchers'

test('maps configured process rules without mutating their order or contents', () => {
  const rules = Array.from({ length: 9 }, (_, index) => ({
    type: 'ProcessName',
    payload: `app-${index}`,
    proxy: `Group ${index % 3}`,
  }))
  const original = structuredClone(rules)
  const result = configuredProcessMatchers(rules, [])

  expect([...result.keys()]).toEqual(['Group 0', 'Group 1', 'Group 2'])
  expect([...result.values()].map((matchers) => matchers.length)).toEqual([
    3, 3, 3,
  ])
  expect(result.get('Group 0')?.map(({ value }) => value)).toEqual(
    rules
      .filter(({ proxy }) => proxy === 'Group 0')
      .map(({ payload }) => payload),
  )
  expect(rules).toEqual(original)
})

test('hides configured bindings overridden by enabled saved groups', () => {
  const stored: IProcessRouteGroup[] = [
    {
      id: 'override',
      name: 'New policy',
      matchers: [{ kind: 'PROCESS-NAME', value: 'claude' }],
    },
    {
      id: 'disabled',
      name: 'Disabled policy',
      enabled: false,
      matchers: [{ kind: 'PROCESS-NAME', value: 'code' }],
    },
  ]

  expect([
    ...configuredProcessMatchers(
      [
        { type: 'ProcessName', payload: 'claude', proxy: 'Old policy' },
        { type: 'ProcessName', payload: 'code', proxy: 'Original' },
      ],
      stored,
    ),
  ]).toEqual([['Original', [{ kind: 'PROCESS-NAME', value: 'code' }]]])
})

test('uses the first valid target across duplicate process rules', () => {
  const result = configuredProcessMatchers(
    [
      { type: 'ProcessPath', payload: '/usr/bin/code', proxy: '' },
      { type: 'ProcessPath', payload: '/usr/bin/code', proxy: 'First' },
      { type: 'PROCESS-PATH', payload: '/usr/bin/code', proxy: 'Later' },
      { type: 'ProcessPathRegex', payload: '^/opt/app/', proxy: 'Regex' },
      { type: 'PROCESS-NAME', payload: 'claude', proxy: 'First' },
    ],
    [],
  )

  expect([...result]).toEqual([
    [
      'First',
      [
        { kind: 'PROCESS-PATH', value: '/usr/bin/code' },
        { kind: 'PROCESS-NAME', value: 'claude' },
      ],
    ],
    ['Regex', [{ kind: 'PROCESS-PATH-REGEX', value: '^/opt/app/' }]],
  ])
})

test('does not import domain or other non-process rules', () => {
  expect(
    configuredProcessMatchers(
      [
        { type: 'DomainSuffix', payload: 'example.com', proxy: 'AI' },
        { type: 'DOMAIN', payload: 'api.example.com', proxy: 'AI' },
        { type: 'Match', payload: '', proxy: 'Proxy' },
      ],
      [],
    ).size,
  ).toBe(0)
})

test('skips the API unknown rule-type variant', () => {
  expect(
    configuredProcessMatchers(
      [{ type: { Unknown: 'ProcessName' }, payload: 'claude', proxy: 'AI' }],
      [],
    ).size,
  ).toBe(0)
})
