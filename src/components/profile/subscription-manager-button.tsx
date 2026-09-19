import { StorageRounded } from '@mui/icons-material'
import { Button, Dialog, DialogActions } from '@mui/material'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { updateProxyProvider } from 'tauri-plugin-mihomo-api'

import { useAppRefreshers, useProxiesData } from '@/providers/app-data-context'
import {
  getProfiles,
  readProfileFile,
  saveProfileFile,
  syncRuntimeProviders,
} from '@/services/cmds'
import {
  editSubscription,
  inspectSubscriptions,
  removeSubscription,
} from '@/utils/subscription-config'

import {
  SubscriptionManager,
  type SubscriptionManagerApi,
} from './subscription-manager'
import { subscriptionText } from './subscription-manager-text'

export function SubscriptionManagerButton() {
  const { i18n } = useTranslation()
  const text = subscriptionText[i18n.language.startsWith('zh') ? 'zh' : 'en']
  const [open, setOpen] = useState(false)
  const { proxyView } = useProxiesData()
  const { refreshProxy } = useAppRefreshers()
  const viewRef = useRef(proxyView)
  viewRef.current = proxyView
  const snapshotRef = useRef<{
    uid: string
    content: string
    revision: string
  } | null>(null)
  const api = useMemo<SubscriptionManagerApi>(() => {
    const save = async (
      revision: string,
      transform: (content: string) => string,
    ) => {
      const profiles = await getProfiles()
      const previous = snapshotRef.current
      if (
        !previous ||
        previous.revision !== revision ||
        profiles.current !== previous.uid
      )
        throw new Error('configChanged')
      const current = profiles.items?.find((item) => item.uid === previous?.uid)
      if (current?.type !== 'local') throw new Error('localOnly')
      const content = await readProfileFile(previous.uid)
      if (content !== previous.content) throw new Error('configChanged')
      if (!(await saveProfileFile(previous.uid, transform(content))))
        throw new Error('validationFailed')
      await refreshProxy()
    }
    return {
      read: async () => {
        const profiles = await getProfiles()
        const current = profiles.items?.find(
          (item) => item.uid === profiles.current,
        )
        if (!current) throw new Error('invalidConfig')
        const content = await readProfileFile(current.uid)
        const revision = crypto.randomUUID()
        snapshotRef.current = { uid: current.uid, content, revision }
        const parsed = inspectSubscriptions(content)
        return {
          ...parsed,
          revision,
          profile: current.name ?? current.uid,
          editable: current.type === 'local',
          sources: parsed.sources.map((source) => {
            const live = viewRef.current?.providers.find(
              (provider) => provider.name === source.name,
            )
            return {
              ...source,
              count: live?.proxyRecordIds.length,
              updatedAt: live?.updatedAt,
              expire: live?.subscriptionInfo?.expire,
            }
          }),
        }
      },
      save: (revision, input, originalName) =>
        save(revision, (content) =>
          editSubscription(
            content,
            input,
            originalName,
            `profiles/provider-${crypto.randomUUID()}.yaml`,
          ),
        ),
      remove: (revision, name) =>
        save(revision, (content) => removeSubscription(content, name)),
      refresh: async (name) => {
        await updateProxyProvider(name)
        await refreshProxy()
        await syncRuntimeProviders()
      },
    }
  }, [refreshProxy])

  return (
    <>
      <Button
        variant="outlined"
        size="small"
        startIcon={<StorageRounded />}
        onClick={() => setOpen(true)}
      >
        {text.title}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        fullWidth
        maxWidth="lg"
      >
        {open && <SubscriptionManager api={api} language={i18n.language} />}
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{text.close}</Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
