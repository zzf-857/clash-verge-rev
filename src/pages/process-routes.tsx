import {
  AddRounded,
  AltRouteRounded,
  CheckCircleRounded,
  RuleRounded,
  ShieldRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'

import { BasePage } from '@/components/base'
import {
  type AddProcessResult,
  AddProcessDialog,
} from '@/components/process-route/add-process-dialog'
import { configuredProcessMatchers } from '@/components/process-route/configured-matchers'
import {
  mergeProcessRouteGroups,
  updateProcessRouteGroups,
} from '@/components/process-route/existing-groups'
import {
  isDraftValid,
  useGroupDraft,
} from '@/components/process-route/group-draft'
import { GroupForm } from '@/components/process-route/group-form'
import { ProcessPicker } from '@/components/process-route/process-picker'
import {
  GROUP_COLORS,
  type ProcessApp,
  type ProcessPickState,
  appKey,
  createGroupId,
  groupProcesses,
  routePolicy,
  sameMatcher,
} from '@/components/process-route/process-utils'
import {
  type GroupStats,
  RouteGroupCard,
} from '@/components/process-route/route-group-card'
import { useProcessRouteGroups } from '@/components/process-route/use-process-route-groups'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useSystemState } from '@/hooks/use-system-state'
import { useVerge } from '@/hooks/use-verge'
import { useVisibility } from '@/hooks/use-visibility'
import {
  useAppRefreshers,
  useClashConfigData,
  useProxiesData,
  useRulesData,
} from '@/providers/app-data-context'
import { listProcesses, patchClashMode } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'
import { requestService } from '@/services/service-request'

