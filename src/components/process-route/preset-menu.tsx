import {
  BookmarksRounded,
  DeleteOutlineRounded,
  FileDownloadRounded,
  FileUploadRounded,
  SaveRounded,
} from '@mui/icons-material'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material'
import {
  open as openDialog,
  save as saveDialog,
} from '@tauri-apps/plugin-dialog'
import { readFile, writeFile } from '@tauri-apps/plugin-fs'
import { useLockFn } from 'ahooks'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { selectNodeForGroup } from 'tauri-plugin-mihomo-api'

import { useRecordSelection } from '@/hooks/use-record-selection'
import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import { showNotice } from '@/services/notice-service'

import { createGroupId, routePolicy } from './process-utils'

const FILE_TYPE = 'clash-verge-process-routes'
const KINDS = new Set<string>([
  'PROCESS-NAME',
  'PROCESS-PATH',
  'PROCESS-PATH-REGEX',
])
const EMPTY: IProcessRoutePreset[] = []

interface Props {
  groups: IProcessRouteGroup[]
  commitGroups: (
    updater: (groups: IProcessRouteGroup[]) => IProcessRouteGroup[],
  ) => Promise<void>
}

const parseMatcher = (value: unknown): IProcessMatcher | null => {
  if (!value || typeof value !== 'object') return null
  const { kind, value: payload, label } = value as Record<string, unknown>
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  if (typeof payload !== 'string' || !payload) return null
  return {
    kind: kind as ProcessMatchKind,
    value: payload,
    ...(typeof label === 'string' ? { label } : {}),
  }
}

const parseGroup = (value: unknown): IProcessRouteGroup | null => {
  if (!value || typeof value !== 'object') return null
  const group = value as Record<string, unknown>
  if (typeof group.name !== 'string' || !group.name.trim()) return null
  return {
    // Ids only need to be unique locally; a shared file must not collide with them.
    id: createGroupId(),
    name: group.name.trim(),
    enabled: group.enabled !== false,
    color: typeof group.color === 'string' ? group.color : undefined,
    target: typeof group.target === 'string' ? group.target : null,
    matchers: Array.isArray(group.matchers)
      ? group.matchers.flatMap((matcher) => parseMatcher(matcher) ?? [])
      : [],
  }
}

const parsePresetFile = (text: string): IProcessRoutePreset | null => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const file = data as Record<string, unknown>
  if (file.type !== FILE_TYPE || !Array.isArray(file.groups)) return null
  const exits =
    file.exits && typeof file.exits === 'object'
      ? Object.fromEntries(
          Object.entries(file.exits).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {}
  return {
    id: createGroupId(),
    name: typeof file.name === 'string' && file.name ? file.name : 'Imported',
    groups: file.groups.flatMap((group) => parseGroup(group) ?? []),
    exits,
  }
}

