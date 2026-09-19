import DeleteOutlined from '@mui/icons-material/DeleteOutlined'
import DownloadRounded from '@mui/icons-material/DownloadRounded'
import RefreshRounded from '@mui/icons-material/RefreshRounded'
import RestoreRounded from '@mui/icons-material/RestoreRounded'
import {
  Alert,
  FormControlLabel,
  Radio,
  RadioGroup,
  Box,
  Button,
  IconButton,
  List,
  ListItem,
  ListItemText,
  ListSubheader,
  Stack,
  Tab,
  Tabs,
  Typography,
} from '@mui/material'
import { save } from '@tauri-apps/plugin-dialog'
import { useLockFn } from 'ahooks'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import relativeTime from 'dayjs/plugin/relativeTime'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { BaseDialog, BaseLoadingOverlay } from '@/components/base'
import { useVerge } from '@/hooks/use-verge'
import {
  deleteLocalBackup,
  deleteWebdavBackup,
  exportLocalBackup,
  listLocalBackup,
  listWebDavBackup,
  restartApp,
  restoreLocalBackup,
  restoreWebDavBackup,
} from '@/services/cmds'
import { errorDetail, showNotice } from '@/services/notice-service'
import {
  buildWebdavSignature,
  getWebdavStatus,
  setWebdavStatus,
} from '@/services/webdav-status'

dayjs.extend(customParseFormat)
dayjs.extend(relativeTime)

const DATE_FORMAT = 'YYYY-MM-DD_HH-mm-ss'
const FILENAME_PATTERN = /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/

type BackupSource = 'local' | 'webdav'
type PendingConfirmation = {
  action: 'delete' | 'restore'
  filename: string
  source: BackupSource
} | null

interface BackupHistoryViewerProps {
  open: boolean
  source: BackupSource
  page: number
  onSourceChange: (source: BackupSource) => void
  onPageChange: (page: number) => void
  onClose: () => void
}

interface BackupRow {
  filename: string
  platform: string
  backup_time: dayjs.Dayjs | null
  display_time: string
  sort_value: number
}

