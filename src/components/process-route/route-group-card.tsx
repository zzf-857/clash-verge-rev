import {
  AddRounded,
  CloseRounded,
  DeleteOutlineRounded,
  EditRounded,
  LinkRounded,
  MoreHorizRounded,
} from '@mui/icons-material'
import {
  Box,
  ButtonBase,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Switch } from '@/components/base'
import parseTraffic from '@/utils/parse-traffic'

import { ExitNodeSelect } from './exit-node-select'
import { ProcessAvatar } from './process-avatar'
import { GROUP_COLORS, matcherLabel, routePolicy } from './process-utils'

export interface GroupStats {
  connections: number
  traffic: number
}

interface Props {
  group: IProcessRouteGroup
  stats: GroupStats | undefined
  highlighted: boolean
  picking: boolean
  onChange: (patch: Partial<IProcessRouteGroup>) => void
  onRename: (name: string) => boolean
  onDelete: () => void
  onRemoveMatcher: (matcher: IProcessMatcher) => void
  onAddProcess: () => void
}

const KIND_LABEL: Record<ProcessMatchKind, string> = {
  'PROCESS-NAME': 'process.kinds.name',
  'PROCESS-PATH': 'process.kinds.path',
  'PROCESS-PATH-REGEX': 'process.kinds.dir',
}