export const PresetMenu = ({ groups, commitGroups }: Props) => {
  const { t } = useTranslation()
  const { verge, patchVerge } = useVerge()
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const recordSelection = useRecordSelection()
  const presets = verge?.process_route_presets ?? EMPTY
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')

  const closeMenu = () => {
    setAnchor(null)
    setConfirmId(null)
  }

  // Only manually picked nodes are worth pinning; auto groups pick their own.
  const currentExits = () => {
    const exits: Record<string, string> = {}
    for (const group of groups) {
      const policy = routePolicy(group)
      const view = proxyView?.groups.find((item) => item.name === policy)
      if (view?.type === 'Selector' && view.now) exits[policy] = view.now
    }
    return exits
  }

  const savePresets = (next: IProcessRoutePreset[]) =>
    patchVerge({ process_route_presets: next })

  const applyPreset = useLockFn(async (preset: IProcessRoutePreset) => {
    closeMenu()
    await commitGroups(() => preset.groups)
    let missing = 0
    for (const [policy, node] of Object.entries(preset.exits)) {
      try {
        await selectNodeForGroup(policy, node)
        await recordSelection(policy, node)
      } catch {
        missing += 1
      }
    }
    await refreshProxy()
    showNotice.success('process.preset.applied', { name: preset.name })
    if (missing) {
      showNotice.info('process.preset.missingExits', { count: missing })
    }
  })

  const saveCurrent = useLockFn(async () => {
    const presetName = name.trim()
    if (!presetName) return
    const existing = presets.find((preset) => preset.name === presetName)
    const preset: IProcessRoutePreset = {
      id: existing?.id ?? createGroupId(),
      name: presetName,
      groups,
      exits: currentExits(),
    }
    try {
      await savePresets(
        existing
          ? presets.map((item) => (item.id === existing.id ? preset : item))
          : [...presets, preset],
      )
      setNaming(false)
      showNotice.success('process.preset.saved', { name: presetName })
    } catch (error) {
      showNotice.error(error)
    }
  })

  const exportCurrent = useLockFn(async () => {
    closeMenu()
    const path = await saveDialog({
      defaultPath: 'process-routes.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!path) return
    const file = {
      type: FILE_TYPE,
      version: 1,
      name: 'process-routes',
      groups: groups.map(({ id: _id, ...group }) => group),
      exits: currentExits(),
    }
    try {
      await writeFile(
        path,
        new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`),
      )
      showNotice.success('process.preset.exported', { path })
    } catch (error) {
      showNotice.error(error)
    }
  })

  const importFile = useLockFn(async () => {
    closeMenu()
    const path = await openDialog({
      multiple: false,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!path || Array.isArray(path)) return
    try {
      const preset = parsePresetFile(
        new TextDecoder().decode(await readFile(path)),
      )
      if (!preset) {
        showNotice.error('process.preset.invalid')
        return
      }
      // Kept as a preset rather than applied, so importing never replaces the current setup.
      await savePresets([...presets, preset])
      showNotice.success('process.preset.imported', { name: preset.name })
    } catch (error) {
      showNotice.error(error)
    }
  })

  return (
    <>
      <Button
        size="small"
        variant="outlined"
        startIcon={<BookmarksRounded />}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ borderRadius: 2, textTransform: 'none' }}
      >
        {t('process.preset.button')}
      </Button>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={closeMenu}
        slotProps={{ paper: { sx: { minWidth: 260, borderRadius: 2 } } }}
      >
        {presets.length === 0 && (
          <Typography
            sx={{ px: 2, py: 1, fontSize: 13, color: 'text.secondary' }}
          >
            {t('process.preset.empty')}
          </Typography>
        )}
        {presets.map((preset) => (
          <MenuItem
            key={preset.id}
            onClick={() =>
              confirmId === preset.id
                ? void applyPreset(preset)
                : setConfirmId(preset.id)
            }
          >
            <ListItemText
              primary={preset.name}
              secondary={
                confirmId === preset.id
                  ? t('process.preset.confirmApply')
                  : t('process.preset.summary', {
                      count: preset.groups.length,
                    })
              }
              slotProps={{
                secondary: {
                  sx: {
                    color: confirmId === preset.id ? 'warning.main' : undefined,
                  },
                },
              }}
            />
            <IconButton
              size="small"
              edge="end"
              aria-label={t('process.preset.delete')}
              onClick={(event) => {
                event.stopPropagation()
                void savePresets(
                  presets.filter((item) => item.id !== preset.id),
                ).catch((error: unknown) => showNotice.error(error))
              }}
            >
              <DeleteOutlineRounded fontSize="small" />
            </IconButton>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          disabled={groups.length === 0}
          onClick={() => {
            closeMenu()
            setName('')
            setNaming(true)
          }}
        >
          <ListItemIcon>
            <SaveRounded fontSize="small" />
          </ListItemIcon>
          {t('process.preset.save')}
        </MenuItem>
        <MenuItem
          disabled={groups.length === 0}
          onClick={() => void exportCurrent()}
        >
          <ListItemIcon>
            <FileUploadRounded fontSize="small" />
          </ListItemIcon>
          {t('process.preset.export')}
        </MenuItem>
        <MenuItem onClick={() => void importFile()}>
          <ListItemIcon>
            <FileDownloadRounded fontSize="small" />
          </ListItemIcon>
          {t('process.preset.import')}
        </MenuItem>
      </Menu>

      <Dialog
        open={naming}
        onClose={() => setNaming(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('process.preset.saveTitle')}</DialogTitle>
        <DialogContent>
          <Box sx={{ pt: 1 }}>
            <TextField
              autoFocus
              fullWidth
              size="small"
              label={t('process.preset.name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveCurrent()
              }}
              helperText={
                presets.some((preset) => preset.name === name.trim())
                  ? t('process.preset.overwrite')
                  : t('process.preset.saveHint')
              }
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setNaming(false)}>
            {t('process.preset.cancel')}
          </Button>
          <Button
            variant="contained"
            disableElevation
            disabled={!name.trim()}
            onClick={() => void saveCurrent()}
          >
            {t('process.preset.confirm')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
