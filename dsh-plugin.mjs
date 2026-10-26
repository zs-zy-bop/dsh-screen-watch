// dsh-plugin.mjs — dsh-screen-watch：让伴侣陪你看视频
// 只截目标窗口的画面（Windows），按"一条视频一组"保存，最多留 10 条；画面能直接送进模型。
import path from 'node:path'
import {
  WatchSession, captureWindow, defaultRoot, montage, readImage,
} from './core.mjs'
import { AudioSession, checkDeps, findPython } from './audio.mjs'
import { bindPanel } from './panel-api.mjs'

export const name = 'screen-watch'
export const inject = ['tools']

const sessions = new Map()
let audio = null

async function audioSession() {
  if (audio) return audio
  const python = await findPython()
  audio = new AudioSession({ root: path.join(defaultRoot(), 'audio'), python })
  return audio
}

function service(ctx, key) {
  try { return ctx?.get?.(key) } catch { return undefined }
}

function sessionFor(processName = 'douyin') {
  const key = processName || 'douyin'
  if (!sessions.has(key)) {
    sessions.set(key, new WatchSession({
      root: path.join(defaultRoot(), key),
      processName: key,
    }))
  }
  return sessions.get(key)
}

const empty = () => ({ type: 'object', properties: {}, additionalProperties: false })

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool: { type: 'string' },
    result: { type: 'object', additionalProperties: true },
    images: { type: 'array', items: { type: 'object', additionalProperties: true } },
    imageStatus: { type: 'string' },
  },
  required: ['tool', 'result', 'images', 'imageStatus'],
}

/** 把磁盘上的 jpg 变成 DSH 的图片附件，模型才看得见。 */
async function toAttachments(ctx, exec, files) {
  if (!files.length) return { images: [], imageStatus: '这次没有画面可看。' }
  const attachments = service(ctx, 'attachments')
  const llm = service(ctx, 'llm')
  if (typeof attachments?.saveImages !== 'function') {
    return { images: [], imageStatus: '当前 DSH 没有挂载图片附件存储，模型看不到画面。' }
  }
  const route = exec.agent?.session?.requestHeader?.()?.config
  const provider = route?.provider ?? exec.agent?.options?.provider
  const model = route?.model ?? exec.agent?.options?.model
  try {
    const info = provider && model && typeof llm?.resolveModelInfo === 'function'
      ? await llm.resolveModelInfo(provider, model, exec.signal)
      : undefined
    if (info && !info?.inputModalities?.includes('image')) {
      return { images: [], imageStatus: `当前模型 ${model} 不支持图像输入。` }
    }
  } catch {
    // 查不到模型能力时，仍然尝试送图
  }
  const decoded = []
  for (const file of files) decoded.push(await readImage(file))
  try {
    const images = await attachments.saveImages(decoded)
    return { images, imageStatus: `已向模型提供 ${images.length} 张画面。` }
  } catch (err) {
    return { images: [], imageStatus: `画面没送进模型：${err.message}` }
  }
}

function render(_args, value) {
  const content = [{
    type: 'text',
    text: JSON.stringify({ tool: value.tool, ...value.result, imageStatus: value.imageStatus }, null, 2),
  }]
  for (const attachment of value.images) content.push({ type: 'image', attachment })
  return content
}

function tool(def) {
  return { ...def, output: { schema: OUTPUT_SCHEMA, render } }
}