export const RouteGroupCard = ({
  group,
  stats,
  highlighted,
  picking,
  onChange,
  onRename,
  onDelete,
  onRemoveMatcher,
  onAddProcess,
}: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const isDark = theme.palette.mode === 'dark'
  const accent = group.color ?? GROUP_COLORS[0]
  const enabled = group.enabled ?? true
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [colorAnchor, setColorAnchor] = useState<HTMLElement | null>(null)
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(group.name)
  const cardRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (highlighted) {
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [highlighted])

  const active = stats?.connections ?? 0
  const policy = routePolicy(group)

  const commitName = () => {
    const next = nameDraft.trim()
    if (next && next !== group.name && !onRename(next)) return
    setNameDraft(next || group.name)
    setEditing(false)
  }

  const closeMenu = () => {
    setMenuAnchor(null)
    setConfirmDelete(false)
  }

  return (
    <Box
      ref={cardRef}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
        p: 2,
        pt: 2.25,
        borderRadius: 3,
        overflow: 'hidden',
        bgcolor: isDark ? '#282a36' : '#ffffff',
        border: '1px solid',
        borderColor: picking ? accent : 'transparent',
        boxShadow: picking
          ? `0 0 0 3px ${alpha(accent, 0.18)}`
          : isDark
            ? 'none'
            : '0 1px 2px rgba(15,23,42,0.04)',
        transition:
          'box-shadow .25s, border-color .25s, transform .2s, opacity .2s',
        animation: highlighted ? 'pr-flash 1.2s ease' : 'none',
        '@keyframes pr-flash': {
          '0%': { boxShadow: `0 0 0 0 ${alpha(accent, 0.6)}` },
          '40%': { boxShadow: `0 0 0 6px ${alpha(accent, 0.25)}` },
          '100%': { boxShadow: `0 0 0 0 ${alpha(accent, 0)}` },
        },
        '&:hover': {
          transform: 'translateY(-1px)',
          boxShadow: picking
            ? `0 0 0 3px ${alpha(accent, 0.18)}`
            : isDark
              ? '0 6px 20px rgba(0,0,0,0.35)'
              : '0 8px 24px rgba(15,23,42,0.08)',
        },
        '&::before': {
          content: '""',
          position: 'absolute',
          inset: '0 0 auto 0',
          height: 3,
          background: `linear-gradient(90deg, ${accent}, ${alpha(accent, 0.35)})`,
          opacity: enabled ? 1 : 0.35,
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Tooltip title={t('process.group.color')}>
          <ButtonBase
            onClick={(event) => setColorAnchor(event.currentTarget)}
            sx={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              bgcolor: accent,
              flexShrink: 0,
              boxShadow: `0 0 0 4px ${alpha(accent, 0.18)}`,
            }}
          />
        </Tooltip>
        {editing ? (
          <TextField
            autoFocus
            size="small"
            variant="standard"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitName()
              if (event.key === 'Escape') {
                setNameDraft(group.name)
                setEditing(false)
              }
            }}
            sx={{ flex: 1, '& input': { fontWeight: 700, fontSize: 15 } }}
          />
        ) : (
          <Typography
            noWrap
            onDoubleClick={() => setEditing(true)}
            sx={{
              flex: 1,
              fontWeight: 700,
              fontSize: 15,
              opacity: enabled ? 1 : 0.55,
              cursor: 'text',
            }}
          >
            {group.name}
          </Typography>
        )}

        <StatusPill active={active} enabled={enabled} />

        <Tooltip
          title={enabled ? t('process.group.pause') : t('process.group.resume')}
        >
          <Switch
            checked={enabled}
            onChange={(_, checked) => onChange({ enabled: checked })}
            sx={{
              flexShrink: 0,
              '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': {
                backgroundColor: accent,
              },
            }}
          />
        </Tooltip>
        <IconButton
          size="small"
          onClick={(event: MouseEvent<HTMLElement>) =>
            setMenuAnchor(event.currentTarget)
          }
        >
          <MoreHorizRounded fontSize="small" />
        </IconButton>
      </Box>

      {group.target && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            mt: -1,
            color: 'text.secondary',
          }}
        >
          <LinkRounded sx={{ fontSize: 14 }} />
          <Typography sx={{ fontSize: 12 }} noWrap>
            {t('process.group.linked', { name: group.target })}
          </Typography>
        </Box>
      )}

      <Box sx={{ opacity: enabled ? 1 : 0.55, transition: 'opacity .2s' }}>
        <Typography
          sx={{
            fontSize: 12,
            color: 'text.secondary',
            mb: 0.75,
            fontWeight: 600,
          }}
        >
          {t('process.group.exit')}
        </Typography>
        <ExitNodeSelect
          groupName={policy}
          accent={accent}
          disabled={!enabled}
        />
      </Box>

      <Box sx={{ opacity: enabled ? 1 : 0.55, transition: 'opacity .2s' }}>
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            mb: 0.75,
          }}
        >
          <Typography
            sx={{ fontSize: 12, color: 'text.secondary', fontWeight: 600 }}
          >
            {t('process.group.processes')} · {group.matchers.length}
          </Typography>
          {!!stats?.traffic && (
            <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
              {parseTraffic(stats.traffic).join(' ')}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
          {group.matchers.map((matcher) => (
            <MatcherChip
              key={`${matcher.kind}:${matcher.value}`}
              matcher={matcher}
              onRemove={() => onRemoveMatcher(matcher)}
            />
          ))}
          <ButtonBase
            onClick={onAddProcess}
            sx={{
              height: 30,
              px: 1.25,
              gap: 0.5,
              borderRadius: 2,
              fontSize: 12.5,
              fontWeight: 600,
              color: picking ? accent : 'text.secondary',
              border: '1px dashed',
              borderColor: picking ? accent : 'divider',
              transition: 'all .15s',
              '&:hover': { color: accent, borderColor: accent },
            }}
          >
            <AddRounded sx={{ fontSize: 16 }} />
            {group.matchers.length
              ? t('process.group.addProcess')
              : t('process.group.emptyProcesses')}
          </ButtonBase>
        </Box>
      </Box>

      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={closeMenu}
        slotProps={{ paper: { sx: { borderRadius: 2, minWidth: 180 } } }}
      >
        <MenuItem
          onClick={() => {
            closeMenu()
            setNameDraft(group.name)
            setEditing(true)
          }}
        >
          <ListItemIcon>
            <EditRounded fontSize="small" />
          </ListItemIcon>
          {t('process.group.rename')}
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true)
              return
            }
            closeMenu()
            onDelete()
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon sx={{ color: 'inherit' }}>
            <DeleteOutlineRounded fontSize="small" />
          </ListItemIcon>
          {confirmDelete
            ? t('process.group.deleteConfirm')
            : t('process.group.delete')}
        </MenuItem>
      </Menu>

      <Menu
        anchorEl={colorAnchor}
        open={!!colorAnchor}
        onClose={() => setColorAnchor(null)}
        slotProps={{
          paper: { sx: { borderRadius: 2 } },
          list: { sx: { display: 'flex', gap: 0.75, px: 1, py: 0.75 } },
        }}
      >
        {GROUP_COLORS.map((color) => (
          <ButtonBase
            key={color}
            aria-label={color}
            onClick={() => {
              onChange({ color })
              setColorAnchor(null)
            }}
            sx={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              bgcolor: color,
              boxShadow:
                color === accent ? `0 0 0 2px ${alpha(color, 0.4)}` : 'none',
              transition: 'transform .15s',
              '&:hover': { transform: 'scale(1.15)' },
            }}
          />
        ))}
      </Menu>
    </Box>
  )
}

