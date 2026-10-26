// demo_groups.mjs — 抓 30 秒，按分组各拼一张图，并打印分组结果
import * as core from './core.mjs'
import path from 'node:path'

const root = process.argv[2] || 'D:/dsh-video-tools/groupdemo'
const seconds = Number(process.argv[3] || 30)

const session = new core.WatchSession({ root, processName: 'douyin', intervalMs: 1000 })
await session.start()
await new Promise((r) => setTimeout(r, seconds * 1000))
const state = await session.stop()

const groups = session.tracker.groups
const out = []
for (const group of groups) {
  const sheets = await core.montage(group.frames, path.join(group.dir, 'sheet'), { cols: 6, rows: 4, tileWidth: 220 })
  out.push({
    id: group.id,
    frames: group.frames.length,
    from: group.start,
    to: group.end,
    sheets,
  })
}

console.log(JSON.stringify({
  capturedFrames: state.count,
  lastError: state.lastError,
  groups: out,
}, null, 1))
