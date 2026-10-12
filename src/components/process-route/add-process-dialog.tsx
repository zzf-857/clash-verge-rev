import {
  AccountTreeRounded,
  AddRounded,
  CheckCircleRounded,
  DescriptionRounded,
  FolderRounded,
  TextFieldsRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { type GroupDraft, isDraftValid, useGroupDraft } from './group-draft'
import { GroupForm } from './group-form'
import { ProcessAvatar } from './process-avatar'
import {
  GROUP_COLORS,
  type MatchMode,
  type ProcessApp,
  buildMatcher,
  defaultMatchMode,
  displayName,
  findRelatedApps,
  installDirOf,
  isGenericRuntime,
  routePolicy,
  shortenPath,
} from './process-utils'

export interface AddProcessResult {
  groupId: string | null
  draft: GroupDraft | null
  matchers: IProcessMatcher[]
}

interface Props {
  app: ProcessApp
  processes: IProcessEntry[]
  groups: IProcessRouteGroup[]
  defaultGroupId: string | null
  onClose: () => void
  onConfirm: (result: AddProcessResult) => void
}

const NEW_GROUP = '__new__'

const SectionTitle = ({
  children,
  action,
}: {
  children: ReactNode
  action?: ReactNode
}) => (
  <Box
    sx={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      mt: 2.5,
      mb: 1,
    }}
  >
    <Typography
      sx={{
        fontSize: 12,
        fontWeight: 700,
        letterSpacing: 0.4,
        color: 'text.secondary',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </Typography>
    {action}
  </Box>
)

export const AddProcessDialog = ({
  app,
  processes,
  groups,
  defaultGroupId,
  onClose,
  onConfirm,
}: Props) => {
  const { t } = useTranslation()
  const theme = useTheme()
  const [open, setOpen] = useState(true)
  const [mode, setMode] = useState<MatchMode>(() => defaultMatchMode(app))
  const related = useMemo(
    () => findRelatedApps(app, processes),
    [app, processes],
  )
  const [checked, setChecked] = useState(
    () =>
      new Set(related.filter((item) => !item.generic).map((item) => item.key)),
  )
  const [groupId, setGroupId] = useState(
    () => defaultGroupId ?? groups[0]?.id ?? NEW_GROUP,
  )
  const usedColors = new Set(groups.map((group) => group.color))
  const [draft, setDraft] = useGroupDraft({
    name: displayName(app.label),
    color:
      GROUP_COLORS.find((color) => !usedColors.has(color)) ?? GROUP_COLORS[0],
  })

  const installDir = installDirOf(app.exe)
  const generic = isGenericRuntime(app.label)
  const isNew = groupId === NEW_GROUP
  const selectedGroup = groups.find((group) => group.id === groupId)
  const accent = isNew ? draft.color : (selectedGroup?.color ?? GROUP_COLORS[0])
  const policy = isNew
    ? draft.target || draft.name.trim() || '…'
    : selectedGroup
      ? routePolicy(selectedGroup)
      : '…'

  const coveredByDir = (item: ProcessApp) =>
    mode === 'dir' &&
    !!installDir &&
    !!item.exe &&
    item.exe.startsWith(installDir)

  const matchers = [
    buildMatcher(app, mode),
    ...related
      .filter((item) => checked.has(item.key) && !coveredByDir(item))
      .map((item) => buildMatcher(item, 'path')),
  ]

  const draftError = isNew && !isDraftValid(draft, groups)
  const close = () => setOpen(false)

  const confirm = () => {
    if (draftError) return
    onConfirm({
      groupId: isNew ? null : groupId,
      draft: isNew ? draft : null,
      matchers,
    })
    close()
  }

  const toggle = (key: string) =>
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const modeOptions: {
    value: MatchMode
    icon: ReactNode
    disabled: boolean
  }[] = [
    { value: 'path', icon: <DescriptionRounded />, disabled: !app.exe },
    { value: 'name', icon: <TextFieldsRounded />, disabled: false },
    { value: 'dir', icon: <FolderRounded />, disabled: !installDir },
  ]

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="sm"
      slotProps={{
        transition: { onExited: onClose },
        paper: { sx: { borderRadius: 3, overflow: 'hidden' } },
      }}
    >
      <Box
        sx={{
          px: 3,
          pt: 3,
          pb: 2,
          display: 'flex',
          gap: 2,
          alignItems: 'center',
          background: `linear-gradient(135deg, ${alpha(accent, 0.16)}, transparent 70%)`,
          transition: 'background .3s',
        }}
      >
        <ProcessAvatar name={app.label} size={48} />
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 18, fontWeight: 700 }} noWrap>
            {displayName(app.label)}
          </Typography>
          <Typography
            title={app.exe ?? undefined}
            noWrap
            sx={{
              fontSize: 12,
              color: 'text.secondary',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            {app.exe ? shortenPath(app.exe, 64) : t('process.picker.noPath')}
          </Typography>
          {app.pids.length > 0 && (
            <Typography
              sx={{ fontSize: 12, color: 'text.secondary', mt: 0.25 }}
            >
              {t('process.dialog.instances', { count: app.pids.length })}
            </Typography>
          )}
        </Box>
      </Box>

      <DialogContent sx={{ pt: 0.5 }}>
        {generic && (
          <Alert
            severity="warning"
            icon={<WarningAmberRounded />}
            sx={{ borderRadius: 2, mt: 1 }}
          >
            {t('process.dialog.genericWarning', {
              name: displayName(app.label),
            })}
          </Alert>
        )}

        <SectionTitle>{t('process.dialog.match.title')}</SectionTitle>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 1,
          }}
        >
          {modeOptions.map((option) => {
            const active = mode === option.value
            return (
              <ButtonBase
                key={option.value}
                disabled={option.disabled}
                onClick={() => setMode(option.value)}
                sx={{
                  position: 'relative',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  gap: 0.5,
                  p: 1.25,
                  borderRadius: 2,
                  border: '1.5px solid',
                  borderColor: active ? accent : 'divider',
                  bgcolor: active ? alpha(accent, 0.08) : 'transparent',
                  opacity: option.disabled ? 0.45 : 1,
                  transition: 'all .2s',
                  '&:hover': { borderColor: active ? accent : 'text.disabled' },
                  '& > svg:first-of-type': {
                    color: active ? accent : 'text.secondary',
                    fontSize: 20,
                  },
                }}
              >
                {option.icon}
                <Typography sx={{ fontSize: 13, fontWeight: 600 }}>
                  {t(`process.dialog.match.${option.value}.label`)}
                </Typography>
                <Typography
                  sx={{
                    fontSize: 11,
                    color: 'text.secondary',
                    lineHeight: 1.35,
                  }}
                >
                  {t(`process.dialog.match.${option.value}.desc`)}
                </Typography>
                {active && (
                  <CheckCircleRounded
                    sx={{
                      position: 'absolute',
                      top: 8,
                      right: 8,
                      fontSize: 16,
                      color: accent,
                      animation: 'pr-pop .2s ease',
                      '@keyframes pr-pop': { from: { transform: 'scale(0)' } },
                    }}
                  />
                )}
              </ButtonBase>
            )
          })}
        </Box>

        <SectionTitle
          action={
            related.length > 0 && (
              <Button
                size="small"
                onClick={() =>
                  setChecked(
                    checked.size === related.length
                      ? new Set()
                      : new Set(related.map((item) => item.key)),
                  )
                }
              >
                {checked.size === related.length
                  ? t('process.dialog.related.clear')
                  : t('process.dialog.related.selectAll')}
              </Button>
            )
          }
        >
          <Box
            component="span"
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}
          >
            <AccountTreeRounded sx={{ fontSize: 15 }} />
            {t('process.dialog.related.title')}
            {related.length > 0 && ` · ${related.length}`}
          </Box>
        </SectionTitle>
        {related.length ? (
          <Box
            sx={{
              border: '1px solid',
              borderColor: 'divider',
              borderRadius: 2,
              maxHeight: 200,
              overflowY: 'auto',
            }}
          >
            {related.map((item, index) => {
              const covered = coveredByDir(item)
              return (
                <Box
                  key={item.key}
                  component="label"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    px: 1,
                    py: 0.5,
                    cursor: covered ? 'default' : 'pointer',
                    borderTop: index ? '1px solid' : 0,
                    borderColor: 'divider',
                    '&:hover': {
                      bgcolor: covered ? undefined : 'action.hover',
                    },
                  }}
                >
                  <Checkbox
                    size="small"
                    checked={covered || checked.has(item.key)}
                    disabled={covered}
                    onChange={() => toggle(item.key)}
                    sx={{ '&.Mui-checked': { color: accent } }}
                  />
                  <ProcessAvatar name={item.label} size={24} />
                  <Box sx={{ minWidth: 0, flex: 1 }}>
                    <Typography noWrap sx={{ fontSize: 13, fontWeight: 500 }}>
                      {displayName(item.label)}
                    </Typography>
                    <Typography
                      noWrap
                      sx={{
                        fontSize: 11,
                        color: 'text.secondary',
                        fontFamily:
                          'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                      }}
                    >
                      {item.exe ? shortenPath(item.exe, 48) : item.name}
                    </Typography>
                  </Box>
                  {item.generic && (
                    <Tooltip title={t('process.dialog.related.generic')}>
                      <WarningAmberRounded
                        sx={{ fontSize: 18, color: 'warning.main' }}
                      />
                    </Tooltip>
                  )}
                  <Chip
                    size="small"
                    label={
                      covered
                        ? t('process.dialog.related.covered')
                        : t(`process.dialog.related.${item.relation}`)
                    }
                    sx={{
                      height: 20,
                      fontSize: 11,
                      bgcolor: alpha(
                        item.relation === 'child'
                          ? theme.palette.info.main
                          : theme.palette.secondary.main,
                        0.12,
                      ),
                    }}
                  />
                </Box>
              )
            })}
          </Box>
        ) : (
          <Typography
            sx={{
              fontSize: 12.5,
              color: 'text.secondary',
              px: 1.5,
              py: 1.25,
              borderRadius: 2,
              border: '1px dashed',
              borderColor: 'divider',
            }}
          >
            {app.pids.length
              ? t('process.dialog.related.none')
              : t('process.dialog.related.notRunning')}
          </Typography>
        )}

        <SectionTitle>{t('process.dialog.group.title')}</SectionTitle>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {groups.map((group) => {
            const color = group.color ?? GROUP_COLORS[0]
            const active = group.id === groupId
            return (
              <Chip
                key={group.id}
                clickable
                onClick={() => setGroupId(group.id)}
                label={group.name}
                icon={
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: color,
                      ml: '10px !important',
                    }}
                  />
                }
                sx={{
                  fontWeight: 600,
                  border: '1.5px solid',
                  borderColor: active ? color : 'divider',
                  bgcolor: active ? alpha(color, 0.12) : 'transparent',
                  color: active ? color : 'text.primary',
                }}
              />
            )
          })}
          <Chip
            clickable
            icon={<AddRounded />}
            label={t('process.dialog.group.new')}
            onClick={() => setGroupId(NEW_GROUP)}
            sx={{
              fontWeight: 600,
              border: '1.5px dashed',
              borderColor: isNew ? draft.color : 'divider',
              bgcolor: isNew ? alpha(draft.color, 0.12) : 'transparent',
              color: isNew ? draft.color : 'text.secondary',
              '& .MuiChip-icon': { color: 'inherit' },
            }}
          />
        </Box>
        <Collapse in={isNew} unmountOnExit>
          <Box sx={{ mt: 1.5 }}>
            <GroupForm draft={draft} onChange={setDraft} groups={groups} />
          </Box>
        </Collapse>

        <SectionTitle>{t('process.dialog.preview')}</SectionTitle>
        <Box
          sx={{
            p: 1.25,
            borderRadius: 2,
            bgcolor: theme.palette.mode === 'dark' ? '#1e1f27' : '#f6f7f9',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 11.5,
            lineHeight: 1.7,
            maxHeight: 120,
            overflow: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {matchers.map((matcher) => (
            <Box key={`${matcher.kind}:${matcher.value}`}>
              <Box component="span" sx={{ color: 'info.main' }}>
                {matcher.kind}
              </Box>
              ,{matcher.value},
              <Box component="span" sx={{ color: accent, fontWeight: 700 }}>
                {policy}
              </Box>
            </Box>
          ))}
        </Box>
      </DialogContent>

      <DialogActions sx={{ px: 3, pb: 2.5, pt: 1 }}>
        <Button onClick={close} color="inherit">
          {t('process.dialog.cancel')}
        </Button>
        <Button
          variant="contained"
          disableElevation
          disabled={draftError}
          onClick={confirm}
          sx={{
            bgcolor: accent,
            borderRadius: 2,
            px: 2.5,
            textTransform: 'none',
            '&:hover': { bgcolor: accent, filter: 'brightness(1.08)' },
          }}
        >
          {t('process.dialog.confirm', {
            name: isNew
              ? draft.name.trim() || '…'
              : (selectedGroup?.name ?? ''),
            count: matchers.length,
          })}
        </Button>
      </DialogActions>
    </Dialog>
  )
}