const StatusPill = ({
  active,
  enabled,
}: {
  active: number
  enabled: boolean
}) => {
  const { t } = useTranslation()
  const live = enabled && active > 0
  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.6,
        px: 1,
        height: 22,
        borderRadius: 11,
        fontSize: 11.5,
        fontWeight: 600,
        flexShrink: 0,
        color: live ? 'success.main' : 'text.secondary',
        bgcolor: (theme) =>
          live
            ? alpha(theme.palette.success.main, 0.12)
            : theme.palette.action.hover,
      }}
    >
      <Box
        sx={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          bgcolor: 'currentColor',
          animation: live ? 'pr-pulse 1.6s ease-in-out infinite' : 'none',
          '@keyframes pr-pulse': {
            '0%, 100%': { opacity: 1 },
            '50%': { opacity: 0.3 },
          },
        }}
      />
      {!enabled
        ? t('process.group.paused')
        : live
          ? t('process.group.connections', { count: active })
          : t('process.group.idle')}
    </Box>
  )
}

const MatcherChip = ({
  matcher,
  onRemove,
}: {
  matcher: IProcessMatcher
  onRemove: () => void
}) => {
  const { t } = useTranslation()
  const label = matcherLabel(matcher)
  return (
    <Tooltip
      title={
        <Box>
          <Box sx={{ fontWeight: 700 }}>{t(KIND_LABEL[matcher.kind])}</Box>
          <Box
            sx={{
              fontFamily: 'ui-monospace, monospace',
              wordBreak: 'break-all',
            }}
          >
            {matcher.value}
          </Box>
        </Box>
      }
    >
      <Box
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          height: 30,
          pl: 0.5,
          pr: 0.25,
          borderRadius: 2,
          bgcolor: 'action.hover',
          maxWidth: '100%',
          animation: 'pr-chip-in .2s ease',
          '@keyframes pr-chip-in': {
            from: { opacity: 0, transform: 'scale(.9)' },
          },
          '& .pr-remove': { opacity: 0.4 },
          '&:hover .pr-remove': { opacity: 1 },
        }}
      >
        <ProcessAvatar
          name={label}
          size={22}
          folder={matcher.kind === 'PROCESS-PATH-REGEX'}
        />
        <Typography
          noWrap
          sx={{ fontSize: 12.5, fontWeight: 500, maxWidth: 140 }}
        >
          {label}
        </Typography>
        <IconButton
          className="pr-remove"
          size="small"
          onClick={onRemove}
          sx={{ p: 0.25, transition: 'opacity .15s' }}
        >
          <CloseRounded sx={{ fontSize: 14 }} />
        </IconButton>
      </Box>
    </Tooltip>
  )
}
