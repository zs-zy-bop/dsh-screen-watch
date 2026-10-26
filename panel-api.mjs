// panel-api.mjs — 给设置面板用的 HTTP 接口：状态、缩略图、开始/暂停
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { defaultRoot } from './core.mjs'

export const PANEL_PREFIX = '/api/screen-watch'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function listGroups(sessions) {
  const out = []
  for (const [processName, session] of sessions) {
    for (const group of session.tracker.groups) {
      out.push({
        process: processName,
        id: group.id,
        from: group.start,
        to: group.end,
        frames: group.frames.length,
        title: group.titleText || '',
        cover: group.title || group.frames[0],
      })
    }
  }
  return out.reverse()
}

export function createPanelRoute({ sessions, getAudio, startSession, stopSessions }) {
  return async function handler(request) {
    const url = new URL(request.url, 'http://127.0.0.1')
    const route = url.pathname.slice(PANEL_PREFIX.length)

    if (route === '/state' && request.method === 'GET') {
      const audio = getAudio ? getAudio() : null
      return json({
        ok: true,
        at: new Date().toISOString(),
        sessions: [...sessions].map(([name, session]) => ({
          process: name,
          running: Boolean(session.stream?.running),
          count: session.count,
          skippedDark: session.skippedDark,
          lastError: session.lastError,
          root: path.join(defaultRoot(), name),
        })),
        audio: audio ? audio.state() : { running: false },
        groups: listGroups(sessions),
      })
    }

    if (route === '/start' && request.method === 'POST') {
      const state = await startSession()
      return json({ ok: true, state })
    }

    if (route === '/stop' && request.method === 'POST') {
      const stopped = await stopSessions()
      return json({ ok: true, stopped })
    }

    if (route === '/thumb' && request.method === 'GET') {
      const groupId = url.searchParams.get('group') || ''
      const processName = url.searchParams.get('process') || 'douyin'
      const session = sessions.get(processName)
      const group = session?.tracker.groups.find((g) => g.id === groupId)
      const file = group?.frames.at(-1)
      if (!file) return json({ error: '没有这张图' }, 404)
      try {
        const buf = await readFile(file)
        return new Response(buf, {
          headers: { 'content-type': 'image/jpeg', 'cache-control': 'no-store' },
        })
      } catch {
        return json({ error: '读不到这张图' }, 404)
      }
    }

    return json({ error: '没有这个接口' }, 404)
  }
}

/** 把面板接口挂到宿主 WebServer 上，不另开端口。 */
export function bindPanel(ctx, options) {
  const handler = createPanelRoute(options)
  const fibers = []
  fibers.push(ctx.inject(['webServer'], (owner) => owner.effect(() => owner.webServer.register(handler))))
  fibers.push(ctx.inject(['connection'], (owner) => {
    if (typeof owner.connection?.fetch?.register !== 'function') return
    for (const item of [
      { path: '/state', methods: ['GET'] },
      { path: '/thumb', methods: ['GET'] },
      { path: '/start', methods: ['POST'] },
      { path: '/stop', methods: ['POST'] },
    ]) {
      owner.connection.fetch.register({
        path: PANEL_PREFIX + item.path,
        methods: item.methods,
        requestBody: 'buffered',
        fetch: (request) => handler(request),
      })
    }
  }))
  return () => { for (const fiber of fibers) fiber?.() }
}
