export const GROUP_COLORS = [
  '#6366f1',
  '#0ea5e9',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#ec4899',
  '#8b5cf6',
  '#14b8a6',
]

export type MatchMode = 'path' | 'name' | 'dir'

export interface ProcessApp {
  key: string
  name: string
  /** Friendlier label when the executable file name is not meaningful */
  label: string
  exe: string | null
  pids: number[]
  memory: number
}

export interface RelatedApp extends ProcessApp {
  relation: 'child' | 'sameDir'
  generic: boolean
}

// Interpreters and shells host unrelated programs, so routing them by path or
// name routes every program they run.
const GENERIC_RUNTIMES = new Set([
  'node',
  'nodejs',
  'python',
  'pythonw',
  'py',
  'java',
  'javaw',
  'bun',
  'deno',
  'ruby',
  'perl',
  'php',
  'dotnet',
  'electron',
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  'conhost',
  'wscript',
  'cscript',
  'rundll',
  'svchost',
  'explorer',
  'osascript',
  'env',
  'sudo',
  'login',
  'launchd',
  'systemd',
  'init',
])

export const isGenericRuntime = (name: string) =>
  GENERIC_RUNTIMES.has(
    name
      .toLowerCase()
      .replace(/\.exe$/, '')
      .replace(/[\d.]+$/, ''),
  )

const isWindowsPath = (path: string) => /^[a-z]:\\/i.test(path)

const separatorOf = (path: string) => (isWindowsPath(path) ? '\\' : '/')

export const basename = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path

const dirname = (path: string) => {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index > 0 ? path.slice(0, index) : null
}

// Directories shared by unrelated programs, where "same folder" means nothing.
const SHARED_DIR_PATTERN = new RegExp(
  [
    String.raw`^(/usr(/local)?)?/s?bin$`,
    String.raw`^/(opt/homebrew|snap)/s?bin$`,
    String.raw`^/usr/(local/)?libexec$`,
    String.raw`^/(home|Users)/[^/]+(/\.local)?/bin$`,
    String.raw`^/applications$`,
    String.raw`^[a-z]:\\windows(\\(system32|syswow64))?$`,
    String.raw`\\windowsapps$`,
  ].join('|'),
  'i',
)

/** The directory that holds one program's files, or null for shared system dirs. */
export const installDirOf = (exe: string | null) => {
  if (!exe) return null
  const bundle = exe.match(/^(.*?\.app)(?:[\\/]|$)/i)
  const dir = bundle ? bundle[1] : dirname(exe)
  if (!dir || SHARED_DIR_PATTERN.test(dir)) return null
  return dir
}

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const samePath = (left: string, right: string) =>
  isWindowsPath(left)
    ? left.toLowerCase() === right.toLowerCase()
    : left === right

export const appKey = (name: string, exe: string | null) => exe || name

const VERSION_NAME = /^v?\d+(\.\d+)+$/

/** Versioned binaries (e.g. Claude Code's `versions/2.0.14`) move on every update. */
const isVersionedBinary = (name: string) => VERSION_NAME.test(name)

const labelOf = (process: Pick<IProcessEntry, 'name' | 'comm'>) =>
  isVersionedBinary(process.name) && process.comm ? process.comm : process.name

// macOS apps do much of their networking from helper binaries inside the bundle.
export const defaultMatchMode = (
  app: Pick<ProcessApp, 'name' | 'exe'>,
): MatchMode => {
  const dir = installDirOf(app.exe)
  if (dir && (isVersionedBinary(app.name) || /\.app$/i.test(dir))) return 'dir'
  return app.exe ? 'path' : 'name'
}

/** Collapses process instances into one entry per executable. */
export const groupProcesses = (processes: IProcessEntry[]) => {
  const apps = new Map<string, ProcessApp>()
  for (const process of processes) {
    // Kernel threads have neither an executable nor resident memory.
    if (!process.exe && process.memory === 0) continue
    const key = appKey(process.name, process.exe)
    const app = apps.get(key)
    if (app) {
      app.pids.push(process.pid)
      app.memory += process.memory
    } else {
      apps.set(key, {
        key,
        name: process.name,
        label: labelOf(process),
        exe: process.exe,
        pids: [process.pid],
        memory: process.memory,
      })
    }
  }
  return apps
}

