import { dump, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  editSubscription,
  inspectSubscriptions,
  removeSubscription,
} from './subscription-config'

const original = {
  dns: { 'fake-ip-filter': ['connectivity-check.ubuntu.com'] },
  tun: { enable: false },
  rules: ['DOMAIN,api.telegram.org,Telegram', 'MATCH,DIRECT'],
  'proxy-providers': {
    existing: {
      type: 'http',
      url: 'https://example.com/sub',
      path: 'profiles/cache.yaml',
      interval: 86400,
      override: { 'additional-prefix': '[Existing] ' },
      'health-check': { enable: true, interval: 120 },
    },
  },
  'proxy-groups': [
    {
      name: 'Telegram',
      type: 'select',
      proxies: ['DIRECT'],
      use: ['existing'],
    },
    { name: 'Fallback', type: 'fallback', use: ['existing'] },
  ],
}
const input = {
  name: 'new',
  url: 'https://example.com/new',
  minutes: 60,
  groups: ['Telegram'],
}

describe('subscription form edits', () => {
  it('preserves unrelated network settings and provider options when adding a source', () => {
    const result = load(
      editSubscription(dump(original), input, null, 'profiles/new.yaml'),
    ) as typeof original
    expect(result.dns).toEqual(original.dns)
    expect(result.tun).toEqual(original.tun)
    expect(result.rules).toEqual(original.rules)
    expect(result['proxy-providers'].existing).toEqual(
      original['proxy-providers'].existing,
    )
    expect(result['proxy-groups'][0].use).toEqual(['existing', 'new'])
    expect(result['proxy-groups'][1]).toEqual(original['proxy-groups'][1])
    expect(
      inspectSubscriptions(dump(result)).sources.find(
        (source) => source.name === 'new',
      )?.minutes,
    ).toBe(60)
  })
  it('changes interval without overwriting cache, override or health checks', () => {
    const result = load(
      editSubscription(
        dump(original),
        { ...input, name: 'existing', groups: ['Telegram', 'Fallback'] },
        'existing',
        'unused.yaml',
      ),
    ) as typeof original
    expect(result['proxy-providers'].existing).toEqual({
      ...original['proxy-providers'].existing,
      url: input.url,
      interval: 3600,
    })
  })
  it('preserves absent provider options and membership order on interval edits', () => {
    const config = {
      'proxy-providers': {
        a: { type: 'http', url: input.url, path: 'a.yaml', interval: 3600 },
        b: { type: 'http', url: input.url, path: 'b.yaml', interval: 3600 },
      },
      'proxy-groups': [{ name: 'Apps', type: 'fallback', use: ['a', 'b'] }],
    }
    const result = load(
      editSubscription(
        dump(config),
        {
          name: 'a',
          url: input.url,
          minutes: 30,
          groups: ['Apps'],
        },
        'a',
        'unused.yaml',
      ),
    ) as typeof config
    expect(result['proxy-providers'].a).toEqual({
      ...config['proxy-providers'].a,
      interval: 1800,
    })
    expect(result['proxy-groups']).toEqual(config['proxy-groups'])
  })
  it('rejects removing or detaching the only source of a fallback group', () => {
    expect(() => removeSubscription(dump(original), 'existing')).toThrow(
      'emptyGroup',
    )
    expect(() =>
      editSubscription(
        dump(original),
        { ...input, name: 'existing' },
        'existing',
        'unused.yaml',
      ),
    ).toThrow('emptyGroup')
  })
  it('rejects removing the last provider used by automatic groups', () => {
    for (const flag of ['include-all', 'include-all-providers']) {
      const config = {
        ...original,
        'proxy-groups': [{ name: 'Automatic', type: 'select', [flag]: true }],
      }
      expect(() => removeSubscription(dump(config), 'existing')).toThrow(
        'emptyGroup',
      )
      const withInline = () =>
        removeSubscription(
          dump({ ...config, proxies: [{ name: 'direct-node' }] }),
          'existing',
        )
      if (flag === 'include-all') expect(withInline).not.toThrow()
      else expect(withInline).toThrow('emptyGroup')
    }
  })
  it('requires real inline nodes before allowing an emptied include-all-proxies group', () => {
    const config = {
      ...original,
      'proxy-groups': original['proxy-groups'].map((group) => ({
        ...group,
        'include-all-proxies': true,
      })),
    }
    for (const proxies of [undefined, []]) {
      const text = dump({ ...config, proxies })
      expect(() => removeSubscription(text, 'existing')).toThrow('emptyGroup')
      expect(() =>
        editSubscription(
          text,
          {
            ...input,
            name: 'existing',
            groups: ['Telegram'],
          },
          'existing',
          'unused.yaml',
        ),
      ).toThrow('emptyGroup')
    }
    expect(() =>
      removeSubscription(
        dump({
          ...config,
          proxies: [{ name: 'direct-node' }],
        }),
        'existing',
      ),
    ).not.toThrow()
  })
  it('removes only the selected source and its references', () => {
    const edited = editSubscription(
      dump(original),
      input,
      null,
      'profiles/new.yaml',
    )
    expect(load(removeSubscription(edited, 'new'))).toEqual(original)
  })
  it('rejects invalid inputs before saving', () => {
    expect(() =>
      editSubscription(
        dump(original),
        { ...input, name: 'existing' },
        null,
        'cache.yaml',
      ),
    ).toThrow('duplicateName')
    expect(() =>
      editSubscription(
        dump(original),
        { ...input, url: 'file:///tmp/config' },
        null,
        'cache.yaml',
      ),
    ).toThrow('invalidUrl')
    expect(() =>
      editSubscription(
        dump(original),
        { ...input, minutes: 0 },
        null,
        'cache.yaml',
      ),
    ).toThrow('invalidInterval')
    expect(() =>
      editSubscription(
        dump(original),
        { ...input, groups: ['missing'] },
        null,
        'cache.yaml',
      ),
    ).toThrow('configChanged')
  })
})
