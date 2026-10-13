import { useEffect, useSyncExternalStore } from 'react'

import { getProcessIcons } from '@/services/cmds'

// Icons never change for a given executable path within a session.
const icons = new Map<string, string | null>()
const queued = new Set<string>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | null = null

const flush = async () => {
  timer = null
  const paths = [...queued]
  queued.clear()
  try {
    const found = await getProcessIcons(paths)
    for (const path of paths) icons.set(path, found[path] ?? null)
  } catch {
    for (const path of paths) icons.set(path, null)
  }
  listeners.forEach((listener) => listener())
}

const request = (path: string) => {
  if (icons.has(path) || queued.has(path)) return
  queued.add(path)
  // Batch the requests of one render pass into a single IPC call.
  timer ??= setTimeout(() => void flush(), 30)
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const useProcessIcon = (exe: string | null | undefined) => {
  useEffect(() => {
    if (exe) request(exe)
  }, [exe])
  return useSyncExternalStore(subscribe, () =>
    exe ? (icons.get(exe) ?? null) : null,
  )
}
