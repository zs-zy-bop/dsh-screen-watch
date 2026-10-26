// core.mjs — capture one window only (Windows), group frames into videos
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const execFileAsync = promisify(execFile)
const PS1 = fileURLToPath(new URL('./capture.ps1', import.meta.url))
const MONTAGE = fileURLToPath(new URL('./montage.ps1', import.meta.url))
const OCR_PS1 = fileURLToPath(new URL('./ocr.ps1', import.meta.url))

export function defaultRoot() {
  return process.env.DSH_SCREEN_WATCH_DIR || path.join(os.homedir(), '.dsh', 'screen-watch')
}

export async function captureWindow(processName, outFile) {
  await mkdir(path.dirname(outFile), { recursive: true })
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Process', processName, '-Out', outFile],
    { windowsHide: true, timeout: 20000 },
  )
  const line = stdout.trim().split(/\r?\n/).pop()
  const info = JSON.parse(line)
  if (!info.ok) throw new Error(info.error || 'capture failed')
  return info
}

/**
 * 常驻截图进程：一个 PowerShell 循环按间隔截，逐行吐 JSON。
 * 比"每帧起一个进程"快得多，也是能真正做到一秒一帧的关键。
 */
export class CaptureStream {
  constructor({ processName, outFile, intervalMs = 1000, onFrame, onError }) {
    this.processName = processName
    this.outFile = outFile
    this.intervalMs = intervalMs
    this.onFrame = onFrame
    this.onError = onError
    this.child = null
  }

  async start() {
    if (this.child) return
    await mkdir(path.dirname(this.outFile), { recursive: true })
    this.child = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-Process', this.processName, '-Out', this.outFile,
      '-Loop', '1', '-IntervalMs', String(this.intervalMs),
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

    const rl = createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const text = line.trim()
      if (!text) return
      try {
        const info = JSON.parse(text)
        if (!info.ok) { this.onError?.(new Error(info.error || 'capture failed')); return }
        this.onFrame?.(info)
      } catch (err) {
        this.onError?.(err)
      }
    })
    this.child.stderr.on('data', (buf) => this.onError?.(new Error(buf.toString().trim())))
    this.child.on('exit', () => { this.child = null })
  }

  stop() {
    if (this.child) {
      this.child.kill()
      this.child = null
    }
  }

  get running() {
    return Boolean(this.child)
  }
}

function popcount64(x) {
  let v = x
  let n = 0
  while (v !== 0n) {
    v &= v - 1n
    n += 1
  }
  return n
}

export function distance(a, b) {
  return popcount64(BigInt(a) ^ BigInt(b))
}

/**
 * Frames to video groups.
 * A cut needs the bottom author/title strip to change (metaHash) and the next frame to agree.
 * Groups shorter than minFrames are merged back; at most maxVideos groups are kept.
 */
export class VideoTracker {
  constructor({ root, maxVideos = 5, threshold = 14, metaThreshold = 8, minFrames = 3 }) {
    this.root = root
    this.maxVideos = maxVideos
    this.threshold = threshold
    this.metaThreshold = metaThreshold
    this.minFrames = minFrames
    this.groups = []
    this.seq = 0
    this.pendingCut = false
    this.lastError = ''
  }

  async reset() {
    await rm(path.join(this.root, 'videos'), { recursive: true, force: true })
    await mkdir(path.join(this.root, 'videos'), { recursive: true })
    this.groups = []
    this.seq = 0
    this.pendingCut = false
  }

