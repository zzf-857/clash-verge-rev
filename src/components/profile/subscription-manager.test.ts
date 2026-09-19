import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import {
  SubscriptionManager,
  type SubscriptionManagerApi,
} from './subscription-manager'

const api: SubscriptionManagerApi = {
  read: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}

describe('subscription manager backup discovery', () => {
  it('explains that WebDAV needs the desktop app in the standalone browser', () => {
    const html = renderToStaticMarkup(
      createElement(SubscriptionManager, { api, language: 'en' }),
    )
    expect(html).toContain('WebDAV backup / sync')
    expect(html).toContain('Open the Clash Verge desktop app')
    expect(html).toContain('not available in the standalone browser')
    expect(api.read).not.toHaveBeenCalled()
  })
})