export const BackupHistoryViewer = ({
  open,
  source,
  page,
  onSourceChange,
  onPageChange,
  onClose,
}: BackupHistoryViewerProps) => {
  const { t, i18n } = useTranslation()
  const chinese = i18n.language.startsWith('zh')
  const [restoreMode, setRestoreMode] = useState<'cross_device' | 'full'>(
    'cross_device',
  )
  const [recoveryPath, setRecoveryPath] = useState('')
  const { verge } = useVerge()
  const [listError, setListError] = useState('')
  const [rows, setRows] = useState<BackupRow[]>([])
  const [loading, setLoading] = useState(false)
  const [isRestoring, setIsRestoring] = useState(false)
  const [isRestarting, setIsRestarting] = useState(false)
  const [isConfirming, setIsConfirming] = useState(false)
  const [pendingConfirmation, setPendingConfirmation] =
    useState<PendingConfirmation>(null)
  const isLocal = source === 'local'
  const isWebDavConfigured = Boolean(
    verge?.webdav_url && verge?.webdav_username && verge?.webdav_password,
  )
  const webdavSignature = buildWebdavSignature(verge)
  const webdavStatus = getWebdavStatus(webdavSignature)
  const shouldSkipWebDav = !isLocal && !isWebDavConfigured
  const pageSize = 8
  const isBusy = loading || isRestoring || isRestarting || isConfirming

  const buildRow = useCallback(
    (item: ILocalBackupFile | IWebDavFile): BackupRow | null => {
      const { filename, last_modified } = item
      if (!filename.toLowerCase().endsWith('.zip')) return null

      const platform =
        (filename.includes('-') && filename.split('-')[0]) ||
        t('settings.modals.backup.history.unknownPlatform', {
          defaultValue: 'unknown',
        })
      const match = filename.match(FILENAME_PATTERN)
      const parsedFromName = match ? dayjs(match[0], DATE_FORMAT, true) : null
      const parsedFromModified =
        last_modified && dayjs(last_modified).isValid()
          ? dayjs(last_modified)
          : null
      const backupTime = parsedFromName?.isValid()
        ? parsedFromName
        : parsedFromModified

      return {
        filename,
        platform,
        backup_time: backupTime ?? null,
        display_time:
          backupTime?.format('YYYY-MM-DD HH:mm') ??
          parsedFromModified?.format('YYYY-MM-DD HH:mm') ??
          t('settings.modals.backup.history.unknownTime', {
            defaultValue: 'Unknown time',
          }),
        sort_value:
          backupTime?.valueOf() ??
          parsedFromModified?.valueOf() ??
          Number.NEGATIVE_INFINITY,
      }
    },
    [t],
  )

  const fetchRows = useCallback(
    async (options?: { force?: boolean }) => {
      if (!open) return
      if (shouldSkipWebDav) {
        setRows([])
        return
      }
      if (!isLocal && webdavStatus === 'failed' && !options?.force) {
        setRows([])
        return
      }

      setLoading(true)
      setListError('')
      try {
        const list = isLocal
          ? await listLocalBackup()
          : await listWebDavBackup()
        if (!isLocal) {
          setWebdavStatus(webdavSignature, 'ready')
        }
        setRows(
          list
            .map((item) => buildRow(item))
            .filter((item): item is BackupRow => item !== null)
            .sort((a, b) =>
              a.sort_value === b.sort_value
                ? b.filename.localeCompare(a.filename)
                : b.sort_value - a.sort_value,
            ),
        )
      } catch (error) {
        if (!isLocal) {
          setWebdavStatus(webdavSignature, 'failed')
        }
        setListError(errorDetail(error))
        setRows([])
        showNotice.error(error)
      } finally {
        setLoading(false)
      }
    },
    [buildRow, isLocal, open, shouldSkipWebDav, webdavSignature, webdavStatus],
  )

  useEffect(() => {
    void fetchRows()
  }, [fetchRows])

  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const pagedRows = rows.slice(
    currentPage * pageSize,
    currentPage * pageSize + pageSize,
  )

  const summary = useMemo(() => {
    if (shouldSkipWebDav || (!isLocal && webdavStatus === 'failed')) {
      return t('settings.modals.backup.manual.webdav')
    }
    if (!total) return t('settings.modals.backup.history.empty')
    const recent =
      rows[0]?.backup_time?.fromNow() ?? rows[0]?.display_time ?? ''
    return t('settings.modals.backup.history.summary', {
      count: total,
      recent,
    })
  }, [isLocal, rows, shouldSkipWebDav, t, total, webdavStatus])

  const handleDelete = (filename: string) => {
    if (isRestarting) return
    setPendingConfirmation({ action: 'delete', filename, source })
  }

  const handleRestore = (filename: string) => {
    if (isRestoring || isRestarting) return
    setRestoreMode('cross_device')
    setPendingConfirmation({ action: 'restore', filename, source })
  }

  const handleConfirmAction = useLockFn(async () => {
    if (!pendingConfirmation) return
    const { action, filename, source: actionSource } = pendingConfirmation
    const actionIsLocal = actionSource === 'local'
    setIsConfirming(true)
    if (action === 'restore') {
      setIsRestoring(true)
    }
    try {
      if (action === 'delete') {
        if (actionIsLocal) {
          await deleteLocalBackup(filename)
        } else {
          await deleteWebdavBackup(filename)
        }
        setPendingConfirmation(null)
        await fetchRows()
      } else {
        if (actionIsLocal) {
          setRecoveryPath(await restoreLocalBackup(filename, restoreMode))
        } else {
          setRecoveryPath(await restoreWebDavBackup(filename, restoreMode))
        }
        setPendingConfirmation(null)
        showNotice.success('settings.modals.backup.messages.restoreSuccess')
        setIsRestarting(true)
        window.setTimeout(() => {
          void restartApp().catch((err: unknown) => {
            setIsRestarting(false)
            showNotice.error(err)
          })
        }, 1000)
      }
    } catch (error) {
      console.error(error)
      showNotice.error(error)
    } finally {
      setIsConfirming(false)
      setIsRestoring(false)
    }
  })

  const handleExport = useLockFn(async (filename: string) => {
    if (isRestarting) return
    if (!isLocal) return
    const savePath = await save({ defaultPath: filename })
    if (!savePath || Array.isArray(savePath)) return
    try {
      await exportLocalBackup(filename, savePath)
      showNotice.success('settings.modals.backup.messages.localBackupExported')
    } catch (ignoreError: unknown) {
      showNotice.error(
        'settings.modals.backup.messages.localBackupExportFailed',
      )
    }
  })

  const handleRefresh = () => {
    if (isRestarting) return
    void fetchRows({ force: true })
  }

  const closeConfirmDialog = () => {
    if (isConfirming) return
    setPendingConfirmation(null)
  }

  const confirmTitle =
    pendingConfirmation?.action === 'delete'
      ? t('settings.modals.backup.actions.deleteBackup')
      : t('settings.modals.backup.actions.restoreBackup')
  const confirmMessage =
    pendingConfirmation?.action === 'delete'
      ? t('settings.modals.backup.messages.confirmDelete')
      : t('settings.modals.backup.messages.confirmRestore')

  return (
    <BaseDialog
      open={open}
      title={t('settings.modals.backup.history.title')}
      contentSx={{ width: 520 }}
      disableOk
      cancelBtn={t('shared.actions.close')}
      onCancel={onClose}
      onClose={onClose}
    >
      <Box sx={{ position: 'relative', minHeight: 320 }}>
        <BaseLoadingOverlay isLoading={isBusy} />
        <Stack spacing={2}>
          {recoveryPath && (
            <Alert severity="info">
              {chinese
                ? '本地恢复点（含私人配置，请勿上传）：'
                : 'Local recovery point (private; do not upload): '}
              {recoveryPath}
            </Alert>
          )}
          <Stack
            direction="row"
            sx={{ alignItems: 'center', justifyContent: 'space-between' }}
          >
            <Tabs
              value={source}
              onChange={(_, val) => {
                if (isBusy) return
                onSourceChange(val as BackupSource)
                onPageChange(0)
              }}
              textColor="primary"
              indicatorColor="primary"
            >
              <Tab
                value="local"
                label={t('settings.modals.backup.tabs.local')}
                disabled={isBusy}
                sx={{ px: 2 }}
              />
              <Tab
                value="webdav"
                label={t('settings.modals.backup.tabs.webdav')}
                disabled={isBusy}
                sx={{ px: 2 }}
              />
            </Tabs>
            <IconButton size="small" onClick={handleRefresh} disabled={isBusy}>
              <RefreshRounded fontSize="small" />
            </IconButton>
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {summary}
          </Typography>

          {listError && <Alert severity="error">{listError}</Alert>}
          <List
            disablePadding
            subheader={
              <ListSubheader disableSticky>
                {t('settings.modals.backup.history.title')}
              </ListSubheader>
            }
          >
            {pagedRows.length === 0 ? (
              <ListItem>
                <ListItemText
                  primary={
                    listError ||
                    (shouldSkipWebDav
                      ? t('settings.modals.backup.manual.webdav')
                      : t('settings.modals.backup.history.empty'))
                  }
                />
              </ListItem>
            ) : (
              pagedRows.map((row) => (
                <ListItem key={`${row.platform}-${row.filename}`} divider>
                  <ListItemText
                    slotProps={{ secondary: { component: 'div' } }}
                    primary={
                      <Typography
                        variant="body2"
                        sx={{ wordBreak: 'break-all', fontWeight: 500 }}
                      >
                        {row.filename}
                      </Typography>
                    }
                    secondary={
                      <Stack
                        direction="row"
                        spacing={1.5}
                        sx={{
                          alignItems: 'center',
                          justifyContent: 'space-between',
                        }}
                      >
                        <Typography variant="caption" color="text.secondary">
                          {`${row.platform} · ${row.display_time}`}
                        </Typography>
                        <Stack
                          direction="row"
                          spacing={0.5}
                          sx={{ alignItems: 'center' }}
                        >
                          {isLocal && (
                            <IconButton
                              size="small"
                              disabled={isBusy}
                              onClick={() => handleExport(row.filename)}
                            >
                              <DownloadRounded fontSize="small" />
                            </IconButton>
                          )}
                          <IconButton
                            size="small"
                            disabled={isBusy}
                            aria-label={t(
                              'settings.modals.backup.actions.deleteBackup',
                            )}
                            onClick={() => handleDelete(row.filename)}
                          >
                            <DeleteOutlined fontSize="small" />
                          </IconButton>
                          <IconButton
                            size="small"
                            disabled={isBusy}
                            aria-label={t(
                              'settings.modals.backup.actions.restoreBackup',
                            )}
                            onClick={() => handleRestore(row.filename)}
                          >
                            <RestoreRounded fontSize="small" />
                          </IconButton>
                        </Stack>
                      </Stack>
                    }
                  />
                </ListItem>
              ))
            )}
          </List>

          {pageCount > 1 && (
            <Stack
              direction="row"
              spacing={1}
              sx={{ justifyContent: 'flex-end', alignItems: 'center' }}
            >
              <Typography variant="caption">
                {currentPage + 1} / {pageCount}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="text"
                  disabled={isBusy || currentPage === 0}
                  onClick={() => onPageChange(Math.max(0, currentPage - 1))}
                >
                  {t('shared.actions.previous')}
                </Button>
                <Button
                  size="small"
                  variant="text"
                  disabled={isBusy || currentPage >= pageCount - 1}
                  onClick={() =>
                    onPageChange(Math.min(pageCount - 1, currentPage + 1))
                  }
                >
                  {t('shared.actions.next')}
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </Box>
      <BaseDialog
        open={pendingConfirmation !== null}
        title={confirmTitle}
        okBtn={t('shared.actions.confirm')}
        cancelBtn={t('shared.actions.cancel')}
        contentSx={{ width: { xs: 320, sm: 420 } }}
        loading={isConfirming}
        onCancel={closeConfirmDialog}
        onClose={closeConfirmDialog}
        onOk={handleConfirmAction}
      >
        <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
          {confirmMessage}
        </Typography>
        {pendingConfirmation?.action === 'restore' && (
          <Stack spacing={1} sx={{ mt: 2 }}>
            <RadioGroup
              value={restoreMode}
              onChange={(_, value) =>
                setRestoreMode(value as 'cross_device' | 'full')
              }
            >
              <FormControlLabel
                disabled={isConfirming}
                value="cross_device"
                control={<Radio />}
                label={
                  chinese
                    ? '跨设备恢复（默认保护本机网络）'
                    : 'Cross-device restore (protect this device)'
                }
              />
              <FormControlLabel
                disabled={isConfirming}
                value="full"
                control={<Radio />}
                label={
                  chinese
                    ? '完整覆盖（仅用于兼容设备）'
                    : 'Full overwrite (compatible devices only)'
                }
              />
            </RadioGroup>
            <Alert severity="warning">
              {restoreMode === 'cross_device'
                ? chinese
                  ? '覆盖订阅文件和索引，保留本机 Clash、Verge 和 DNS 设置。脚本、网卡、网络设置或外部文件路径无法安全迁移时会拒绝恢复，请先在来源设备检查。'
                  : 'Replace profiles and their index; keep this device’s Clash, Verge and DNS settings. Scripts, network settings and file paths that cannot be migrated safely are rejected; review them on the source device first.'
                : chinese
                  ? '覆盖全部订阅、provider 定义、组和规则、Merge/Script、索引、DNS、Clash 和 Verge 设置（包括 TUN、端口、系统代理和网卡），可能中断网络。目标 WebDAV 凭据保留。'
                  : 'Overwrite profiles, provider definitions, groups/rules, Merge/Script, index, DNS, Clash and Verge settings including TUN, ports, system proxy and interfaces. Network access may be interrupted. Target WebDAV credentials are retained.'}
            </Alert>
            <Typography variant="body2">
              {chinese
                ? '这是覆盖，不是合并。未归档的外部文件和缓存不会恢复。先校验和暂存，再创建应用目录下的 restore-point 恢复点；文件提交失败会回滚，回滚失败会单独提示。成功后自动重启应用，重启前运行内核保持不变；重启后的网络兼容性不在文件回滚范围内。'
                : 'This overwrites rather than merges. External files and caches outside the archive are not restored. Validation and staging precede a local restore-point directory. Failed file commits roll back; rollback failures are reported separately. The app restarts after success; the running core remains unchanged until restart. Network compatibility after restart is outside the file transaction.'}
            </Typography>
          </Stack>
        )}
        {pendingConfirmation?.filename && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1, wordBreak: 'break-all' }}
          >
            {pendingConfirmation.filename}
          </Typography>
        )}
      </BaseDialog>
    </BaseDialog>
  )
}
