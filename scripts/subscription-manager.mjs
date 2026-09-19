import { execFile } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, realpath } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { load } from 'js-yaml'

import {
  editSubscription,
  inspectSubscriptions,
  removeSubscription,
  SubscriptionConfigError,
} from '../src/utils/subscription-config.ts'

import { assertIsolatedRuntime } from './subscription-isolation.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const configDir = path.join(root, '.subscription-workspace')
const dist = path.join(root, 'dist-subscription-manager')
const runtimePath = path.join(configDir, 'clash-verge.yaml')
const socketPath = path.join(configDir, 'mihomo.sock')
const port = Number(process.env.SUBSCRIPTION_MANAGER_PORT ?? 17891)
const host = `127.0.0.1:${port}`
const origin = `http://${host}`
const token = randomBytes(32).toString('hex')
let busy = false
const execute = promisify(execFile)

async function current() {
  const profiles = load(
    await readFile(path.join(configDir, 'profiles.yaml'), 'utf8'),
  )
  const profile = profiles.items.find((item) => item.uid === profiles.current)
  if (!profile?.file) throw new Error('invalidConfig')
  const profilesDir = await realpath(path.join(configDir, 'profiles'))
  const file = await realpath(path.join(profilesDir, profile.file))
  if (!file.startsWith(profilesDir + path.sep)) throw new Error('invalidConfig')
  const content = await readFile(file, 'utf8')
  const runtime = await readFile(runtimePath, 'utf8')
  const revision = createHash('sha256')
    .update(profile.uid)
    .update(content)
    .update(runtime)
    .digest('hex')
  return { profile, file, content, runtime, revision }
}

function core(endpoint, method = 'GET', payload) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: endpoint,
        method,
        timeout: 45000,
        headers: { 'Content-Type': 'application/json' },
      },
      (response) => {
        let body = ''
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode < 200 || response.statusCode >= 300)
            return reject(new Error('unavailable'))
          try {
            resolve(body ? JSON.parse(body) : {})
          } catch {
            reject(new Error('unavailable'))
          }
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error('unavailable')))
    request.on('error', () => reject(new Error('unavailable')))
    request.end(payload ? JSON.stringify(payload) : undefined)
  })
}

async function atomic(file, content) {
  const temp = `${file}.${randomUUID()}.tmp`
  await writeFile(temp, content, { mode: 0o600 })
  await rename(temp, file)
}

async function change(body, remove = false) {
  const before = await current()
  if (before.profile.type !== 'local') throw new Error('localOnly')
  if (body.revision !== before.revision) throw new Error('configChanged')
  const cache = `profiles/provider-${randomUUID()}.yaml`
  const transform = (content) =>
    remove
      ? removeSubscription(content, body.name)
      : editSubscription(content, body.input, body.originalName, cache)
  const source = transform(before.content)
  const runtime = transform(before.runtime)
  try {
    await assertIsolatedRuntime(runtime, { configDir })
  } catch {
    throw new Error('validationFailed')
  }
  const stage = path.join(configDir, 'candidate.yaml')
  await writeFile(stage, runtime, { mode: 0o600 })
  try {
    await execute(
      process.env.MIHOMO_BIN || 'verge-mihomo',
      ['-t', '-d', configDir, '-f', stage],
      { timeout: 60000, maxBuffer: 1024 * 1024 },
    )
  } catch {
    throw new Error('validationFailed')
  }
  if ((await current()).revision !== before.revision)
    throw new Error('configChanged')
  const backup = path.join(
    configDir,
    'backups',
    `${Date.now()}-${randomUUID()}`,
  )
  await mkdir(backup, { recursive: true, mode: 0o700 })
  await writeFile(path.join(backup, 'profile.yaml'), before.content, {
    mode: 0o600,
  })
  await writeFile(path.join(backup, 'runtime.yaml'), before.runtime, {
    mode: 0o600,
  })
  try {
    await atomic(before.file, source)
    await atomic(runtimePath, runtime)
    await core('/configs', 'PUT', { path: runtimePath })
  } catch {
    await atomic(before.file, before.content)
    await atomic(runtimePath, before.runtime)
    try {
      await core('/configs', 'PUT', { path: runtimePath })
    } catch {
      /* The isolated core may have stopped. */
    }
    throw new Error('applyFailed')
  }
}

async function readBody(request) {
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 65536) throw new Error('invalidConfig')
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new Error('invalidConfig')
  }
}

const safeErrors = new Set([
  'invalidConfig',
  'localOnly',
  'configChanged',
  'validationFailed',
  'applyFailed',
  'busy',
  'unavailable',
])
const server = http.createServer(async (request, response) => {
  const json = (code, value) => {
    response.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify(value))
  }
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  )
  if (
    request.headers.host !== host ||
    (request.headers.origin && request.headers.origin !== origin) ||
    request.headers['sec-fetch-site'] === 'cross-site'
  )
    return json(403, { error: 'forbidden' })
  const pathname = new URL(request.url, origin).pathname
  try {
    if (!pathname.startsWith('/api/')) {
      if (request.method !== 'GET') return json(405, { error: 'method' })
      if (pathname === '/') {
        const html = (
          await readFile(path.join(dist, 'index.html'), 'utf8')
        ).replace('__MANAGER_TOKEN__', token)
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        return response.end(html)
      }
      if (!/^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/u.test(pathname))
        return json(404, { error: 'notFound' })
      const content = await readFile(path.join(dist, pathname))
      response.writeHead(200, {
        'Content-Type': pathname.endsWith('.js')
          ? 'text/javascript'
          : 'text/css',
      })
      return response.end(content)
    }
    if (request.headers['x-manager-token'] !== token)
      return json(403, { error: 'forbidden' })
    if (busy) return json(409, { error: 'busy' })
    if (pathname === '/api/subscriptions' && request.method === 'GET') {
      busy = true
      try {
        const state = await current()
        const parsed = inspectSubscriptions(state.content)
        const live = await core('/providers/proxies')
        return json(200, {
          revision: state.revision,
          profile: state.profile.name,
          editable: state.profile.type === 'local',
          groups: parsed.groups,
          sources: parsed.sources.map((source) => {
            const provider = live.providers?.[source.name]
            return {
              ...source,
              count: provider?.proxies?.length,
              updatedAt: provider?.updatedAt,
              expire:
                provider?.subscriptionInfo?.Expire ??
                provider?.subscriptionInfo?.expire,
            }
          }),
        })
      } finally {
        busy = false
      }
    }
    if (!['POST', 'DELETE'].includes(request.method))
      return json(405, { error: 'method' })
    busy = true
    try {
      const body = await readBody(request)
      if (pathname === '/api/refresh' && request.method === 'POST') {
        const state = await current()
        if (
          !inspectSubscriptions(state.content).sources.some(
            (source) => source.name === body.name && source.type === 'http',
          )
        )
          throw new Error('invalidConfig')
        await core(`/providers/proxies/${encodeURIComponent(body.name)}`, 'PUT')
      } else if (pathname === '/api/subscriptions') {
        await change(body, request.method === 'DELETE')
      } else return json(404, { error: 'notFound' })
      json(200, { ok: true })
    } finally {
      busy = false
    }
  } catch (error) {
    const code =
      error instanceof SubscriptionConfigError || safeErrors.has(error.message)
        ? error.message
        : 'generic'
    json(400, { error: code })
  }
})

await current()
server.listen(port, '127.0.0.1', () => {
  console.log(`Subscription manager: ${origin}\nWorkspace: ${configDir}`)
})