const ProcessRoutesPage = () => {
  const { t } = useTranslation()
  const theme = useTheme()
  const pageVisible = useVisibility()
  const {
    groups: storedGroups,
    saving,
    updateGroups: updateStoredGroups,
  } = useProcessRouteGroups()
  const { verge, mutateVerge, patchVerge } = useVerge()
  const { isTunModeAvailable } = useSystemState()
  const { clashConfig } = useClashConfigData()
  const { refreshClashConfig } = useAppRefreshers()
  const { proxyView } = useProxiesData()
  const runtimeGroups = proxyView?.groups
  const { rules } = useRulesData()
  const groupItems = useMemo(
    () => mergeProcessRouteGroups(storedGroups, runtimeGroups ?? []),
    [storedGroups, runtimeGroups],
  )
  const groups = useMemo(
    () => groupItems.map((item) => item.group),
    [groupItems],
  )
  const configuredMatchers = useMemo(
    () => configuredProcessMatchers(rules, storedGroups),
    [rules, storedGroups],
  )
  const pickerGroups = useMemo(
    () =>
      groups.map((group) => ({
        ...group,
        matchers: [
          ...(group.enabled === false ? [] : group.matchers),
          ...(configuredMatchers.get(routePolicy(group)) ?? []),
        ],
      })),
    [groups, configuredMatchers],
  )
  const existingGroupIds = useMemo(
    () =>
      new Set(
        groupItems
          .filter((item) => item.source === 'runtime')
          .map((item) => item.group.id),
      ),
    [groupItems],
  )
  const updateGroups = useCallback(
    (updater: (groups: IProcessRouteGroup[]) => IProcessRouteGroup[]) =>
      updateStoredGroups((previous) =>
        updateProcessRouteGroups(previous, runtimeGroups ?? [], updater),
      ),
    [runtimeGroups, updateStoredGroups],
  )

  const [processes, setProcesses] = useState<IProcessEntry[]>()
  const [loading, setLoading] = useState(false)
  const [pickedApp, setPickedApp] = useState<ProcessApp | null>(null)
  const [targetGroupId, setTargetGroupId] = useState<string | null>(null)
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const refresh = useLockFn(async () => {
    setLoading(true)
    try {
      setProcesses(await listProcesses())
    } catch (error) {
      showNotice.error(error)
    } finally {
      setLoading(false)
    }
  })

  useEffect(() => {
    if (pageVisible) void refresh()
  }, [pageVisible, refresh])

  // Opened from a connection's detail: resolve the process once the list is loaded.
  const location = useLocation()
  const navigate = useNavigate()
  const [pickRequest, setPickRequest] = useState(
    () => (location.state as ProcessPickState | null)?.pick ?? null,
  )
  useEffect(() => {
    if (location.state)
      navigate(location.pathname, { replace: true, state: null })
  }, [location.pathname, location.state, navigate])
  const requestedApp = useMemo<ProcessApp | null>(() => {
    if (!pickRequest || !processes) return null
    const key = appKey(pickRequest.name, pickRequest.exe)
    return (
      groupProcesses(processes).get(key) ?? {
        key,
        name: pickRequest.name,
        label: pickRequest.name,
        exe: pickRequest.exe,
        pids: [],
        memory: 0,
      }
    )
  }, [pickRequest, processes])
  const dialogApp = pickedApp ?? requestedApp

  useEffect(() => {
    if (!highlightId) return
    const timer = setTimeout(() => setHighlightId(null), 1400)
    return () => clearTimeout(timer)
  }, [highlightId])

  const {
    response: { data: connData },
  } = useConnectionData()
  const stats = useMemo(() => {
    const map = new Map<string, GroupStats>()
    for (const group of groups) {
      map.set(group.id, { connections: 0, traffic: 0, up: 0, down: 0 })
    }
    for (const conn of connData.activeConnections) {
      for (const group of groups) {
        if (conn.chains.includes(routePolicy(group))) {
          const entry = map.get(group.id)!
          entry.connections += 1
          entry.traffic += conn.upload + conn.download
          entry.up += conn.curUpload ?? 0
          entry.down += conn.curDownload ?? 0
        }
      }
    }
    return map
  }, [connData.activeConnections, groups])

  const targetGroup = groups.find((group) => group.id === targetGroupId) ?? null

  const handleConfirm = useCallback(
    ({ groupId, draft, matchers }: AddProcessResult) => {
      const id = groupId ?? createGroupId()
      const name = draft?.name.trim() ?? ''
      updateGroups((prev) => {
        // A process belongs to one group; the first matching rule would win anyway.
        const stripped = prev.map((group) => ({
          ...group,
          matchers: group.matchers.filter(
            (existing) =>
              !matchers.some((matcher) => sameMatcher(existing, matcher)),
          ),
        }))
        if (groupId) {
          return stripped.map((group) =>
            group.id === groupId
              ? { ...group, matchers: [...group.matchers, ...matchers] }
              : group,
          )
        }
        return [
          ...stripped,
          {
            id,
            name,
            color: draft?.color,
            target: draft?.target || null,
            enabled: true,
            matchers,
          },
        ]
      })
      const groupName = groupId
        ? (groups.find((group) => group.id === groupId)?.name ?? '')
        : name
      showNotice.success('process.notice.added', {
        count: matchers.length,
        name: groupName,
      })
      setHighlightId(id)
      setTargetGroupId(null)
    },
    [groups, updateGroups],
  )

  const patchGroup = (id: string, patch: Partial<IProcessRouteGroup>) =>
    updateGroups((prev) =>
      prev.map((group) => (group.id === id ? { ...group, ...patch } : group)),
    )

  const renameGroup = (id: string, name: string) => {
    if (
      name.includes(',') ||
      groups.some((group) => group.id !== id && group.name === name)
    ) {
      showNotice.error('process.form.duplicate')
      return false
    }
    patchGroup(id, { name })
    return true
  }

  const enableTun = async () => {
    if (!isTunModeAvailable) {
      requestService({
        reason: 'tunNeedsService',
        restore: { enable_tun_mode: true },
      })
      return
    }
    mutateVerge({ ...verge, enable_tun_mode: true }, false)
    await patchVerge({ enable_tun_mode: true })
  }

  const switchToRule = useLockFn(async () => {
    try {
      await patchClashMode('rule')
      await refreshClashConfig()
    } catch (error) {
      showNotice.error(error)
    }
  })

  const tunOn = !!verge?.enable_tun_mode && isTunModeAvailable
  const mode = clashConfig?.mode?.toLowerCase()

  return (
    <BasePage
      full
      title={t('process.page.title')}
      contentStyle={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
          <SaveIndicator saving={saving} hasGroups={groups.length > 0} />
          <Button
            size="small"
            variant="contained"
            disableElevation
            startIcon={<AddRounded />}
            onClick={() => setCreating(true)}
            sx={{ borderRadius: 2, textTransform: 'none' }}
          >
            {t('process.page.actions.newGroup')}
          </Button>
        </Box>
      }
    >
      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: 'minmax(300px, 380px) 1fr' },
          gridTemplateRows: { xs: 'minmax(320px, 45%) 1fr', md: '1fr' },
          gap: 1.5,
          p: 1.5,
        }}
      >
        <ProcessPicker
          processes={processes}
          loading={loading}
          groups={pickerGroups}
          targetGroup={targetGroup}
          onRefresh={refresh}
          onClearTarget={() => setTargetGroupId(null)}
          onPick={setPickedApp}
        />

        <Box sx={{ minHeight: 0, overflowY: 'auto', pr: 0.5 }}>
          {mode && mode !== 'rule' && (
            <Banner
              icon={<RuleRounded />}
              color={theme.palette.error.main}
              title={t('process.banner.mode.title', { mode })}
              desc={t('process.banner.mode.desc')}
              action={t('process.banner.mode.action')}
              onAction={switchToRule}
            />
          )}
          {!tunOn && (
            <Banner
              icon={<ShieldRounded />}
              color={theme.palette.warning.main}
              title={t('process.banner.tun.title')}
              desc={t('process.banner.tun.desc')}
              action={t('process.banner.tun.action')}
              onAction={enableTun}
            />
          )}

          {groups.length ? (
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
                gap: 1.5,
                alignItems: 'start',
              }}
            >
              {groups.map((group) => (
                <RouteGroupCard
                  key={group.id}
                  group={group}
                  existingGroup={existingGroupIds.has(group.id)}
                  configuredMatchers={configuredMatchers.get(
                    routePolicy(group),
                  )}
                  stats={stats.get(group.id)}
                  highlighted={highlightId === group.id}
                  picking={targetGroupId === group.id}
                  onChange={(patch) => patchGroup(group.id, patch)}
                  onRename={(name) => renameGroup(group.id, name)}
                  onDelete={() =>
                    updateGroups((prev) =>
                      prev.filter((item) => item.id !== group.id),
                    )
                  }
                  onRemoveMatcher={(matcher) =>
                    patchGroup(group.id, {
                      matchers: group.matchers.filter(
                        (existing) => !sameMatcher(existing, matcher),
                      ),
                    })
                  }
                  onAddProcess={() =>
                    setTargetGroupId((current) =>
                      current === group.id ? null : group.id,
                    )
                  }
                />
              ))}
            </Box>
          ) : (
            <EmptyState onCreate={() => setCreating(true)} />
          )}
        </Box>
      </Box>

      {dialogApp && (
        <AddProcessDialog
          // Remount per app so selections never leak between processes.
          key={dialogApp.key}
          app={dialogApp}
          processes={processes ?? []}
          groups={pickerGroups}
          defaultGroupId={targetGroupId}
          onClose={() => {
            setPickedApp(null)
            setPickRequest(null)
          }}
          onConfirm={handleConfirm}
        />
      )}

      {creating && (
        <NewGroupDialog
          groups={groups}
          onClose={() => setCreating(false)}
          onCreate={(group) => {
            updateGroups((prev) => [...prev, group])
            setHighlightId(group.id)
            setTargetGroupId(group.id)
          }}
        />
      )}
    </BasePage>
  )
}