const TOOLS = [
  tool({
    name: 'screen_watch_start',
    description: '开始只截某个应用窗口的画面（Windows 桌面版抖音等）。按"一条视频一组"自动分组，最多保留 5 条，新的进来会清掉最旧的一条。不碰播放本身。',
    parameters: {
      type: 'object',
      properties: {
        process: { type: 'string', description: '进程名，默认 douyin；抖音桌面版是 douyin.exe。' },
        intervalMs: { type: 'integer', minimum: 300, maximum: 5000, description: '截图间隔毫秒，默认 1000。' },
        maxVideos: { type: 'integer', minimum: 1, maximum: 30, description: '最多留几条视频的帧，默认 5。' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const session = sessionFor(args.process)
      if (args.intervalMs) session.intervalMs = args.intervalMs
      if (args.maxVideos) session.tracker.maxVideos = args.maxVideos
      const state = await session.start()
      return { tool: 'screen_watch_start', result: state, images: [], imageStatus: '开始截图，还没有画面。' }
    },
  }),
  tool({
    name: 'screen_watch_stop',
    description: '停止截图，返回留下的视频分组。',
    parameters: empty(),
    async execute() {
      const stopped = []
      for (const session of sessions.values()) stopped.push(await session.stop())
      return { tool: 'screen_watch_stop', result: { stopped }, images: [], imageStatus: '已停止。' }
    },
  }),
  tool({
    name: 'screen_watch_videos',
    description: '看现在分出了哪几条视频：每条的时间范围、帧数。用来判断他在刷什么。',
    parameters: empty(),
    async execute() {
      const list = []
      for (const [key, session] of sessions) {
        list.push({ process: key, ...session.state() })
      }
      return { tool: 'screen_watch_videos', result: { sessions: list }, images: [], imageStatus: '只看列表，没有取画面。' }
    },
  }),
  tool({
    name: 'screen_watch_video',
    description: '看某一条视频的完整画面：按视频长度自动决定取多少帧（每秒一帧的原始帧里均匀抽），拼成带时间戳的拼版图送进模型。可以只看其中一段（from/to）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '视频分组 id，例如 v003。省略则取最新一条。' },
        from: { type: 'integer', minimum: 0, description: '从第几秒开始看（相对这条视频开头），默认 0。' },
        to: { type: 'integer', minimum: 1, description: '看到第几秒。省略则看到结尾。' },
        maxFrames: { type: 'integer', minimum: 6, maximum: 400, description: '最多取多少帧。不填时按长度自动（约每 4 秒一帧，30–240 帧）。' },
        process: { type: 'string', description: '进程名，默认 douyin。' },
      },
      additionalProperties: false,
    },
    async execute(args = {}, exec = {}) {
      const session = sessionFor(args.process)
      const groups = session.tracker.groups
      const group = args.id ? groups.find((g) => g.id === args.id) : groups.at(-1)
      if (!group) {
        return { tool: 'screen_watch_video', result: { error: '还没有分组，先开始截图。' }, images: [], imageStatus: '没有画面。' }
      }

      // 帧按 1 秒一帧存，文件名是毫秒时间戳，可以直接按时间切
      const all = group.frames
      const msOf = (file) => Number(path.basename(file).split('_')[0])
      const startMs = msOf(all[0])
      let picked = all
      if (args.from !== undefined || args.to !== undefined) {
        const from = args.from ?? 0
        const to = args.to ?? Math.round((all.length - 1))
        picked = all.filter((file) => {
          const sec = (msOf(file) - startMs) / 1000
          return sec >= from && sec <= to
        })
      }
      if (!picked.length) {
        return { tool: 'screen_watch_video', result: { error: '这段时间里没有帧。' }, images: [], imageStatus: '没有画面。' }
      }

      const seconds = picked.length
      // 默认就是一秒一帧（帧本来就是按秒存的），一次最多铺 6 张拼版 ≈ 288 秒，
      // 更长的片子按 from/to 往下翻页，保证每一秒都落进图里。
      const limit = args.maxFrames ?? 288
      const step = Math.max(1, Math.floor(picked.length / limit))
      const sampled = picked.filter((_, i) => i % step === 0).slice(0, limit)

      let sheets = []
      try {
        sheets = await montage(sampled, path.join(group.dir, 'sheet'), { cols: 6, rows: 8, tileWidth: 260 })
      } catch (err) {
        return {
          tool: 'screen_watch_video',
          result: { id: group.id, start: group.start, end: group.end, frames: group.frames.length, error: err.message },
          images: [],
          imageStatus: `拼版失败：${err.message}`,
        }
      }
      const extras = group.title && group.title !== sheets[0] ? [group.title] : []
      const { images, imageStatus } = await toAttachments(pluginCtx, exec, [...sheets, ...extras])
      const transcriptTail = audio ? await audio.tail(12) : []
      const lastSec = Math.round((msOf(sampled.at(-1)) - startMs) / 1000)
      const totalSec = Math.round((msOf(all.at(-1)) - startMs) / 1000)
      return {
        tool: 'screen_watch_video',
        result: {
          id: group.id, start: group.start, end: group.end,
          frames: group.frames.length, durationSeconds: totalSec,
          window: { from: args.from ?? 0, to: lastSec },
          tiles: sampled.length, sheets: sheets.length,
          nextFrom: lastSec + 1 <= totalSec ? lastSec + 1 : null,
          transcriptTail,
        },
        images,
        imageStatus,
      }
    },
  }),
  tool({
    name: 'screen_watch_latest',
    description: '立刻截一张当前窗口的画面并送进模型（不改动播放）。',
    parameters: {
      type: 'object',
      properties: {
        process: { type: 'string', description: '进程名，默认 douyin。' },
      },
      additionalProperties: false,
    },
    async execute(args = {}, exec = {}) {
      const session = sessionFor(args.process)
      await session.tick()
      const { images, imageStatus } = await toAttachments(pluginCtx, exec, [session.latest])
      return { tool: 'screen_watch_latest', result: { file: session.latest, at: new Date().toISOString() }, images, imageStatus }
    },
  }),
]

