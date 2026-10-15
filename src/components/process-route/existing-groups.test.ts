import { expect, test } from 'vitest'

import {
  mergeProcessRouteGroups,
  updateProcessRouteGroups,
} from './existing-groups'

test('shows current runtime groups when no process groups have been saved', () => {
  const runtime = [{ name: 'AI' }, { name: 'Proxy' }]
  const items = mergeProcessRouteGroups([], runtime)

  expect(
    items.map(({ group, source }) => [group.name, group.target, source]),
  ).toEqual([
    ['AI', 'AI', 'runtime'],
    ['Proxy', 'Proxy', 'runtime'],
  ])
  expect(items[0].group.matchers).toEqual([])
  expect(mergeProcessRouteGroups([], [...runtime].reverse())[1].group.id).toBe(
    items[0].group.id,
  )
})

test('keeps provider groups without an inline proxies list', () => {
  const providerGroup = {
    name: 'Provider exits',
    type: 'select',
    use: ['subscription'],
  }

  expect(mergeProcessRouteGroups([], [providerGroup])[0].group.target).toBe(
    'Provider exits',
  )
})

test('preserves saved groups and does not duplicate their target or policy', () => {
  const stored: IProcessRouteGroup[] = [
    {
      id: 'saved-target',
      name: 'Editor',
      target: 'Subscription',
      matchers: [{ kind: 'PROCESS-NAME', value: 'code' }],
    },
    { id: 'saved-name', name: 'Local', matchers: [] },
  ]
  const items = mergeProcessRouteGroups(stored, [
    { name: 'Subscription' },
    { name: 'Local' },
    { name: 'Available' },
    { name: 'Available' },
  ])

  expect(items.map(({ group, source }) => [group.name, source])).toEqual([
    ['Editor', 'stored'],
    ['Local', 'stored'],
    ['Available', 'runtime'],
  ])
  expect(items[0].group).toBe(stored[0])
})

test('omits hidden and global runtime groups', () => {
  expect(
    mergeProcessRouteGroups(
      [],
      [
        { name: 'Clash Verge Update', hidden: true },
        { name: 'GLOBAL' },
        { name: 'Visible', hidden: false },
      ],
    ).map(({ group }) => group.name),
  ).toEqual(['Visible'])
})

test('does not persist untouched runtime cards and preserves saved empty groups', () => {
  const stored: IProcessRouteGroup[] = [
    { id: 'empty', name: 'Saved empty group', matchers: [] },
  ]

  expect(
    updateProcessRouteGroups(
      stored,
      [{ name: 'AI' }, { name: 'Proxy' }],
      (groups) => groups,
    ),
  ).toEqual(stored)
})

test('persists only the runtime group that receives a process binding', () => {
  const result = updateProcessRouteGroups(
    [],
    [{ name: 'AI' }, { name: 'Proxy' }, { name: 'Media' }],
    (groups) =>
      groups.map((group) =>
        group.target === 'AI'
          ? {
              ...group,
              matchers: [{ kind: 'PROCESS-NAME', value: 'claude' }],
            }
          : group,
      ),
  )

  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({
    name: 'AI',
    target: 'AI',
    matchers: [{ kind: 'PROCESS-NAME', value: 'claude' }],
  })
})
