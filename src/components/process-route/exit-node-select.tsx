import {
  CheckRounded,
  ExpandMoreRounded,
  NetworkCheckRounded,
  SearchRounded,
} from '@mui/icons-material'
import {
  Box,
  ButtonBase,
  Chip,
  IconButton,
  InputAdornment,
  Popover,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'

import { useProxySelection } from '@/hooks/use-proxy-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import delayManager from '@/services/delay'
import {
  type InteractableProxyMember,
  type ProxyGroupView,
  isInteractableMember,
  memberDetails,
  resolveMember,
} from '@/types/proxy-view'

const PRESET = new Set(['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS'])

const useGroupDelays = (group: string) =>
  useSyncExternalStore(
    (listener) => delayManager.addGroupListener(group, listener),
    () => delayManager.groupDelays(group),
  )

const DelayChip = ({ delay }: { delay: number }) => {
  if (delay < 0) return null
  return (
    <Chip
      size="small"
      label={delayManager.formatDelay(delay)}
      sx={{
        height: 20,
        fontSize: 11,
        fontWeight: 600,
        color: delayManager.formatDelayColor(delay),
        bgcolor: 'transparent',
        border: '1px solid currentColor',
        '& .MuiChip-label': { px: 0.75 },
      }}
    />
  )
}

interface Props {
  groupName: string
  accent: string
  disabled?: boolean
}

export const ExitNodeSelect = ({ groupName, accent, disabled }: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const { verge } = useVerge()
  const { changeProxy } = useProxySelection({ onSuccess: refreshProxy })
  const anchorRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const delays = useGroupDelays(groupName)

  const group: ProxyGroupView | undefined = proxyView?.groups.find(
    (item) => item.name === groupName,
  )

  const members = useMemo<InteractableProxyMember[]>(() => {
    if (!proxyView || !group) return []
    return group.members
      .map((ref) => resolveMember(proxyView, ref))
      .filter(isInteractableMember)
  }, [proxyView, group])

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return members
    return members.filter((member) =>
      member.ref.name.toLowerCase().includes(keyword),
    )
  }, [members, query])

  const delayOf = (member: InteractableProxyMember) => delays.of(member)

  const testAll = useLockFn(async () => {
    const targets = members.filter((member) => !PRESET.has(member.ref.name))
    if (!targets.length) return
    await delayManager.checkListDelay(
      targets,
      groupName,
      verge?.default_latency_timeout || 10000,
    )
  })

  if (!group) {
    return (
      <Box sx={{ px: 1.5, py: 1.25, borderRadius: 2, bgcolor: 'action.hover' }}>
        <Skeleton width="60%" height={22} />
        <Typography variant="caption" color="text.secondary">
          {t('process.group.applying')}
        </Typography>
      </Box>
    )
  }

  const selectable = group.type.toLowerCase() === 'selector'
  const current = members.find((member) => member.ref.name === group.now)
  const currentDetails = current ? memberDetails(current) : undefined

  return (
    <>
      <ButtonBase
        ref={anchorRef}
        disabled={disabled || !selectable}
        onClick={() => setOpen(true)}
        sx={{
          width: '100%',
          justifyContent: 'space-between',
          textAlign: 'left',
          gap: 1,
          px: 1.5,
          py: 1,
          borderRadius: 2,
          border: '1px solid',
          borderColor: open ? accent : 'divider',
          bgcolor: alpha(accent, theme.palette.mode === 'dark' ? 0.1 : 0.05),
          transition: 'border-color .2s, background-color .2s, transform .1s',
          '&:hover': {
            borderColor: accent,
            bgcolor: alpha(accent, theme.palette.mode === 'dark' ? 0.16 : 0.09),
          },
          '&:active': { transform: 'scale(0.995)' },
        }}
      >
        <Box sx={{ minWidth: 0 }}>
          <Typography
            noWrap
            sx={{ fontWeight: 600, fontSize: 14, lineHeight: 1.4 }}
          >
            {group.now || '—'}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap>
            {selectable
              ? (currentDetails?.type ?? t('process.group.exit'))
              : t('process.group.controlledBy', { type: group.type })}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {current && <DelayChip delay={delayOf(current)} />}
          {selectable && (
            <ExpandMoreRounded
              sx={{
                color: 'text.secondary',
                transition: 'transform .2s',
                transform: open ? 'rotate(180deg)' : 'none',
              }}
            />
          )}
        </Box>
      </ButtonBase>

      <Popover
        open={open}
        anchorEl={anchorRef.current}
        onClose={() => {
          setOpen(false)
          setQuery('')
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              width: Math.max(anchorRef.current?.offsetWidth ?? 0, 300),
              maxHeight: 420,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 2.5,
            },
          },
        }}
      >
        <Box sx={{ display: 'flex', gap: 1, p: 1, alignItems: 'center' }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            value={query}
            placeholder={t('process.group.searchNode')}
            onChange={(event) => setQuery(event.target.value)}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchRounded fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />
          <Tooltip title={t('process.group.testDelay')}>
            <IconButton size="small" onClick={testAll}>
              <NetworkCheckRounded fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <Box sx={{ overflowY: 'auto', px: 0.75, pb: 0.75 }}>
          {filtered.map((member) => {
            const name = member.ref.name
            const active = name === group.now
            const details = memberDetails(member)
            return (
              <ButtonBase
                key={`${member.kind}:${name}`}
                onClick={() => {
                  changeProxy(groupName, name, group.now, group.fixed)
                  setOpen(false)
                  setQuery('')
                }}
                sx={{
                  width: '100%',
                  justifyContent: 'space-between',
                  gap: 1,
                  px: 1.25,
                  py: 0.85,
                  borderRadius: 1.5,
                  textAlign: 'left',
                  bgcolor: active ? alpha(accent, 0.12) : 'transparent',
                  '&:hover': {
                    bgcolor: active ? alpha(accent, 0.16) : 'action.hover',
                  },
                }}
              >
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    minWidth: 0,
                  }}
                >
                  <CheckRounded
                    sx={{
                      fontSize: 16,
                      color: accent,
                      visibility: active ? 'visible' : 'hidden',
                    }}
                  />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography
                      noWrap
                      sx={{ fontSize: 13, fontWeight: active ? 600 : 400 }}
                    >
                      {name}
                    </Typography>
                    {details?.type && (
                      <Typography
                        noWrap
                        sx={{ fontSize: 11, color: 'text.secondary' }}
                      >
                        {details.type}
                      </Typography>
                    )}
                  </Box>
                </Box>
                {!PRESET.has(name) && <DelayChip delay={delayOf(member)} />}
              </ButtonBase>
            )
          })}
          {!filtered.length && (
            <Typography
              variant="body2"
              color="text.secondary"
              sx={{ textAlign: 'center', py: 3 }}
            >
              {t('process.group.noNodes')}
            </Typography>
          )}
        </Box>
      </Popover>
    </>
  )
}
