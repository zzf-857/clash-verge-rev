import { useEffect, useSyncExternalStore } from 'react'

import { getProcessIcons } from '@/services/cmds'

// Icons never change for a given executable path within a session.
const icons = new Map<string, string | null>()
const queued = new Set<string>()
const listeners = new Set<() => void>()
// An executable seen for each process name, so name-only matchers and processes whose path
// is unreadable still get the icon of their namesakes.
const exeByName = new Map<string, string>()
const nameKey = (name: string) => name.toLowerCase()
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

export const rememberProcessExes = (
  entries: Iterable<{ name: string; exe: string | null | undefined }>,
) => {
  let changed = false
  for (const { name, exe } of entries) {
    if (!name || !exe || exeByName.has(nameKey(name))) continue
    exeByName.set(nameKey(name), exe)
    changed = true
  }
  if (changed) listeners.forEach((listener) => listener())
}

export const useProcessIcon = (
  exe: string | null | undefined,
  processName?: string,
) => {
  const source = useSyncExternalStore(
    subscribe,
    () => exe || (processName && exeByName.get(nameKey(processName))) || null,
  )
  useEffect(() => {
    if (source) request(source)
  }, [source])
  return useSyncExternalStore(subscribe, () =>
    source ? (icons.get(source) ?? null) : null,
  )
}
