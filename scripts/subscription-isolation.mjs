import net from 'node:net'
import dgram from 'node:dgram'
import path from 'node:path'
import { lstat, readdir, realpath, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

function refuse(field) {
  throw new Error(`Runtime isolation violation: ${field}`)
}

async function assertPrivateTree(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name)
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
      refuse('linked workspace file')
    if (stat.isDirectory()) await assertPrivateTree(file)
  }
}

function assertRelativePath(value, configDir, field) {
  if (
    typeof value !== 'string' ||
    !value ||
    path.isAbsolute(value) ||
    !path.resolve(configDir, value).startsWith(configDir + path.sep)
  )
    refuse(field)
}

export async function assertIsolatedRuntime(content, { configDir }) {
  configDir = path.resolve(configDir)
  if ((await realpath(configDir)) !== configDir)
    refuse('linked workspace directory')
  await assertPrivateTree(configDir)
  let config
  try {
    config = load(content)
  } catch {
    refuse('invalid YAML')
  }
  if (config?.tun?.enable !== false) refuse('tun.enable must be false')
  for (const key of ['auto-route', 'auto-redirect']) {
    if (config.tun[key] !== undefined && config.tun[key] !== false)
      refuse(`tun.${key}`)
  }
  if (config['mixed-port'] !== 17897) refuse('mixed-port must be 17897')
  for (const key of ['port', 'socks-port', 'redir-port', 'tproxy-port']) {
    if (config[key] !== undefined && config[key] !== 0) refuse(key)
  }
  if (config['allow-lan'] !== false || config['bind-address'] !== '127.0.0.1')
    refuse('loopback listeners required')
  for (const key of [
    'external-controller',
    'external-controller-tls',
    'external-controller-pipe',
  ]) {
    if (config[key] !== undefined && config[key] !== '') refuse(key)
  }
  if (
    config['external-controller-unix'] !==
    path.join(path.resolve(configDir), 'mihomo.sock')
  )
    refuse('external-controller-unix')
  for (const key of ['listeners', 'tunnels']) {
    if (
      config[key] !== undefined &&
      (!Array.isArray(config[key]) || config[key].length)
    )
      refuse(key)
  }
  if (
    config.dns?.listen !== undefined &&
    config.dns.listen !== '127.0.0.1:17895'
  )
    refuse('dns.listen')
  for (const section of ['proxy-providers', 'rule-providers']) {
    for (const provider of Object.values(config[section] ?? {})) {
      if (provider.path === undefined) continue
      assertRelativePath(provider.path, configDir, `${section} cache path`)
    }
  }
  if (config['external-ui'])
    assertRelativePath(config['external-ui'], configDir, 'external-ui path')
}

async function assertAvailable(configDir) {
  try {
    await lstat(path.join(configDir, 'mihomo.sock'))
    refuse(
      'controller socket already exists; stop its owner or remove a stale socket manually',
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const port = Number(process.env.SUBSCRIPTION_MANAGER_PORT ?? 17891)
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    [17897, 17895].includes(port)
  )
    refuse('manager port')
  for (const [protocol, number] of [
    ['tcp', port],
    ['tcp', 17897],
    ['udp', 17897],
    ['tcp', 17895],
    ['udp', 17895],
  ]) {
    await new Promise((resolve, reject) => {
      const listener =
        protocol === 'tcp' ? net.createServer() : dgram.createSocket('udp4')
      listener.once('error', () => {
        if (protocol === 'udp') listener.close()
        reject(
          new Error(
            `Runtime isolation: ${protocol} port ${number} unavailable`,
          ),
        )
      })
      const ready = () => listener.close(resolve)
      if (protocol === 'tcp') listener.listen(number, '127.0.0.1', ready)
      else listener.bind(number, '127.0.0.1', ready)
    })
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const configDir = process.argv[2]
    await assertIsolatedRuntime(
      await readFile(path.join(configDir, 'clash-verge.yaml'), 'utf8'),
      { configDir },
    )
    await assertAvailable(configDir)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
