// harness.mjs — 不装进 DSH 也能验插件：伪造 ctx，把工具跑一遍
// 用法: node harness.mjs [进程名]
import path from 'node:path'
import * as plugin from './dsh-plugin.mjs'

const processName = process.argv[2] || 'douyin'
const tools = new Map()

const saved = []
const ctx = {
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  get(key) {
    if (key === 'attachments') {
      return {
        async saveImages(images) {
          for (const img of images) saved.push({ bytes: img.data?.length ?? 0, mediaType: img.mediaType })
          return images.map((_, i) => ({ attachmentId: `fake-${i}` }))
        },
      }
    }
    if (key === 'llm') {
      return { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } }
    }
    return undefined
  },
}

const dispose = plugin.apply(ctx)
const exec = { agent: { options: { provider: 'fake', model: 'fake-vision' } } }

async function call(name, args = {}) {
  const definition = tools.get(name)
  if (!definition) throw new Error(`工具不存在: ${name}`)
  const value = await definition.execute(args, exec)
  const text = definition.output.render(args, value)
  const imageBlocks = text.filter((block) => block.type === 'image').length
  console.log(`\n== ${name} ==`)
  console.log('  imageStatus:', value.imageStatus)
  console.log('  images:', imageBlocks, ' attachments:', value.images?.length ?? 0)
  console.log('  result:', JSON.stringify(value.result).slice(0, 400))
  return value
}

try {
  console.log('注册的工具:', [...tools.keys()].join(', '))
  await call('screen_watch_start', { process: processName, intervalMs: 900 })
  await new Promise((resolve) => setTimeout(resolve, 9000))
  await call('screen_watch_videos')
  await call('screen_watch_video', { process: processName, maxFrames: 48 })
  await call('screen_watch_latest', { process: processName })
  await call('screen_watch_audio_check')
  console.log('\n送进"模型"的图片总数:', saved.length)
  await call('screen_watch_stop')
} finally {
  dispose()
}