const SaveIndicator = ({
  saving,
  hasGroups,
}: {
  saving: boolean
  hasGroups: boolean
}) => {
  const { t } = useTranslation()
  if (!saving && !hasGroups) return null
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.75,
        fontSize: 12.5,
        color: saving ? 'text.secondary' : 'success.main',
        transition: 'color .2s',
      }}
    >
      {saving ? (
        <CircularProgress size={12} thickness={5} color="inherit" />
      ) : (
        <CheckCircleRounded sx={{ fontSize: 15 }} />
      )}
      {saving
        ? t('process.page.status.applying')
        : t('process.page.status.applied')}
    </Box>
  )
}

interface BannerProps {
  icon: React.ReactNode
  color: string
  title: string
  desc: string
  action: string
  onAction: () => void
}

const Banner = ({
  icon,
  color,
  title,
  desc,
  action,
  onAction,
}: BannerProps) => (
  <Alert
    icon={icon}
    action={
      <Button
        size="small"
        onClick={onAction}
        sx={{ color, fontWeight: 700, whiteSpace: 'nowrap' }}
      >
        {action}
      </Button>
    }
    sx={{
      mb: 1.5,
      borderRadius: 3,
      alignItems: 'center',
      color: 'text.primary',
      bgcolor: alpha(color, 0.1),
      border: `1px solid ${alpha(color, 0.25)}`,
      '& .MuiAlert-icon': { color },
    }}
  >
    <Typography sx={{ fontSize: 13.5, fontWeight: 700 }}>{title}</Typography>
    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
      {desc}
    </Typography>
  </Alert>
)

