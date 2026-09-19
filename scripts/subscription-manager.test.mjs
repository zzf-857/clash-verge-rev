import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { dump, load } from 'js-yaml'

const repo = fileURLToPath(new URL('..', import.meta.url))

test('isolated manager authenticates requests, detects stale edits and restores failed writes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'clash-manager-'))
  const workspace = path.join(root, '.subscription-workspace')
  let child
  let rejectApply = false
  let holdApply
  let refreshes = 0
  const mockCore = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/providers/proxies' && request.method === 'GET') {
      response.end(
        JSON.stringify({
          providers: {
            sample: {
              proxies: [{ name: 'demo' }],
              updatedAt: '2026-09-19T12:00:00Z',
            },
          },
        }),
      )
    } else if (
      request.url === '/providers/proxies/sample' &&
      request.method === 'PUT'
    ) {
      refreshes++
      response.writeHead(204)
      response.end()
    } else if (request.url === '/configs' && request.method === 'PUT') {
      if (holdApply) {
        holdApply(response)
        return
      }
      response.writeHead(rejectApply ? 500 : 204)
      response.end()
    } else {
      response.writeHead(404)
      response.end('{}')
    }
  })
  try {
    for (const dir of [
      'scripts',
      'src/utils',
      '.subscription-workspace/profiles',
      'dist-subscription-manager',
    ])
      await mkdir(path.join(root, dir), { recursive: true })
    await symlink(
      path.join(repo, 'node_modules'),
      path.join(root, 'node_modules'),
      'dir',
    )
    for (const file of [
      'scripts/subscription-manager.mjs',
      'scripts/subscription-isolation.mjs',
      'src/utils/subscription-config.ts',
    ])
      await copyFile(path.join(repo, file), path.join(root, file))
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}')
    await writeFile(
      path.join(root, 'dist-subscription-manager/index.html'),
      '<meta name="manager-token" content="__MANAGER_TOKEN__">',
    )
    const config = {
      'mixed-port': 17897,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      'external-controller-unix': path.join(workspace, 'mihomo.sock'),
      tun: { enable: false },
      'proxy-providers': {
        sample: {
          type: 'http',
          url: 'https://example.com/sub',
          path: 'profiles/nodes.yaml',
          interval: 3600,
        },
      },
      'proxy-groups': [
        { name: 'Apps', type: 'select', proxies: ['DIRECT'], use: ['sample'] },
      ],
      rules: ['MATCH,Apps'],
    }
    await writeFile(
      path.join(workspace, 'profiles.yaml'),
      dump({
        current: 'local',
        items: [
          { uid: 'local', type: 'local', name: 'Test', file: 'local.yaml' },
        ],
      }),
    )
    await writeFile(path.join(workspace, 'profiles/local.yaml'), dump(config))
    await writeFile(path.join(workspace, 'clash-verge.yaml'), dump(config))
    await writeFile(
      path.join(workspace, 'profiles/nodes.yaml'),
      dump({
        proxies: [{ name: 'demo', type: 'http', server: '127.0.0.1', port: 9 }],
      }),
    )
    await new Promise((resolve) =>
      mockCore.listen(path.join(workspace, 'mihomo.sock'), resolve),
    )
    const reservation = http.createServer()
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve))
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    const origin = 'http://127.0.0.1:' + port
    const validator = path.join(root, 'mock-validator')
    await writeFile(validator, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    child = spawn(
      process.execPath,
      [path.join(root, 'scripts/subscription-manager.mjs')],
      {
        env: {
          ...process.env,
          SUBSCRIPTION_MANAGER_PORT: String(port),
          MIHOMO_BIN: validator,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Startup timeout: ' + stderr)),
        10000,
      )
      child.stdout.once('data', () => {
        clearTimeout(timeout)
        resolve()
      })
      child.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error('Server exited: ' + code + ' ' + stderr))
      })
    })
    const html = await (await fetch(origin)).text()
    const token = html.match(/content="([a-f0-9]+)"/)[1]
    assert.equal((await fetch(origin + '/api/subscriptions')).status, 403)
    const request = async (endpoint, body, method = 'POST') =>
      fetch(origin + '/api/' + endpoint, {
        method: body === undefined ? 'GET' : method,
        headers: {
          'Content-Type': 'application/json',
          'X-Manager-Token': token,
          Origin: origin,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    let state = await (await request('subscriptions')).json()
    assert.equal(state.sources[0].count, 1)
    assert.equal(
      (
        await fetch(origin + '/api/subscriptions', {
          headers: { Origin: 'https://example.com', 'X-Manager-Token': token },
        })
      ).status,
      403,
    )
    assert.equal((await request('refresh', { name: 'sample' })).status, 200)
    assert.equal(refreshes, 1)
    const input = {
      name: 'sample',
      url: 'https://example.com/sub',
      minutes: 30,
      groups: ['Apps'],
    }
    assert.equal(
      (
        await request('subscriptions', {
          revision: state.revision,
          input,
          originalName: 'sample',
        })
      ).status,
      200,
    )
    assert.equal(
      load(await readFile(path.join(workspace, 'profiles/local.yaml'), 'utf8'))[
        'proxy-providers'
      ].sample.interval,
      1800,
    )
    assert.equal(
      (
        await (
          await request('subscriptions', {
            revision: state.revision,
            input,
            originalName: 'sample',
          })
        ).json()
      ).error,
      'configChanged',
    )
    state = await (await request('subscriptions')).json()
    const previous = await readFile(
      path.join(workspace, 'profiles/local.yaml'),
      'utf8',
    )
    const applying = new Promise((resolve) => {
      holdApply = resolve
    })
    const pendingSave = request('subscriptions', {
      revision: state.revision,
      input: { ...input, minutes: 20 },
      originalName: 'sample',
    })
    const applyingResponse = await applying
    let duringSave
    try {
      duringSave = await request('subscriptions')
    } finally {
      holdApply = undefined
      applyingResponse.writeHead(500)
      applyingResponse.end()
      await pendingSave
    }
    assert.equal(duringSave.status, 409)
    assert.equal((await duringSave.json()).error, 'busy')
    rejectApply = true
    assert.equal(
      (
        await (
          await request('subscriptions', {
            revision: state.revision,
            input: { ...input, minutes: 15 },
            originalName: 'sample',
          })
        ).json()
      ).error,
      'applyFailed',
    )
    assert.equal(
      await readFile(path.join(workspace, 'profiles/local.yaml'), 'utf8'),
      previous,
    )
    assert.equal(
      await readFile(path.join(workspace, 'clash-verge.yaml'), 'utf8'),
      previous,
    )
    await writeFile(
      path.join(workspace, 'clash-verge.yaml'),
      dump({
        ...config,
        tun: { enable: true },
      }),
    )
    state = await (await request('subscriptions')).json()
    const unsafeResult = await request('subscriptions', {
      revision: state.revision,
      input,
      originalName: 'sample',
    })
    assert.equal((await unsafeResult.json()).error, 'validationFailed')
    assert.equal(
      load(await readFile(path.join(workspace, 'clash-verge.yaml'), 'utf8')).tun
        .enable,
      true,
    )
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve))
      child.kill()
      await exited
    }
    await new Promise((resolve) => mockCore.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
