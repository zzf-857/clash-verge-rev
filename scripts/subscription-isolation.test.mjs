import assert from 'node:assert/strict'
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  link,
  readFile,
  copyFile,
  access,
} from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

async function fixture(t) {
  const configDir = await mkdtemp(
    path.join(os.tmpdir(), 'subscription-isolation-'),
  )
  t.after(() => rm(configDir, { recursive: true, force: true }))
  await mkdir(path.join(configDir, 'profiles'))
  return {
    configDir,
    config: {
      tun: { enable: false, 'auto-route': false, 'auto-redirect': false },
      'mixed-port': 17897,
      'allow-lan': false,
      'bind-address': '127.0.0.1',
      'external-controller-unix': path.join(configDir, 'mihomo.sock'),
      dns: { enable: true, listen: '127.0.0.1:17895' },
      'proxy-providers': {
        example: { type: 'http', path: 'profiles/example.yaml' },
      },
    },
  }
}

async function launcherFixture(t, { unsafe = false, ready = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'si-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const configDir = path.join(root, '.subscription-workspace')
  await mkdir(configDir)
  await mkdir(path.join(root, 'scripts'))
  await mkdir(path.join(root, 'dist-subscription-manager'))
  await writeFile(
    path.join(root, 'dist-subscription-manager/index.html'),
    'mock',
  )
  const config = {
    tun: { enable: unsafe },
    'mixed-port': 17897,
    'allow-lan': false,
    'bind-address': '127.0.0.1',
    'external-controller-unix': path.join(configDir, 'mihomo.sock'),
    dns: { enable: true, listen: '127.0.0.1:17895' },
  }
  await writeFile(
    path.join(configDir, 'clash-verge.yaml'),
    JSON.stringify(config),
  )
  const mock = path.join(root, 'mock-core')
  await writeFile(
    mock,
    `#!${process.execPath}\nimport fs from 'node:fs'; import net from 'node:net'; fs.writeFileSync(${JSON.stringify(path.join(root, 'core-started'))}, String(process.pid)); ${ready ? `net.createServer().listen(${JSON.stringify(config['external-controller-unix'])});` : ''} setInterval(() => {}, 1000);`,
    { mode: 0o700 },
  )
  await writeFile(
    path.join(root, 'scripts/subscription-manager.mjs'),
    `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'manager-started'))}, String(process.pid)); setInterval(() => {}, 1000);`,
  )
  const original = await readFile(
    new URL('./start-subscription-manager.sh', import.meta.url),
    'utf8',
  )
  // Replace the absolute executable in the copy: tests can never invoke a real core.
  await writeFile(
    path.join(root, 'scripts/start-subscription-manager.sh'),
    original.replaceAll('/usr/bin/verge-mihomo', mock),
  )
  await copyFile(
    new URL('./subscription-isolation.mjs', import.meta.url),
    path.join(root, 'scripts/subscription-isolation.mjs'),
  )
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    path.join(root, 'node_modules'),
  )
  let child
  t.after(() => {
    if (child && child.exitCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }
  })
  return {
    root,
    configDir,
    start(env = {}) {
      child = spawn(
        'bash',
        [path.join(root, 'scripts/start-subscription-manager.sh')],
        {
          detached: true,
          env: { ...process.env, SUBSCRIPTION_STARTUP_TIMEOUT: '1', ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let output = ''
      child.stdout.on('data', (chunk) => {
        output += chunk
      })
      child.stderr.on('data', (chunk) => {
        output += chunk
      })
      const result = new Promise((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal, output })),
      )
      return { child, result }
    },
  }
}

async function exited(result, milliseconds = 3000) {
  return Promise.race([
    result,
    delay(milliseconds).then(() => {
      throw new Error('launcher did not exit before deadline')
    }),
  ])
}

test('launcher rejects unsafe config before executing its core', async (t) => {
  const fixture = await launcherFixture(t, { unsafe: true })
  const { result } = fixture.start()
  await delay(250)
  await assert.rejects(
    access(path.join(fixture.root, 'core-started')),
    /ENOENT/,
  )
  const outcome = await exited(result)
  assert.notEqual(outcome.code, 0)
  assert.match(outcome.output, /isolation/i)
})

test('launcher refuses occupied manager, proxy, DNS ports and existing socket without touching them', async (t) => {
  for (const [protocol, port] of [
    ['tcp', 17891],
    ['tcp', 17897],
    ['udp', 17897],
    ['tcp', 17895],
    ['udp', 17895],
  ]) {
    const listener =
      protocol === 'tcp' ? net.createServer() : dgram.createSocket('udp4')
    await new Promise((resolve, reject) => {
      listener.once('error', reject)
      protocol === 'tcp'
        ? listener.listen(port, '127.0.0.1', resolve)
        : listener.bind(port, '127.0.0.1', resolve)
    })
    try {
      const fixture = await launcherFixture(t)
      const { result } = fixture.start()
      const outcome = await exited(result)
      assert.notEqual(outcome.code, 0)
      assert.match(outcome.output, /port.*unavailable/i)
      await assert.rejects(
        access(path.join(fixture.root, 'core-started')),
        /ENOENT/,
      )
    } finally {
      await new Promise((resolve) => listener.close(resolve))
    }
  }
  const fixture = await launcherFixture(t)
  const socket = path.join(fixture.configDir, 'mihomo.sock')
  const listener = net.createServer()
  await new Promise((resolve) => listener.listen(socket, resolve))
  t.after(() => new Promise((resolve) => listener.close(resolve)))
  const outcome = await exited(fixture.start().result)
  assert.notEqual(outcome.code, 0)
  assert.match(outcome.output, /socket.*exists/i)
  await access(socket)
  await assert.rejects(
    access(path.join(fixture.root, 'core-started')),
    /ENOENT/,
  )
})

test('launcher times out without starting manager and reaps its child', async (t) => {
  const fixture = await launcherFixture(t)
  const outcome = await exited(fixture.start().result)
  assert.notEqual(outcome.code, 0)
  assert.match(outcome.output, /timed out/i)
  await assert.rejects(
    access(path.join(fixture.root, 'manager-started')),
    /ENOENT/,
  )
  const pid = Number(
    await readFile(path.join(fixture.root, 'core-started'), 'utf8'),
  )
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await readFile(file, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(20)
  }
  throw new Error('mock did not start')
}

test('launcher SIGTERM stops and reaps both core and manager', async (t) => {
  const fixture = await launcherFixture(t, { ready: true })
  const { child, result } = fixture.start()
  const managerPid = Number(
    await waitForFile(path.join(fixture.root, 'manager-started')),
  )
  const corePid = Number(
    await readFile(path.join(fixture.root, 'core-started'), 'utf8'),
  )
  child.kill('SIGTERM')
  const outcome = await exited(result)
  assert.notEqual(outcome.code, 0)
  for (const pid of [corePid, managerPid])
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('launcher bounds cleanup even when both children ignore SIGTERM', async (t) => {
  const fixture = await launcherFixture(t, { ready: true })
  for (const file of ['mock-core', 'scripts/subscription-manager.mjs']) {
    const target = path.join(fixture.root, file)
    await writeFile(
      target,
      (await readFile(target, 'utf8')) + "\nprocess.on('SIGTERM', () => {});\n",
    )
  }
  const { child, result } = fixture.start()
  const managerPid = Number(
    await waitForFile(path.join(fixture.root, 'manager-started')),
  )
  const corePid = Number(
    await readFile(path.join(fixture.root, 'core-started'), 'utf8'),
  )
  child.kill('SIGTERM')
  const outcome = await exited(result, 4000)
  assert.notEqual(outcome.code, 0)
  for (const pid of [corePid, managerPid])
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('launcher exits when core dies after readiness and removes its own socket', async (t) => {
  const fixture = await launcherFixture(t, { ready: true })
  const { result } = fixture.start()
  const managerPid = Number(
    await waitForFile(path.join(fixture.root, 'manager-started')),
  )
  const corePid = Number(
    await readFile(path.join(fixture.root, 'core-started'), 'utf8'),
  )
  process.kill(corePid, 'SIGTERM')
  const outcome = await exited(result)
  assert.notEqual(outcome.code, 0)
  assert.throws(() => process.kill(managerPid, 0), { code: 'ESRCH' })
  await assert.rejects(
    access(path.join(fixture.configDir, 'mihomo.sock')),
    /ENOENT/,
  )
})

test('launcher rejects invalid timeout before executing its core', async (t) => {
  const fixture = await launcherFixture(t)
  const outcome = await exited(
    fixture.start({ SUBSCRIPTION_STARTUP_TIMEOUT: 'invalid' }).result,
  )
  assert.notEqual(outcome.code, 0)
  // Wait to expose a core spawn racing the immediate validation failure.
  await delay(100)
  await assert.rejects(
    access(path.join(fixture.root, 'core-started')),
    /ENOENT/,
  )
  await assert.rejects(
    access(path.join(fixture.configDir, 'core.log')),
    /ENOENT/,
  )
})

test('launcher propagates manager failure and reaps the core', async (t) => {
  const fixture = await launcherFixture(t, { ready: true })
  await writeFile(
    path.join(fixture.root, 'scripts/subscription-manager.mjs'),
    'process.exit(7)',
  )
  const outcome = await exited(fixture.start().result)
  assert.equal(outcome.code, 7)
  const corePid = Number(
    await readFile(path.join(fixture.root, 'core-started'), 'utf8'),
  )
  assert.throws(() => process.kill(corePid, 0), { code: 'ESRCH' })
})

test('launcher reports an early core failure without starting manager', async (t) => {
  const fixture = await launcherFixture(t)
  await writeFile(
    path.join(fixture.root, 'mock-core'),
    `#!${process.execPath}\nprocess.exit(7)`,
    { mode: 0o700 },
  )
  const outcome = await exited(fixture.start().result)
  assert.notEqual(outcome.code, 0)
  assert.match(outcome.output, /failed to start/i)
  await assert.rejects(
    access(path.join(fixture.root, 'manager-started')),
    /ENOENT/,
  )
})

test('runtime guard contains downloaded dashboard paths', async (t) => {
  const { configDir, config } = await fixture(t)
  const validate = await validator()
  for (const externalUI of ['/tmp/shared-ui', '../outside-ui']) {
    await assert.rejects(
      validate(JSON.stringify({ ...config, 'external-ui': externalUI }), {
        configDir,
      }),
      /isolation/i,
    )
  }
  await validate(JSON.stringify({ ...config, 'external-ui': 'ui' }), {
    configDir,
  })
})

test('launcher never prints malformed private configuration in errors', async (t) => {
  const fixture = await launcherFixture(t)
  await writeFile(
    path.join(fixture.configDir, 'clash-verge.yaml'),
    'secret: [private-subscription-token\n broken: yes',
  )
  const outcome = await exited(fixture.start().result)
  assert.notEqual(outcome.code, 0)
  assert.doesNotMatch(outcome.output, /private-subscription-token/)
  assert.match(outcome.output, /invalid YAML/i)
})

async function validator() {
  const module = await import('./subscription-isolation.mjs').catch((error) => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return {}
    throw error
  })
  assert.equal(
    typeof module.assertIsolatedRuntime,
    'function',
    'runtime isolation guard must exist',
  )
  return module.assertIsolatedRuntime
}

test('runtime guard rejects non-isolated listeners and controllers', async (t) => {
  const { configDir, config } = await fixture(t)
  const validate = await validator()
  const unsafe = [
    { tun: { enable: false, 'auto-route': true } },
    { tun: { enable: false, 'auto-redirect': true } },
    { 'mixed-port': 7897 },
    { port: 7890 },
    { 'socks-port': 7891 },
    { 'redir-port': 7892 },
    { 'tproxy-port': 7893 },
    { 'allow-lan': true },
    { 'bind-address': '*' },
    { 'external-controller': '127.0.0.1:9090' },
    { 'external-controller-tls': ':9091' },
    { 'external-controller-pipe': 'shared' },
    { 'external-controller-unix': '/tmp/verge/verge-mihomo.sock' },
    { listeners: [{ name: 'extra', port: 7898 }] },
    { tunnels: ['tcp/udp,0.0.0.0:8080,example.org:80,DIRECT'] },
    { dns: { enable: true, listen: '0.0.0.0:17895' } },
    { dns: { enable: true, listen: '127.0.0.1:53' } },
  ]
  for (const override of unsafe) {
    await assert.rejects(
      validate(JSON.stringify({ ...config, ...override }), { configDir }),
      /isolation/i,
      JSON.stringify(override),
    )
  }
})

test('runtime guard contains provider caches and rejects linked workspace files', async (t) => {
  const { configDir, config } = await fixture(t)
  const validate = await validator()
  for (const section of ['proxy-providers', 'rule-providers']) {
    for (const cache of [
      '/tmp/shared.yaml',
      '../escape.yaml',
      'profiles/../../escape.yaml',
    ]) {
      const candidate = {
        ...config,
        [section]: { example: { type: 'http', path: cache } },
      }
      await assert.rejects(
        validate(JSON.stringify(candidate), { configDir }),
        /isolation/i,
      )
    }
  }
  await symlink(path.dirname(configDir), path.join(configDir, 'linked'))
  config['proxy-providers'].example.path = 'linked/not-created/cache.yaml'
  await assert.rejects(
    validate(JSON.stringify(config), { configDir }),
    /isolation/i,
  )
  await rm(path.join(configDir, 'linked'))
  config['proxy-providers'].example.path = 'profiles/example.yaml'
  for (const name of [
    'cache.db',
    'core.log',
    'manager.lock',
    'clash-verge.yaml',
    'mihomo.sock',
  ]) {
    await symlink('/nonexistent/outside', path.join(configDir, name))
    await assert.rejects(
      validate(JSON.stringify(config), { configDir }),
      /isolation/i,
      name,
    )
    await rm(path.join(configDir, name))
  }
  await writeFile(path.join(configDir, 'profiles/original.yaml'), 'cache')
  await link(
    path.join(configDir, 'profiles/original.yaml'),
    path.join(configDir, 'cache.db'),
  )
  await assert.rejects(
    validate(JSON.stringify(config), { configDir }),
    /isolation/i,
  )
  await rm(path.join(configDir, 'cache.db'))
  const alias = `${configDir}-alias`
  await symlink(configDir, alias)
  t.after(() => rm(alias, { force: true }))
  await assert.rejects(
    validate(JSON.stringify(config), { configDir: alias }),
    /isolation/i,
  )
})

test('runtime guard accepts the private runtime and refuses enabled TUN', async (t) => {
  const { configDir, config } = await fixture(t)
  const validate = await validator()
  await validate(JSON.stringify(config), { configDir })
  config.tun.enable = true
  await assert.rejects(
    validate(JSON.stringify(config), { configDir }),
    /isolation.*tun/i,
  )
})
