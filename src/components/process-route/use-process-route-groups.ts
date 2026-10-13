import { useCallback, useRef, useState } from 'react'

import { useVerge } from '@/hooks/use-verge'
import { useAppRefreshers } from '@/providers/app-data-context'
import { patchVergeConfig } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

const EMPTY: IProcessRouteGroup[] = []

export const useProcessRouteGroups = () => {
  const { verge, mutateVerge } = useVerge()
  const { refreshProxy, refreshRules } = useAppRefreshers()
  const groups = verge?.process_route_groups ?? EMPTY
  const [saving, setSaving] = useState(false)

  const latestRef = useRef(groups)
  const pendingRef = useRef<IProcessRouteGroup[] | null>(null)
  const committedRef = useRef<IProcessRouteGroup[] | null>(null)
  const runningRef = useRef(false)
  if (!runningRef.current && !pendingRef.current) {
    latestRef.current = groups
  }

  // Each save regenerates the runtime config, so rapid edits collapse into
  // the latest snapshot instead of queueing one reload per edit.
  const flush = useCallback(async () => {
    if (runningRef.current) return
    runningRef.current = true
    setSaving(true)
    try {
      while (pendingRef.current) {
        const next = pendingRef.current
        pendingRef.current = null
        try {
          await patchVergeConfig({ process_route_groups: next })
          committedRef.current = next
        } catch (error) {
          showNotice.error(error)
          if (!pendingRef.current && committedRef.current) {
            const committed = committedRef.current
            latestRef.current = committed
            mutateVerge((prev) =>
              prev ? { ...prev, process_route_groups: committed } : prev,
            )
          }
        }
      }
      committedRef.current = null
      await Promise.allSettled([refreshProxy(), refreshRules()])
    } finally {
      runningRef.current = false
      setSaving(false)
      mutateVerge()
    }
  }, [mutateVerge, refreshProxy, refreshRules])

  const updateGroups = useCallback(
    (updater: (groups: IProcessRouteGroup[]) => IProcessRouteGroup[]) => {
      committedRef.current ??= latestRef.current
      const next = updater(latestRef.current)
      latestRef.current = next
      mutateVerge((prev) =>
        prev ? { ...prev, process_route_groups: next } : prev,
      )
      pendingRef.current = next
      void flush()
    },
    [flush, mutateVerge],
  )

  return { groups, saving, updateGroups }
}
