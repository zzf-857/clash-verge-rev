import {
  AddRounded,
  CloseRounded,
  FolderOpenRounded,
  LanRounded,
  MemoryRounded,
  RefreshRounded,
  SearchRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  ButtonBase,
  Chip,
  IconButton,
  InputAdornment,
  Skeleton,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { memo, useDeferredValue, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useConnectionData } from '@/hooks/use-connection-data'
import {
  useAppRefreshers,
  useClashConfigData,
} from '@/providers/app-data-context'
import { patchClashConfig } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import getSystem from '@/utils/get-system'
import parseTraffic from '@/utils/parse-traffic'

import { ProcessAvatar } from './process-avatar'
import {
  GROUP_COLORS,
  type ProcessApp,
  appKey,
  basename,
  displayName,
  groupProcesses,
  isAppBundle,
  matcherMatches,
  shortenPath,
} from './process-utils'

type Tab = 'running' | 'traffic'

interface PickerApp extends ProcessApp {
  connections?: number
  traffic?: number
}

interface Props {
  processes: IProcessEntry[] | undefined
  loading: boolean
  groups: IProcessRouteGroup[]
  targetGroup: IProcessRouteGroup | null
  onRefresh: () => void
  onClearTarget: () => void
  onPick: (app: ProcessApp) => void
}

const formatBytes = (value: number) => parseTraffic(value).join(' ')

export const ProcessPicker = ({
  processes,
  loading,
  groups,
  targetGroup,
  onRefresh,
  onClearTarget,
  onPick,
}: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const [tab, setTab] = useState<Tab>('running')
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const {
    response: { data: connData },
  } = useConnectionData()
  const { clashConfig } = useClashConfigData()
  const { refreshClashConfig } = useAppRefreshers()
  // In mihomo's default "strict" mode only connections hitting a process rule carry
  // the process name, so the traffic tab cannot list unrouted programs.
  const detectsAllProcesses = clashConfig?.findProcessMode === 'Always'
  const enableDetection = async () => {
    try {
      await patchClashConfig({ 'find-process-mode': 'always' })
      await refreshClashConfig()
    } catch (error) {
      showNotice.error(error)
    }
  }

  const runningApps = useMemo(
    () => groupProcesses(processes ?? []),
    [processes],
  )

  const trafficApps = useMemo(() => {
    const apps = new Map<string, PickerApp>()
    const collect = (conn: IConnectionsItem, active: boolean) => {
      const { process, processPath } = conn.metadata
      if (!process && !processPath) return
      const exe = processPath || null
      const name = process || basename(processPath ?? '')
      const key = appKey(name, exe)
      const running = runningApps.get(key)
      const entry =
        apps.get(key) ??
        ({
          key,
          name,
          label: running?.label ?? name,
          exe,
          pids: running?.pids ?? [],
          memory: running?.memory ?? 0,
          connections: 0,
          traffic: 0,
        } satisfies PickerApp)
      if (active) entry.connections = (entry.connections ?? 0) + 1
      entry.traffic = (entry.traffic ?? 0) + conn.upload + conn.download
      apps.set(key, entry)
    }
    connData.activeConnections.forEach((conn) => collect(conn, true))
    connData.closedConnections.forEach((conn) => collect(conn, false))
    return apps
  }, [connData, runningApps])

  const list = useMemo<PickerApp[]>(() => {
    const keyword = deferredQuery.trim().toLowerCase()
    const source: PickerApp[] =
      tab === 'running'
        ? [...runningApps.values()].map((app) => ({
            ...app,
            connections: trafficApps.get(app.key)?.connections,
          }))
        : [...trafficApps.values()]
    return source
      .filter(
        (app) =>
          !keyword ||
          app.label.toLowerCase().includes(keyword) ||
          app.exe?.toLowerCase().includes(keyword),
      )
      .sort((a, b) =>
        tab === 'traffic'
          ? (b.connections ?? 0) - (a.connections ?? 0) ||
            (b.traffic ?? 0) - (a.traffic ?? 0)
          : Number(!!b.connections) - Number(!!a.connections) ||
            b.memory - a.memory,
      )
  }, [deferredQuery, runningApps, tab, trafficApps])

  const routedGroupOf = (app: ProcessApp) =>
    groups.find((group) =>
      group.matchers.some((matcher) => matcherMatches(matcher, app)),
    )

  const browse = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        // Shortcuts (.lnk) never match a running process path.
        filters:
          getSystem() === 'windows'
            ? [{ name: 'Programs', extensions: ['exe'] }]
            : undefined,
      })
      if (typeof selected !== 'string') return
      const running = runningApps.get(selected)
      if (running) {
        onPick(running)
        return
      }
      const bundle = isAppBundle(selected)
      const name = bundle
        ? basename(selected).replace(/\.app$/i, '')
        : basename(selected)
      // Child detection starts from whatever runs inside the picked bundle.
      const pids = bundle
        ? [...runningApps.values()]
            .filter((app) => app.exe?.startsWith(`${selected}/`))
            .flatMap((app) => app.pids)
        : []
      onPick({
        key: selected,
        name,
        label: name,
        exe: selected,
        pids,
        memory: 0,
      })
    } catch (error) {
      showNotice.error(error)
    }
  }

  const targetColor = targetGroup?.color ?? GROUP_COLORS[0]

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        height: '100%',
        borderRadius: 3,
        bgcolor: isDark ? '#282a36' : '#ffffff',
        overflow: 'hidden',
      }}
    >
      <Box sx={{ px: 2, pt: 1.75, pb: 1.25 }}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            mb: 1.25,
          }}
        >
          <Typography sx={{ fontWeight: 700, fontSize: 15 }}>
            {t('process.picker.title')}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            <Tooltip title={t('process.picker.browse')}>
              <IconButton size="small" onClick={browse}>
                <FolderOpenRounded fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title={t('process.page.actions.refresh')}>
              <IconButton size="small" onClick={onRefresh} disabled={loading}>
                <RefreshRounded
                  fontSize="small"
                  sx={{
                    animation: loading
                      ? 'pr-spin 0.9s linear infinite'
                      : 'none',
                    '@keyframes pr-spin': {
                      to: { transform: 'rotate(360deg)' },
                    },
                  }}
                />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>

        <ToggleButtonGroup
          exclusive
          fullWidth
          size="small"
          value={tab}
          onChange={(_, value: Tab | null) => value && setTab(value)}
          sx={{
            mb: 1.25,
            p: 0.4,
            gap: 0.4,
            borderRadius: 2,
            bgcolor: 'action.hover',
            '& .MuiToggleButton-root': {
              border: 0,
              borderRadius: '8px !important',
              py: 0.6,
              gap: 0.75,
              fontSize: 13,
              textTransform: 'none',
              color: 'text.secondary',
              '&.Mui-selected': {
                color: 'text.primary',
                bgcolor: 'background.paper',
                boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
                '&:hover': { bgcolor: 'background.paper' },
              },
            },
          }}
        >
          <ToggleButton value="running">
            <MemoryRounded sx={{ fontSize: 16 }} />
            {t('process.picker.tabs.running')}
            <CountBadge value={runningApps.size} />
          </ToggleButton>
          <ToggleButton value="traffic">
            <LanRounded sx={{ fontSize: 16 }} />
            {t('process.picker.tabs.traffic')}
            <CountBadge value={trafficApps.size} />
          </ToggleButton>
        </ToggleButtonGroup>

        <TextField
          fullWidth
          size="small"
          value={query}
          placeholder={t('process.picker.search')}
          onChange={(event) => setQuery(event.target.value)}
          slotProps={{
            input: {
              sx: { borderRadius: 2 },
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRounded fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />

        {targetGroup && (
          <Box
            sx={{
              mt: 1.25,
              px: 1.25,
              py: 0.75,
              borderRadius: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              bgcolor: alpha(targetColor, 0.12),
              color: targetColor,
              animation: 'pr-fade-in .25s ease',
              '@keyframes pr-fade-in': {
                from: { opacity: 0, transform: 'translateY(-4px)' },
              },
            }}
          >
            <AddRounded sx={{ fontSize: 18 }} />
            <Typography sx={{ fontSize: 13, fontWeight: 600, flex: 1 }} noWrap>
              {t('process.picker.addingTo', { name: targetGroup.name })}
            </Typography>
            <IconButton
              size="small"
              onClick={onClearTarget}
              sx={{ color: 'inherit' }}
            >
              <CloseRounded sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>
        )}
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 1, pb: 1 }}>
        {tab === 'traffic' && clashConfig && !detectsAllProcesses && (
          <Box
            sx={{
              mx: 0.5,
              mb: 1,
              px: 1.5,
              py: 1.25,
              borderRadius: 2,
              display: 'flex',
              alignItems: 'center',
              gap: 1.5,
              bgcolor: (theme) => alpha(theme.palette.info.main, 0.08),
              border: (theme) =>
                `1px solid ${alpha(theme.palette.info.main, 0.2)}`,
            }}
          >
            <Typography
              sx={{ fontSize: 12.5, flex: 1, color: 'text.secondary' }}
            >
              {t('process.picker.detect.desc')}
            </Typography>
            <Button
              size="small"
              variant="contained"
              disableElevation
              onClick={enableDetection}
              sx={{ borderRadius: 2, flexShrink: 0, textTransform: 'none' }}
            >
              {t('process.picker.detect.action')}
            </Button>
          </Box>
        )}
        {loading && !processes
          ? Array.from({ length: 8 }, (_, index) => (
              <Box key={index} sx={{ display: 'flex', gap: 1.25, p: 1.25 }}>
                <Skeleton variant="rounded" width={32} height={32} />
                <Box sx={{ flex: 1 }}>
                  <Skeleton width="45%" />
                  <Skeleton width="80%" height={14} />
                </Box>
              </Box>
            ))
          : list.map((app) => (
              <ProcessRow
                key={app.key}
                app={app}
                routedGroup={routedGroupOf(app)}
                showTraffic={tab === 'traffic'}
                onPick={onPick}
              />
            ))}

        {!loading && !list.length && (
          <Box
            sx={{ textAlign: 'center', py: 6, px: 3, color: 'text.secondary' }}
          >
            <Typography variant="body2">
              {query
                ? t('process.picker.empty.search')
                : tab === 'traffic'
                  ? t('process.picker.empty.traffic')
                  : t('process.picker.empty.running')}
            </Typography>
            <Button
              size="small"
              startIcon={<FolderOpenRounded />}
              onClick={browse}
              sx={{ mt: 1.5 }}
            >
              {t('process.picker.browse')}
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  )
}

const CountBadge = ({ value }: { value: number }) => (
  <Box
    component="span"
    sx={{
      fontSize: 11,
      fontWeight: 600,
      px: 0.75,
      borderRadius: 10,
      bgcolor: 'action.selected',
      lineHeight: '18px',
    }}
  >
    {value}
  </Box>
)

interface RowProps {
  app: PickerApp
  routedGroup: IProcessRouteGroup | undefined
  showTraffic: boolean
  onPick: (app: ProcessApp) => void
}

const ProcessRow = memo(function ProcessRow({
  app,
  routedGroup,
  showTraffic,
  onPick,
}: RowProps) {
  const { t } = useTranslation()
  const routedColor = routedGroup?.color ?? GROUP_COLORS[0]

  return (
    <ButtonBase
      onClick={() => onPick(app)}
      sx={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        px: 1.25,
        py: 0.9,
        borderRadius: 2,
        textAlign: 'left',
        transition: 'background-color .15s',
        '& .pr-add': { opacity: 0, transform: 'scale(.8)' },
        '&:hover': {
          bgcolor: 'action.hover',
          '& .pr-add': { opacity: 1, transform: 'scale(1)' },
        },
      }}
    >
      <ProcessAvatar name={app.label} exe={app.exe} processName={app.name} />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Typography noWrap sx={{ fontSize: 13.5, fontWeight: 600 }}>
            {displayName(app.label)}
          </Typography>
          {app.pids.length > 1 && (
            <Typography
              sx={{ fontSize: 11, color: 'text.secondary', flexShrink: 0 }}
            >
              ×{app.pids.length}
            </Typography>
          )}
          {!!app.connections && (
            <Tooltip
              title={t('process.picker.connections', {
                count: app.connections,
              })}
            >
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  bgcolor: 'success.main',
                  flexShrink: 0,
                  boxShadow: (theme) =>
                    `0 0 0 3px ${alpha(theme.palette.success.main, 0.2)}`,
                }}
              />
            </Tooltip>
          )}
        </Box>
        <Typography
          noWrap
          title={app.exe ?? undefined}
          sx={{
            fontSize: 11,
            color: 'text.secondary',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          }}
        >
          {app.exe ? shortenPath(app.exe) : t('process.picker.noPath')}
        </Typography>
      </Box>

      {showTraffic && (
        <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
          <Typography sx={{ fontSize: 12, fontWeight: 600 }}>
            {formatBytes(app.traffic ?? 0)}
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
            {t('process.picker.connections', { count: app.connections ?? 0 })}
          </Typography>
        </Box>
      )}

      {routedGroup ? (
        <Chip
          size="small"
          label={routedGroup.name}
          sx={{
            maxWidth: 96,
            height: 22,
            fontSize: 11,
            fontWeight: 600,
            color: routedColor,
            bgcolor: alpha(routedColor, 0.14),
          }}
        />
      ) : (
        <Box
          className="pr-add"
          sx={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            bgcolor: 'primary.main',
            color: 'primary.contrastText',
            transition: 'opacity .15s, transform .15s',
            flexShrink: 0,
          }}
        >
          <AddRounded sx={{ fontSize: 18 }} />
        </Box>
      )}
    </ButtonBase>
  )
})
