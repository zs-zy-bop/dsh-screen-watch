#!/usr/bin/env node
// install-local.mjs — 把 dsh-screen-watch 挂进某个 DSH profile（本机验证用）
// 用法: node install-local.mjs [profile 名，默认 web]
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const profileName = process.argv[2] || 'web'
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const profileDir = path.join(home, 'profiles', profileName)
const pkgPath = path.join(profileDir, 'package.json')
const self = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')))

const raw = await readFile(pkgPath, 'utf8')
const pkg = JSON.parse(raw)
pkg.dependencies = pkg.dependencies || {}
pkg.dependencies['dsh-screen-watch'] = `link:${self.replace(/\\/g, '/')}`
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
const bundles = new Set(pkg.dsh.profile.bundles || [])
bundles.add('dsh-screen-watch')
pkg.dsh.profile.bundles = [...bundles]
await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log(`已把 dsh-screen-watch 写入 ${pkgPath}`)

const pnpm = process.env.DSH_PNPM || 'pnpm'
try {
  const { stdout } = await execFileAsync(pnpm, ['install', '--dir', profileDir], { windowsHide: true, timeout: 600000 })
  console.log(stdout.split('\n').slice(-4).join('\n'))
  console.log('装好了。重启 DSH（桌面版要整个退出再开）后生效。')
} catch (err) {
  console.log(`pnpm 没跑起来：${err.message}`)
  console.log(`请手动在 ${profileDir} 里执行 pnpm install`)
}
