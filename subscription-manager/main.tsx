import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import { createRoot } from 'react-dom/client'

import {
  SubscriptionManager,
  type SubscriptionManagerApi,
} from '../src/components/profile/subscription-manager'

const token =
  document.querySelector<HTMLMetaElement>('meta[name="manager-token"]')
    ?.content ?? ''
async function request(path: string, body?: unknown, method = 'POST') {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-Manager-Token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'generic')
  return result
}
const api: SubscriptionManagerApi = {
  read: () => request('subscriptions'),
  save: async (revision, input, originalName) => {
    await request('subscriptions', { revision, input, originalName })
  },
  remove: async (revision, name) => {
    await request('subscriptions', { revision, name }, 'DELETE')
  },
  refresh: async (name) => {
    await request('refresh', { name })
  },
}
const theme = createTheme({
  palette: {
    primary: { main: '#345ad4' },
    background: { default: '#f4f6fb', paper: '#ffffff' },
    text: { primary: '#182439', secondary: '#69758b' },
  },
  typography: {
    fontFamily: 'Inter, "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      styleOverrides: { root: { textTransform: 'none', fontWeight: 650 } },
    },
    MuiCard: { styleOverrides: { root: { borderColor: '#e3e8f1' } } },
  },
})
createRoot(document.getElementById('root')!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <SubscriptionManager api={api} />
  </ThemeProvider>,
)
