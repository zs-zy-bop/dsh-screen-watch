// audio.mjs — 可选的声音层：录系统输出 + 本地转写（需要 Python）
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

const execFileAsync = promisify(execFile)
const HELPER = fileURLToPath(new URL('./audio_helper.py', import.meta.url))

/** 找一个能用的 python：先用环境变量指定的，再试 python / py。 */
export async function findPython() {
  const candidates = [process.env.DSH_SCREEN_WATCH_PY, 'python', 'python3', 'py'].filter(Boolean)
  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, ['-c', 'import sys;print(sys.version_info[0])'],
        { windowsHide: true, timeout: 8000 })
      if (stdout.trim().startsWith('3')) return cmd
    } catch {
      // 继续试下一个
    }
  }
  return null
}

export async function checkDeps(python) {
  if (!python) return { python: null, ok: false, missing: ['python'] }
  const probe = 'import importlib.util as u;print(",".join(n for n in ["pyaudiowpatch","faster_whisper","numpy"] if u.find_spec(n) is None) or "ok")'
  try {
    const { stdout } = await execFileAsync(python, ['-c', probe], { windowsHide: true, timeout: 20000 })
    const text = stdout.trim()
    return { python, ok: text === 'ok', missing: text === 'ok' ? [] : text.split(',') }
  } catch (err) {
    return { python, ok: false, missing: ['probe-failed'], error: err.message }
  }
}

export class AudioSession {
  constructor({ root, python, model = 'small', lang = 'zh', chunk = 20 }) {
    this.root = root
    this.python = python
    this.model = model
    this.lang = lang
    this.chunk = chunk
    this.child = null
    this.startedAt = null
    this.lastError = ''
  }

  get logPath() {
    return path.join(this.root, 'transcript.txt')
  }

  async start() {
    if (this.child) return this.state()
    await mkdir(this.root, { recursive: true })
    const modelDir = process.env.DSH_SCREEN_WATCH_MODELS || 'D:\\dsh-video-tools\\models'
    this.child = spawn(this.python, [HELPER, '--out', this.root,
      '--model', this.model, '--lang', this.lang, '--chunk', String(this.chunk),
      '--model-dir', modelDir],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HUB_DISABLE_XET: '1',
      },
    })
    this.startedAt = new Date().toISOString()
    this.child.stderr.on('data', (buf) => { this.lastError = buf.toString().trim() })
    this.child.on('exit', () => { this.child = null })
    return this.state()
  }

  async stop() {
    if (this.child) {
      this.child.kill()
      this.child = null
    }
    return this.state()
  }

  state() {
    return { running: Boolean(this.child), startedAt: this.startedAt, log: this.logPath, lastError: this.lastError }
  }

  /** 最近几行转写，用于和画面一起看。 */
  async tail(lines = 20) {
    try {
      const text = await readFile(this.logPath, 'utf8')
      const rows = text.split(/\r?\n/).filter(Boolean)
      return rows.slice(-lines)
    } catch {
      return []
    }
  }
}