  async store(dir, file) {
    await mkdir(dir, { recursive: true })
    const target = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 6)}.jpg`)
    await execFileAsync('cmd', ['/c', 'copy', '/y', file, target], { windowsHide: true })
    return target
  }

  async add(file, hash, metaHash, stripFile, railHash, timerFile) {
    const now = new Date().toISOString()
    const current = this.groups.at(-1)

    // 每帧都读标题条太贵：画面变化时、或每四帧读一次，够用来抓时间和标题
    this.frameNo = (this.frameNo || 0) + 1
    let far
    if (!current) far = true
    else if (metaHash && current.lastMetaHash) far = distance(metaHash, current.lastMetaHash) > this.metaThreshold
    else far = distance(hash, current.lastHash) > this.threshold

    const wantOcr = Boolean(stripFile) && (!current || far || this.frameNo % 4 === 0)
    const rawText = wantOcr ? await ocrStrip(stripFile) : ''
    const text = rawText.replace(/\s+/g, '')
    // 时间单独读：只裁左下角那一条，且不做二值化，读出 "01:43 / 04:34" 这类
    const timerText = Boolean(timerFile) && (!current || far || this.frameNo % 3 === 0)
      ? await ocrStrip(timerFile, { binary: false })
      : ''
    const times = timerText ? parseTimes(timerText) : null
    if (text) this.lastTitleText = text

    let cut = false
    if (!current) {
      cut = true
    } else {
      // 1) 总时长变了：几乎必然是另一条。为了防 OCR 偶尔读错，得连读两次都一致才切
      if (times && times.total && current.total && Math.abs(times.total - current.total) >= 2) {
        if (this.pendingTotal === times.total) {
          cut = true
        } else {
          this.pendingTotal = times.total
        }
      // 2) 进度往回跳：重播或者换了新的一条
      } else if (times && times.cur != null && current.lastCur != null && times.cur + 3 < current.lastCur) {
        cut = true
      // 3) 右侧点赞/评论/收藏那一列没变：还是同一条，后面都不用看
      } else if (railHash && current.lastRailHash && distance(railHash, current.lastRailHash) <= 6) {
        cut = false
      // 4) 画面和标题都说变了，且新标题连着两次读到：才切
      } else if (far && this.pendingCut) {
        let same = false
        if (text && current.titleText && textSimilarity(text, current.titleText) >= 0.5) {
          same = true
          this.pendingTitle = ''
        } else if (text && this.pendingTitle && textSimilarity(text, this.pendingTitle) >= 0.6) {
          same = false
        } else if (text) {
          this.pendingTitle = text
          same = true
        } else {
          same = true
        }
        cut = !same
      }
    }
    this.pendingCut = far

    if (cut && current && current.frames.length < this.minFrames && this.groups.length > 1) {
      const prev = this.groups.at(-2)
      for (const f of current.frames) {
        try {
          prev.frames.push(await this.store(prev.dir, f))
        } catch {
          // 搬不动就跳过这一帧
        }
      }
      prev.end = current.end
      prev.lastHash = current.lastHash
      prev.lastMetaHash = current.lastMetaHash
      if (!prev.titleText && current.titleText) prev.titleText = current.titleText
      this.groups.pop()
      await rm(current.dir, { recursive: true, force: true }).catch(() => {})
    }

    if (cut) {
      const id = `v${String(++this.seq).padStart(3, '0')}`
      const dir = path.join(this.root, 'videos', id)
      const target = await this.store(dir, file)
      const title = stripFile ? await this.storeStrip(dir, stripFile) : null
      const group = {
        id, dir, start: now, end: now, lastHash: hash, lastMetaHash: metaHash,
        frames: [target], title, titleText: text || '',
        lastRailHash: railHash || '', total: times?.total ?? current?.total ?? null,
        lastCur: times?.cur ?? null,
      }
      this.pendingTitle = ''
      this.pendingTotal = null
      this.groups.push(group)
      await this.prune()
      return group
    }

    const target = await this.store(current.dir, file)
    current.frames.push(target)
    current.end = now
    current.lastHash = hash
    current.lastMetaHash = metaHash
    if (railHash) current.lastRailHash = railHash
    this.pendingTotal = null
    if (times) {
      if (times.cur != null) current.lastCur = times.cur
      if (!current.total) current.total = times.total
      else current.total = times.total
      if (text) current.titleText = text
    }
    return current
  }

  async storeStrip(dir, stripFile) {
    try {
      const target = path.join(dir, 'title.jpg')
      await execFileAsync('cmd', ['/c', 'copy', '/y', stripFile, target], { windowsHide: true })
      return target
    } catch {
      return null
    }
  }

  async prune() {
    while (this.groups.length > this.maxVideos) {
      const drop = this.groups.shift()
      await rm(drop.dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  sample(group, count = 6) {
    const step = Math.max(1, Math.floor(group.frames.length / count))
    const picked = []
    for (let i = 0; i < group.frames.length && picked.length < count; i += step) picked.push(group.frames[i])
    return picked
  }

  list() {
    return this.groups.map((g) => ({ id: g.id, start: g.start, end: g.end, frames: g.frames.length }))
  }
}

export class WatchSession {
  constructor({ root, processName, intervalMs = 1000, maxVideos = 5 }) {
    this.root = root
    this.processName = processName
    this.intervalMs = intervalMs
    this.tracker = new VideoTracker({ root, maxVideos })
    this.stream = null
    this.count = 0
    this.skippedDark = 0
    this.startedAt = null
    this.lastError = ''
    this.latest = path.join(root, 'latest.jpg')
    this.queue = Promise.resolve()
  }

  async start() {
    if (this.stream?.running) return this.state()
    await this.tracker.reset()
    this.startedAt = new Date().toISOString()
    this.count = 0
    this.skippedDark = 0
    this.stream = new CaptureStream({
      processName: this.processName,
      outFile: this.latest,
      intervalMs: this.intervalMs,
      onFrame: (info) => {
        // 串行处理，避免同一帧被并发写入两个分组
        this.queue = this.queue.then(() => this.handleFrame(info)).catch((err) => { this.lastError = err.message })
      },
      onError: (err) => { this.lastError = err.message },
    })
    await this.stream.start()
    return this.state()
  }

  async handleFrame(info) {
    // 黑帧/加载帧：不当作换片依据，也不存（否则会把一条视频切两半）
    if (typeof info.brightness === 'number' && info.brightness < 12) {
      this.skippedDark += 1
      return
    }
    await this.tracker.add(this.latest, info.hash, info.metaHash, this.latest + '.strip.jpg', info.railHash, this.latest + '.timer.jpg')
    this.count += 1
    this.lastError = ''
  }

  async tick() {
    try {
      const info = await captureWindow(this.processName, this.latest)
      await this.handleFrame(info)
    } catch (err) {
      this.lastError = err.message
    }
  }

  async stop() {
    this.stream?.stop()
    this.stream = null
    await this.queue.catch(() => {})
    return this.state()
  }

  state() {
    return {
      running: Boolean(this.stream?.running),
      process: this.processName,
      intervalMs: this.intervalMs,
      count: this.count,
      skippedDark: this.skippedDark,
      latest: this.latest,
      videos: this.tracker.list(),
      startedAt: this.startedAt,
      lastError: this.lastError,
    }
  }
}


/** 用 Windows 自带的 OCR 读标题条上的字（作者、合集、标题都在里面）。 */
export async function ocrStrip(imagePath, { binary = true } = {}) {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-ImagePath', imagePath,
      ...(binary ? [] : ['-NoBinary']),
    ], { windowsHide: true, timeout: 30000 })
    const line = stdout.trim().split(/\r?\n/).pop()
    const info = JSON.parse(line)
    return info.ok ? (info.text || '') : ''
  } catch {
    return ''
  }
}

const TITLE_NOISE = [
  '发一条友好的弹幕吧',
  '作者声明',
  '内容由',
  '相关搜索',
  '识别画面',
  '合集',
  '下一章',
  '引言',
  '弹幕',
  '点个赞',
].map((t) => t.replace(/[\s\p{P}\p{S}]/gu, ''))

/** 比对标题前先洗一遍：去空白标点、去进度数字、去固定模板文案。 */
/** 从 OCR 文本里抓 "2:39 / 7:46" 这种进度时间。总时长比当前进度重要得多。 */
export function parseTimes(text) {
  if (!text) return null
  const t = String(text)
    .replace(/[\uFF10-\uFF19]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[\uFF1A\uFF0F]/g, (c) => (c === '\uFF1A' ? ':' : '/'))
    .replace(/\s+/g, '')

  const full = t.match(/(\d{1,2}):(\d{2})\/(\d{1,2}):(\d{2})/)
  if (full) {
    return {
      cur: Number(full[1]) * 60 + Number(full[2]),
      total: Number(full[3]) * 60 + Number(full[4]),
    }
  }
  const totalOnly = t.match(/\/(\d{1,2}):(\d{2})/)
  if (totalOnly) {
    return { cur: null, total: Number(totalOnly[1]) * 60 + Number(totalOnly[2]) }
  }
  return null
}

function normalizeTitle(text) {
  let t = (text || '').replace(/[\s\p{P}\p{S}]/gu, '')
  t = t.replace(/[0-9]+/g, '')
  for (const noise of TITLE_NOISE) t = t.split(noise).join('')
  return t
}

/** 两个字串有多像：按字符二元组重叠算，0..1。 */
export function textSimilarity(a, b) {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (!x || !y) return 0
  if (x === y) return 1
  const grams = (t) => {
    const out = new Map()
    for (let i = 0; i < t.length - 1; i++) {
      const g = t.slice(i, i + 2)
      out.set(g, (out.get(g) || 0) + 1)
    }
    return out
  }
  const ga = grams(x)
  const gb = grams(y)
  let hit = 0
  let total = 0
  for (const [g, n] of ga) {
    total += n
    const m = gb.get(g) || 0
    hit += Math.min(n, m)
  }
  for (const n of gb.values()) total += 0
  return total ? (2 * hit) / (x.length - 1 + y.length - 1) : 0
}

export async function readImage(file) {
  const buf = await readFile(file)
  return { data: buf, mediaType: 'image/jpeg' }
}

/** Tile frames into contact sheets with timestamps. One sheet holds cols*rows frames. */
export async function montage(files, outBase, { cols = 6, rows = 8, tileWidth = 260 } = {}) {
  if (!files.length) return []
  const listFile = `${outBase}.txt`
  await mkdir(path.dirname(outBase), { recursive: true })
  await writeFile(listFile, files.join('\n'), 'utf8')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', MONTAGE,
    '-Files', listFile, '-Out', `${outBase}.jpg`,
    '-Cols', String(cols), '-Rows', String(rows), '-TileWidth', String(tileWidth),
  ], { windowsHide: true, timeout: 120000 })
  const line = stdout.trim().split(/\r?\n/).pop()
  const info = JSON.parse(line)
  await dropFile(listFile)
  if (!info.ok) throw new Error(info.error || 'montage failed')
  return info.sheets
}

export async function listVideoFiles(dir) {
  try {
    return (await readdir(dir)).filter((n) => n.endsWith('.jpg')).sort()
  } catch {
    return []
  }
}

export async function dropFile(file) {
  await unlink(file).catch(() => {})
}
