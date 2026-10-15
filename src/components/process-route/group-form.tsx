import { CheckRounded } from '@mui/icons-material'
import { Box, ButtonBase, MenuItem, TextField } from '@mui/material'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useProxiesData } from '@/providers/app-data-context'

import type { GroupDraft } from './group-draft'
import { GROUP_COLORS } from './process-utils'

interface Props {
  draft: GroupDraft
  onChange: (draft: GroupDraft) => void
  groups: IProcessRouteGroup[]
  /** Group being edited, excluded from the duplicate-name check */
  editingId?: string
  autoFocus?: boolean
}

export const GroupForm = ({
  draft,
  onChange,
  groups,
  editingId,
  autoFocus,
}: Props) => {
  const { t } = useTranslation()
  const { proxyView } = useProxiesData()

  const generatedNames = useMemo(
    () =>
      new Set(
        groups.filter((group) => !group.target).map((group) => group.name),
      ),
    [groups],
  )
  const profileGroups = useMemo(
    () =>
      (proxyView?.groups ?? [])
        .filter((group) => !group.hidden && group.name !== 'GLOBAL')
        .map((group) => group.name)
        .filter((name) => !generatedNames.has(name)),
    [generatedNames, proxyView],
  )

  const name = draft.name.trim()
  const duplicate = groups.some(
    (group) => group.id !== editingId && group.name === name,
  )
  const sharesProfileName = !draft.target && profileGroups.includes(name)

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'flex-start' }}>
        <TextField
          autoFocus={autoFocus}
          fullWidth
          size="small"
          label={t('process.form.name')}
          value={draft.name}
          error={!name || duplicate || name.includes(',')}
          helperText={
            duplicate
              ? t('process.form.duplicate')
              : name.includes(',')
                ? t('process.form.comma')
                : sharesProfileName
                  ? t('process.form.reuseProfileGroup')
                  : ' '
          }
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          slotProps={{ input: { sx: { borderRadius: 2 } } }}
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', mt: -0.5 }}>
        {GROUP_COLORS.map((color) => (
          <ButtonBase
            key={color}
            aria-label={color}
            onClick={() => onChange({ ...draft, color })}
            sx={{
              width: 24,
              height: 24,
              borderRadius: '50%',
              bgcolor: color,
              color: '#fff',
              transition: 'transform .15s, box-shadow .15s',
              boxShadow:
                draft.color === color
                  ? `0 0 0 2px var(--mui-palette-background-paper, #fff), 0 0 0 4px ${color}`
                  : 'none',
              '&:hover': { transform: 'scale(1.12)' },
            }}
          >
            {draft.color === color && <CheckRounded sx={{ fontSize: 15 }} />}
          </ButtonBase>
        ))}
      </Box>

      <TextField
        select
        fullWidth
        size="small"
        label={t('process.form.exit')}
        value={draft.target}
        onChange={(event) => onChange({ ...draft, target: event.target.value })}
        helperText={
          draft.target
            ? t('process.form.exitExistingHint')
            : t('process.form.exitAutoHint')
        }
        slotProps={{
          input: { sx: { borderRadius: 2 } },
          // The empty value is the "create a group" option, not a missing value.
          inputLabel: { shrink: true },
          select: { displayEmpty: true },
        }}
      >
        <MenuItem value="">{t('process.form.exitAuto')}</MenuItem>
        {profileGroups.map((name) => (
          <MenuItem key={name} value={name}>
            {name}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  )
}
