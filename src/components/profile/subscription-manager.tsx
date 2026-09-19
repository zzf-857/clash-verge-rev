import {
  AddRounded,
  ArrowForwardRounded,
  DeleteOutlineRounded,
  EditOutlined,
  RefreshRounded,
  SearchRounded,
  StorageRounded,
} from '@mui/icons-material'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Card,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { useCallback, useEffect, useState } from 'react'

import type {
  SubscriptionInput,
  SubscriptionSource,
} from '../../utils/subscription-config'

import { subscriptionText } from './subscription-manager-text'

export interface SubscriptionSnapshot {
  revision: string
  profile: string
  editable: boolean
  sources: (SubscriptionSource & {
    count?: number
    updatedAt?: string
    expire?: number
  })[]
  groups: { name: string; automatic: boolean }[]
}

export interface SubscriptionManagerApi {
  read: () => Promise<SubscriptionSnapshot>
  save: (
    revision: string,
    input: SubscriptionInput,
    originalName: string | null,
  ) => Promise<void>
  remove: (revision: string, name: string) => Promise<void>
  refresh: (name: string) => Promise<void>
}

export function SubscriptionManager({
  api,
  language = 'zh',
}: {
  api: SubscriptionManagerApi
  language?: string
}) {
  const text = subscriptionText[language.startsWith('zh') ? 'zh' : 'en']
  const [data, setData] = useState<SubscriptionSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [form, setForm] = useState<SubscriptionInput | null>(null)
  const [originalName, setOriginalName] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setData(await api.read())
  }, [api])
  const errorText = (err: unknown) => {
    const key = err instanceof Error ? err.message : ''
    return Object.hasOwn(text, key)
      ? text[key as keyof typeof text]
      : text.generic
  }
  useEffect(() => {
    let active = true
    api
      .read()
      .then((value) => {
        if (active) setData(value)
      })
      .catch(() => {
        if (active) setError(text.unavailable)
      })
    return () => {
      active = false
    }
  }, [api, text.unavailable])

  const run = async (action: () => Promise<void | false>, success: string) => {
    if (busy) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await action()
      await load()
      if (result !== false) setNotice(success)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const refresh = (names: string[]) =>
    run(async () => {
      const failed: string[] = []
      for (const name of names) {
        try {
          await api.refresh(name)
        } catch {
          failed.push(name)
        }
      }
      if (failed.length) {
        await load()
        setError(text.partialRefresh + failed.join(', '))
        return false
      }
    }, text.refreshed)
  const openForm = (source?: SubscriptionSource) => {
    setError('')
    setNotice('')
    setOriginalName(source?.name ?? null)
    setForm(
      source ? { ...source } : { name: '', url: '', minutes: 60, groups: [] },
    )
  }
  const date = (value?: string | number) =>
    value
      ? new Date(
          typeof value === 'number' ? value * 1000 : value,
        ).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' })
      : text.never
  const sources = data?.sources ?? []
  const visible = sources.filter((source) =>
    `${source.name} ${source.groups.join(' ')}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  )
  const remote = sources.filter((source) => source.type === 'http')

  return (
    <Box sx={{ maxWidth: 1120, mx: 'auto', p: { xs: 2, md: 4 } }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          mb: 3,
        }}
      >
        <Box>
          <Typography
            variant="overline"
            color="primary"
            sx={{ fontWeight: 800, letterSpacing: 2 }}
          >
            CLASH VERGE / WORKSPACE
          </Typography>
          <Typography variant="h4" sx={{ fontWeight: 800, my: 0.5 }}>
            {text.title}
          </Typography>
          <Typography color="text.secondary">{text.subtitle}</Typography>
        </Box>
        <Chip
          color="success"
          variant="outlined"
          label={data?.profile ?? text.loading}
          icon={<StorageRounded />}
          sx={{ maxWidth: 300 }}
        />
      </Stack>
      {error && (
        <Alert severity="error" onClose={() => setError('')} sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {notice && !error && (
        <Alert severity="success" onClose={() => setNotice('')} sx={{ mb: 2 }}>
          {notice}
        </Alert>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 2,
          mb: 3,
        }}
      >
        {[
          [text.sources, sources.length],
          [
            text.nodes,
            sources.reduce((sum, source) => sum + (source.count ?? 0), 0),
          ],
          [text.remote, remote.length],
        ].map(([label, value]) => (
          <Card key={label} variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
            <Typography variant="body2" color="text.secondary">
              {label}
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 750, mt: 1 }}>
              {value}
            </Typography>
          </Card>
        ))}
      </Box>
      <Alert severity="info" sx={{ mb: 3, borderRadius: 2 }}>
        {data && !data.editable ? text.localOnly : text.refreshHint}
      </Alert>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={1.5}
        sx={{ mb: 2.5 }}
      >
        <TextField
          size="small"
          placeholder={text.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          sx={{ flex: 1 }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded />
                </InputAdornment>
              ),
            },
          }}
        />
        <Button
          variant="outlined"
          startIcon={<RefreshRounded />}
          disabled={busy || !remote.length}
          onClick={() => {
            void refresh(remote.map((source) => source.name))
          }}
        >
          {text.refreshAll}
        </Button>
        <Button
          variant="contained"
          disableElevation
          startIcon={<AddRounded />}
          disabled={busy || !data?.editable}
          onClick={() => openForm()}
        >
          {text.add}
        </Button>
      </Stack>
      {busy && (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 2 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">
            {form || removing ? text.saving : text.loading}
          </Typography>
        </Stack>
      )}
      {!data && (
        <Box sx={{ textAlign: 'center', py: 5 }}>
          <Button
            onClick={() => {
              void run(load, '')
            }}
            disabled={busy}
          >
            {text.retry}
          </Button>
        </Box>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)' },
          gap: 2,
        }}
      >
        {visible.map((source) => (
          <Card
            key={source.name}
            variant="outlined"
            sx={{
              p: 2.5,
              borderRadius: 3,
              display: 'flex',
              flexDirection: 'column',
              transition: 'box-shadow 160ms',
              '&:hover': { boxShadow: '0 8px 28px rgba(25,45,85,.07)' },
            }}
          >
            <Stack
              direction="row"
              spacing={1.5}
              sx={{ alignItems: 'center', mb: 2 }}
            >
              <Box
                sx={{
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  borderRadius: 2,
                  width: 42,
                  height: 42,
                  display: 'grid',
                  placeItems: 'center',
                  fontWeight: 800,
                }}
              >
                {source.name.slice(0, 1).toUpperCase()}
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="h6" noWrap sx={{ fontWeight: 700 }}>
                  {source.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {source.type === 'http' ? text.http : text.local}
                </Typography>
              </Box>
              <Chip
                size="small"
                label={source.count ? text.ready : text.pending}
                color={source.count ? 'success' : 'default'}
                variant="outlined"
              />
            </Stack>
            <Stack
              direction="row"
              sx={{ alignItems: 'end', justifyContent: 'space-between', mb: 2 }}
            >
              <Box>
                <Typography variant="h4" sx={{ fontWeight: 700 }}>
                  {source.count ?? '—'}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {text.nodes}
                </Typography>
              </Box>
              <Box sx={{ textAlign: 'right' }}>
                <Typography variant="body2">
                  {source.minutes
                    ? text.every.replace('{n}', String(source.minutes))
                    : text.manual}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {text.updated} · {date(source.updatedAt)}
                </Typography>
              </Box>
            </Stack>
            {!!source.expire && (
              <Typography
                variant="caption"
                color={
                  source.expire * 1000 < Date.now() ? 'error' : 'text.secondary'
                }
                sx={{ mb: 1 }}
              >
                {source.expire * 1000 < Date.now() ? text.expired : text.expiry}{' '}
                · {date(source.expire)}
              </Typography>
            )}
            <Box
              sx={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 0.7,
                mb: 2,
                flex: 1,
              }}
            >
              {[
                ...source.groups,
                ...(data?.groups
                  .filter(
                    (group) =>
                      group.automatic && !source.groups.includes(group.name),
                  )
                  .map((group) => group.name) ?? []),
              ].map((group) => (
                <Chip
                  key={group}
                  label={group}
                  size="small"
                  sx={{ fontSize: 11 }}
                />
              ))}
              {!source.groups.length &&
                !data?.groups.some((group) => group.automatic) && (
                  <Typography color="text.secondary" variant="caption">
                    {text.noGroups}
                  </Typography>
                )}
            </Box>
            <Divider sx={{ mb: 1.5 }} />
            <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
              <Button
                size="small"
                startIcon={<RefreshRounded />}
                disabled={busy || source.type !== 'http'}
                onClick={() => {
                  void refresh([source.name])
                }}
              >
                {text.refresh}
              </Button>
              <Box sx={{ flex: 1 }} />
              <Button
                size="small"
                startIcon={<EditOutlined />}
                disabled={busy || !data?.editable || source.type !== 'http'}
                onClick={() => openForm(source)}
              >
                {text.edit}
              </Button>
              <Button
                size="small"
                color="error"
                startIcon={<DeleteOutlineRounded />}
                disabled={busy || !data?.editable}
                onClick={() => {
                  setError('')
                  setRemoving(source.name)
                }}
              >
                {text.remove}
              </Button>
            </Stack>
          </Card>
        ))}
      </Box>
      {data && !visible.length && (
        <Typography color="text.secondary" sx={{ textAlign: 'center', py: 6 }}>
          {sources.length ? text.noMatches : text.empty}
        </Typography>
      )}
      <Dialog
        open={!!form}
        onClose={() => {
          if (!busy) setForm(null)
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{originalName ? text.edit : text.add}</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField
              label={text.name}
              value={form?.name ?? ''}
              disabled={busy || originalName !== null}
              onChange={(event) =>
                setForm(
                  (value) => value && { ...value, name: event.target.value },
                )
              }
              autoFocus
              required
            />
            <TextField
              label={text.url}
              value={form?.url ?? ''}
              type="password"
              autoComplete="off"
              disabled={busy}
              helperText={text.urlHelp}
              onChange={(event) =>
                setForm(
                  (value) => value && { ...value, url: event.target.value },
                )
              }
              required
            />
            <TextField
              label={text.minutes}
              type="number"
              value={form?.minutes ?? 60}
              disabled={busy}
              slotProps={{ htmlInput: { min: 1, max: 10080, step: 1 } }}
              onChange={(event) =>
                setForm(
                  (value) =>
                    value && { ...value, minutes: Number(event.target.value) },
                )
              }
            />
            <Autocomplete
              multiple
              disableCloseOnSelect
              options={data?.groups.map((group) => group.name) ?? []}
              value={form?.groups ?? []}
              disabled={busy}
              onChange={(_, groups) =>
                setForm((value) => value && { ...value, groups })
              }
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={text.groups}
                  helperText={text.groupHelp}
                />
              )}
            />
            {data?.groups.some((group) => group.automatic) && (
              <Typography variant="caption" color="text.secondary">
                {text.automatic}:{' '}
                {data.groups
                  .filter((group) => group.automatic)
                  .map((group) => group.name)
                  .join(', ')}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 3 }}>
          <Button disabled={busy} onClick={() => setForm(null)}>
            {text.cancel}
          </Button>
          <Button
            variant="contained"
            disabled={busy || !form?.name || !form.url}
            endIcon={
              busy ? <CircularProgress size={16} /> : <ArrowForwardRounded />
            }
            onClick={() => {
              if (data && form)
                void run(async () => {
                  await api.save(data.revision, form, originalName)
                  setForm(null)
                }, text.saved)
            }}
          >
            {text.save}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={removing !== null}
        onClose={() => {
          if (!busy) setRemoving(null)
        }}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          {text.confirmRemove} · {removing}
        </DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Typography>{text.removeHelp}</Typography>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setRemoving(null)}>
            {text.cancel}
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={() => {
              if (data && removing)
                void run(async () => {
                  await api.remove(data.revision, removing)
                  setRemoving(null)
                }, text.removed)
            }}
          >
            {text.remove}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