const EmptyState = ({ onCreate }: { onCreate: () => void }) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 320,
        borderRadius: 3,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        gap: 1.5,
        px: 4,
        bgcolor: isDark ? '#282a36' : '#ffffff',
        border: '1.5px dashed',
        borderColor: 'divider',
      }}
    >
      <Box sx={{ position: 'relative', mb: 1 }}>
        {GROUP_COLORS.slice(0, 3).map((color, index) => (
          <Box
            key={color}
            sx={{
              position: 'absolute',
              width: 18,
              height: 18,
              borderRadius: 1,
              bgcolor: color,
              opacity: 0.85,
              top: [-6, 30, 52][index],
              left: [-34, -44, 68][index],
              transform: `rotate(${[-12, 8, 14][index]}deg)`,
              animation: `pr-float ${3 + index}s ease-in-out infinite`,
              '@keyframes pr-float': {
                '0%, 100%': { translate: '0 0' },
                '50%': { translate: '0 -6px' },
              },
            }}
          />
        ))}
        <Box
          sx={{
            width: 72,
            height: 72,
            borderRadius: 4,
            display: 'grid',
            placeItems: 'center',
            color: 'primary.main',
            bgcolor: alpha(theme.palette.primary.main, 0.12),
          }}
        >
          <AltRouteRounded sx={{ fontSize: 38 }} />
        </Box>
      </Box>
      <Typography sx={{ fontWeight: 700, fontSize: 17 }}>
        {t('process.empty.title')}
      </Typography>
      <Typography sx={{ color: 'text.secondary', fontSize: 13, maxWidth: 380 }}>
        {t('process.empty.desc')}
      </Typography>
      <Button
        variant="outlined"
        startIcon={<AddRounded />}
        onClick={onCreate}
        sx={{ mt: 1, borderRadius: 2, textTransform: 'none' }}
      >
        {t('process.page.actions.newGroup')}
      </Button>
    </Box>
  )
}

const NewGroupDialog = ({
  groups,
  onClose,
  onCreate,
}: {
  groups: IProcessRouteGroup[]
  onClose: () => void
  onCreate: (group: IProcessRouteGroup) => void
}) => {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const usedColors = new Set(groups.map((group) => group.color))
  const [draft, setDraft] = useGroupDraft({
    color: GROUP_COLORS.find((color) => !usedColors.has(color)),
  })
  const valid = isDraftValid(draft, groups)

  const submit = () => {
    if (!valid) return
    onCreate({
      id: createGroupId(),
      name: draft.name.trim(),
      color: draft.color,
      target: draft.target || null,
      enabled: true,
      matchers: [],
    })
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      fullWidth
      maxWidth="xs"
      slotProps={{
        transition: { onExited: onClose },
        paper: { sx: { borderRadius: 3 } },
      }}
    >
      <DialogTitle sx={{ fontWeight: 700 }}>
        {t('process.page.actions.newGroup')}
      </DialogTitle>
      <DialogContent>
        <Box
          component="form"
          sx={{ pt: 1 }}
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <GroupForm
            draft={draft}
            onChange={setDraft}
            groups={groups}
            autoFocus
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button color="inherit" onClick={() => setOpen(false)}>
          {t('process.dialog.cancel')}
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={!valid}
          onClick={submit}
          sx={{
            borderRadius: 2,
            bgcolor: draft.color,
            '&:hover': { bgcolor: draft.color },
          }}
        >
          {t('process.form.create')}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

export default ProcessRoutesPage