let pluginCtx = null
function serviceFor(key) {
  try { return pluginCtx?.get?.(key) } catch { return undefined }
}

const AUDIO_TOOLS = [
  tool({
    name: 'screen_watch_audio_check',
    description: '检查声音层能不能用：有没有 Python、有没有录音和转写要用的包。',
    parameters: empty(),
    async execute() {
      const python = await findPython()
      const deps = await checkDeps(python)
      return { tool: 'screen_watch_audio_check', result: deps, images: [], imageStatus: '只做检查。' }
    },
  }),
  tool({
    name: 'screen_watch_audio_start',
    description: '开始录系统正在播放的声音并在本地转写（需要 Python 和 pyaudiowpatch、faster-whisper、numpy）。没有这些时只会有画面。',
    parameters: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Whisper 模型大小，默认 small。' },
        chunk: { type: 'integer', minimum: 5, maximum: 120, description: '每段多少秒，默认 20。' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const session = await audioSession()
      if (args.model) session.model = args.model
      if (args.chunk) session.chunk = args.chunk
      const deps = await checkDeps(session.python)
      if (!deps.ok) {
        return {
          tool: 'screen_watch_audio_start',
          result: { started: false, deps },
          images: [],
          imageStatus: '声音层不可用，画面照常。',
        }
      }
      const state = await session.start()
      return { tool: 'screen_watch_audio_start', result: state, images: [], imageStatus: '开始录音并转写。' }
    },
  }),
  tool({
    name: 'screen_watch_audio_stop',
    description: '停止录音与转写。',
    parameters: empty(),
    async execute() {
      const session = await audioSession()
      const state = await session.stop()
      return { tool: 'screen_watch_audio_stop', result: state, images: [], imageStatus: '已停止。' }
    },
  }),
  tool({
    name: 'screen_watch_transcript',
    description: '读最近的转写文字（声音层没开时为空）。',
    parameters: {
      type: 'object',
      properties: {
        lines: { type: 'integer', minimum: 1, maximum: 200, description: '取最后几行，默认 20。' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const session = await audioSession()
      const rows = await session.tail(args.lines ?? 20)
      return { tool: 'screen_watch_transcript', result: { lines: rows }, images: [], imageStatus: '只有文字。' }
    },
  }),
]

export function apply(ctx) {
  pluginCtx = ctx
  const disposers = []
  for (const definition of [...TOOLS, ...AUDIO_TOOLS]) disposers.push(ctx.tools.register(definition))

  // 设置面板：状态、缩略图、开始/暂停
  try {
    disposers.push(bindPanel(ctx, {
      sessions,
      getAudio: () => audio,
      startSession: async () => {
        const session = sessionFor('douyin')
        return await session.start()
      },
      stopSessions: async () => {
        const stopped = []
        for (const session of sessions.values()) stopped.push(await session.stop())
        return stopped
      },
    }))
  } catch {
    // 宿主没有 WebServer 时，面板不可用，但工具照常
  }

  return () => { for (const dispose of disposers) dispose() }
}
