// watch_service.mjs — 常驻截图：一边抓一边把分组状态写到 groups.json
// 用法: node watch_service.mjs [root] [minutes]
import * as core from './core.mjs'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'

const root = process.argv[2] || 'D:/dsh-video-tools/livewatch'
const minutes = Number(process.argv[3] || 30)
const stateFile = path.join(root, 'groups.json')

const session = new core.WatchSession({ root, processName: 'douyin', intervalMs: 1000 })
await session.start()
console.log(`watching -> ${root}`)

const endAt = Date.now() + minutes * 60 * 1000
while (Date.now() < endAt) {
  await new Promise((r) => setTimeout(r, 2000))
  const state = session.state()
  const groups = session.tracker.groups.map((g) => ({
    id: g.id,
    from: g.start,
    to: g.end,
    frames: g.frames.length,
    dir: g.dir,
    title: g.titleText || '',
  }))
  await writeFile(stateFile, JSON.stringify({
    at: new Date().toISOString(),
    capturedFrames: state.count,
    skippedDark: state.skippedDark,
    lastError: state.lastError,
    groups,
  }, null, 1), 'utf8')
}

await session.stop()
console.log('stopped')