/** Descendants of the app's processes plus programs from the same install dir. */
export const findRelatedApps = (
  app: ProcessApp,
  processes: IProcessEntry[],
): RelatedApp[] => {
  const children = new Map<number, IProcessEntry[]>()
  for (const process of processes) {
    if (process.ppid == null) continue
    const list = children.get(process.ppid)
    if (list) list.push(process)
    else children.set(process.ppid, [process])
  }

  const related = new Map<string, RelatedApp>()
  const add = (process: IProcessEntry, relation: RelatedApp['relation']) => {
    const key = appKey(process.name, process.exe)
    if (key === app.key) return
    const existing = related.get(key)
    if (existing) {
      if (!existing.pids.includes(process.pid)) existing.pids.push(process.pid)
      return
    }
    related.set(key, {
      key,
      name: process.name,
      label: labelOf(process),
      exe: process.exe,
      pids: [process.pid],
      memory: process.memory,
      relation,
      generic: isGenericRuntime(labelOf(process)),
    })
  }

  const queue = [...app.pids]
  const visited = new Set(queue)
  while (queue.length) {
    const pid = queue.shift()!
    for (const child of children.get(pid) ?? []) {
      if (visited.has(child.pid)) continue
      visited.add(child.pid)
      queue.push(child.pid)
      add(child, 'child')
    }
  }

  const dir = installDirOf(app.exe)
  if (dir) {
    const prefix = dir + separatorOf(dir)
    for (const process of processes) {
      if (process.exe && process.exe.startsWith(prefix)) {
        add(process, 'sameDir')
      }
    }
  }

  return [...related.values()].sort(
    (a, b) =>
      Number(a.generic) - Number(b.generic) ||
      a.relation.localeCompare(b.relation) ||
      a.label.localeCompare(b.label),
  )
}

export const buildMatcher = (
  app: Pick<ProcessApp, 'name' | 'label' | 'exe'>,
  mode: MatchMode,
): IProcessMatcher => {
  const label = displayName(app.label)
  if (mode === 'dir') {
    const dir = installDirOf(app.exe)
    if (dir) {
      const pattern = `^${escapeRegex(dir + separatorOf(dir))}`
      return {
        kind: 'PROCESS-PATH-REGEX',
        value: isWindowsPath(dir) ? `(?i)${pattern}` : pattern,
        label,
      }
    }
  }
  if (mode !== 'name' && app.exe) {
    return { kind: 'PROCESS-PATH', value: app.exe, label }
  }
  return { kind: 'PROCESS-NAME', value: app.name, label }
}

export const sameMatcher = (a: IProcessMatcher, b: IProcessMatcher) =>
  a.kind === b.kind && a.value === b.value

export const matcherMatches = (
  matcher: IProcessMatcher,
  app: Pick<ProcessApp, 'name' | 'exe'>,
) => {
  switch (matcher.kind) {
    case 'PROCESS-NAME':
      return matcher.value.toLowerCase() === app.name.toLowerCase()
    case 'PROCESS-PATH':
      return !!app.exe && samePath(matcher.value, app.exe)
    case 'PROCESS-PATH-REGEX': {
      if (!app.exe) return false
      const insensitive = matcher.value.startsWith('(?i)')
      try {
        return new RegExp(
          insensitive ? matcher.value.slice(4) : matcher.value,
          insensitive ? 'i' : undefined,
        ).test(app.exe)
      } catch {
        return false
      }
    }
  }
}

/** Human readable label for a matcher chip. */
export const matcherLabel = (matcher: IProcessMatcher) => {
  if (matcher.label) return matcher.label
  if (matcher.kind === 'PROCESS-PATH-REGEX') {
    const raw = matcher.value
      .replace(/^\(\?i\)/, '')
      .replace(/^\^/, '')
      .replace(/\\(.)/g, '$1')
    return basename(raw)
  }
  return matcher.kind === 'PROCESS-PATH'
    ? basename(matcher.value)
    : matcher.value
}

export const displayName = (name: string) => name.replace(/\.exe$/i, '')

export const avatarColor = (name: string) => {
  let hash = 0
  for (const char of name.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0
  }
  return `hsl(${Math.abs(hash) % 360}, 58%, 52%)`
}

/** Keeps both ends of a long path visible. */
export const shortenPath = (path: string, max = 52) => {
  if (path.length <= max) return path
  const head = Math.ceil((max - 1) * 0.4)
  const tail = max - 1 - head
  return `${path.slice(0, head)}…${path.slice(-tail)}`
}

export const routePolicy = (group: IProcessRouteGroup) =>
  group.target || group.name

export const createGroupId = () =>
  `pr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
