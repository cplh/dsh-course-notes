/**
 * dsh-course-notes — B站课程知识笔记交付桥（DSH 插件）
 *
 * 职责（只做「最后一公里」）：
 *  - 只读监听 dsh-video-coursemap 的产物（.state/state.json 与 .state/manuals/<学科>.md）；
 *  - 发现新视频后，抽取该视频的 Markdown 章节，解析视频链接，生成双格式笔记：
 *    知识笔记/<学科>/<标题>.md 与 知识笔记/<学科>/<标题>.docx（同名，链接置顶）；
 *  - 通过 dsh-memory-evolve 的 de_session（spawn）新建 DSH 会话，会话内用
 *    present 同时呈现 Markdown 与 Word、用 memory 工具写入知识笔记；
 *  - de_session 不可用时，用等价的 agents.create + followup 兜底；
 *  - 已交付记录持久化；空闲时不产生任何 LLM 调用；异常只写日志，不影响宿主。
 *
 * 纯 ESM、零第三方依赖。
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync,
  renameSync, statSync, writeFileSync, appendFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-course-notes'
export const inject = ['tools']

const VERSION = '1.1.0'
const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const MD2DOCX_PATH = join(PLUGIN_DIR, 'lib', 'md2docx.py')

export const DEFAULTS = {
  coursemapOutputDir: null, // null -> <home>/课程知识地图
  outputDir: null,          // null -> <home>/课程笔记
  sessionCwd: null,         // null -> outputDir
  pollIntervalMs: 5000,
  maxDeliveriesPerPoll: 1,
  maxAttempts: 3,
  backfillOnFirstRun: false,
  provider: null,
  model: null,
  agentPreset: null,
  pythonPath: null,
  settingsFile: null, // 可选：共享设置 JSON（读取 notesDir，供本地控制台修改）
  stateDir: null,     // null -> <outputDir>/.state（delivered/status/log 的固定状态目录）
}

// ── 配置 ────────────────────────────────────────────────────────────────
export function resolveConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-course-notes: 配置必须是对象')
  }
  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) throw new Error('dsh-course-notes: 未知配置项 "' + key + '"')
    config[key] = value
  }
  for (const key of ['pollIntervalMs', 'maxDeliveriesPerPoll', 'maxAttempts']) {
    const v = config[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error('dsh-course-notes: ' + key + ' 必须是正数')
    }
  }
  if (typeof config.backfillOnFirstRun !== 'boolean') {
    throw new Error('dsh-course-notes: backfillOnFirstRun 必须是布尔值')
  }
  for (const key of ['provider', 'model', 'agentPreset', 'pythonPath', 'settingsFile', 'stateDir']) {
    if (config[key] !== null && typeof config[key] !== 'string') {
      throw new Error('dsh-course-notes: ' + key + ' 必须是 null 或字符串')
    }
  }
  config.coursemapOutputDir = resolvePath(config.coursemapOutputDir ?? join(homedir(), '课程知识地图'))
  config.outputDir = resolvePath(config.outputDir ?? join(homedir(), '课程笔记'))
  config.sessionCwd = resolvePath(config.sessionCwd ?? config.outputDir)
  config.settingsFile = config.settingsFile ? resolvePath(config.sessionCwd, config.settingsFile) : null
  config.stateDir = config.stateDir
    ? resolvePath(config.sessionCwd, config.stateDir)
    : join(config.outputDir, '.state')
  if (config.pollIntervalMs < 2000) config.pollIntervalMs = 2000
  return config
}

// ── 小工具 ──────────────────────────────────────────────────────────────
function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function atomicWrite(file, content) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp.' + process.pid
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

function readJson(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function mtimeMs(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function shortHash(s) {
  let h = 5381
  const str = String(s)
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0').slice(0, 8)
}

export function sanitizeFilename(s) {
  let t = String(s || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  if (!t) t = '未命名'
  if (t.length > 80) t = t.slice(0, 70) + '-' + shortHash(s)
  return t
}

function itemKey(subject, title) {
  return String(subject) + '\u0000' + String(title)
}

export function extractSection(markdown, title) {
  const lines = String(markdown || '').split(/\r?\n/)
  const headings = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/)
    if (m) headings.push({ index: i, text: m[1].trim() })
  }
  const candidates = headings.filter((h) => h.text !== '学科总览')
  if (candidates.length === 0) return null
  let target = null
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i].text === title) { target = candidates[i]; break }
  }
  const exact = target !== null
  if (!target) target = candidates[candidates.length - 1]
  const next = headings.find((h) => h.index > target.index)
  const end = next ? next.index : lines.length
  let body = lines.slice(target.index, end).join('\n').replace(/\n---\s*$/, '').trim()
  if (body.startsWith('## ')) {
    const bodyLines = body.split('\n')
    bodyLines.shift()
    body = bodyLines.join('\n').trim()
  }
  const summaryLine = body.split('\n').find((line) => line.trim().startsWith('> '))
  const summary = summaryLine ? summaryLine.trim().replace(/^>\s*/, '') : ''
  return { heading: target.text, body, summary, exact }
}

// ── Python / Word 转换 ──────────────────────────────────────────────────
function findBundledPython() {
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const rt of readdirSync(runtimesDir)) {
      const candidate = join(runtimesDir, rt, 'dependencies', 'python', 'python.exe')
      if (existsSync(candidate)) return candidate
    }
  } catch { /* 忽略 */ }
  return 'python'
}

/**
 * 用 stdio 重定向到临时文件（避免在受限沙箱里创建管道）执行 md2docx。
 * @returns {{ok:boolean, error:string}}
 */
export function convertMarkdownToDocx(pythonPath, mdPath, docxPath, workDir) {
  ensureDir(dirname(docxPath))
  ensureDir(workDir)
  const errFile = join(workDir, 'md2docx-' + shortHash(mdPath + Date.now()) + '.err')
  let fd = null
  try {
    fd = openSync(errFile, 'w')
    const r = spawnSync(pythonPath, [MD2DOCX_PATH, mdPath, docxPath], {
      timeout: 90000,
      windowsHide: true,
      stdio: ['ignore', 'ignore', fd],
    })
    if (r.error) return { ok: false, error: String(r.error.message || r.error) }
    if (r.status !== 0) {
      let detail = ''
      try { detail = readFileSync(errFile, 'utf8').trim().slice(-800) } catch { /* 忽略 */ }
      return { ok: false, error: 'md2docx 退出码 ' + r.status + (detail ? '：' + detail : '') }
    }
    if (!existsSync(docxPath)) return { ok: false, error: 'md2docx 未生成目标文件' }
    return { ok: true, error: '' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (fd !== null) {
      try { closeSync(fd) } catch { /* 忽略 */ }
    }
    try { if (existsSync(errFile)) { /* 保留最近错误文件供排查 */ } } catch { /* 忽略 */ }
  }
}

// ── 视频链接解析（poll.log 优先，B 站搜索兜底）──────────────────────────
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const BILI_VIDEO_BASE = 'https://www.bilibili.com/video/'

let cachedBuvid3 = null
async function getBuvid3() {
  if (cachedBuvid3 !== null) return cachedBuvid3
  try {
    const res = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: { 'User-Agent': BILI_UA } })
    const data = await res.json()
    cachedBuvid3 = data?.data?.b_3 || ''
  } catch { cachedBuvid3 = '' }
  return cachedBuvid3
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function biliFetch(url, { timeoutMs = 10000, retries = 1 } = {}) {
  const buvid3 = await getBuvid3()
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs)
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': BILI_UA,
          'Referer': 'https://www.bilibili.com/',
          'Accept': 'application/json, text/plain, */*',
          ...(buvid3 ? { Cookie: 'buvid3=' + buvid3 } : {}),
        },
        signal: ac.signal,
      })
      if (res.status === 412) throw new Error('HTTP 412')
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return JSON.parse(await res.text())
    } catch (error) {
      lastError = error
      if (attempt < retries) await sleep(1200 * (attempt + 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim()
}

function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function titleSimilar(a, b) {
  const na = normTitle(a)
  const nb = normTitle(b)
  if (!na || !nb) return 0
  if (na.includes(nb) || nb.includes(na)) return 1
  const bigrams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const A = bigrams(na)
  const B = bigrams(nb)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  return (2 * inter) / (A.size + B.size)
}

/** 读文件末尾 maxBytes 字节（防止 poll.log 长期增长后整文件读取）。 */
function readTail(file, maxBytes = 256 * 1024) {
  try {
    const stat = statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const buffer = Buffer.alloc(length)
    const fd = openSync(file, 'r')
    try {
      let offset = 0
      while (offset < length) {
        const read = readSync(fd, buffer, offset, length - offset, start + offset)
        if (read <= 0) break
        offset += read
      }
    } finally {
      closeSync(fd)
    }
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}

/** 从 coursemap 的 poll.log 中按标题反查 bvid；找不到返回 null。 */
export function resolveVideoUrlFromLog(logPath, title) {
  const text = readTail(logPath)
  if (!text) return null
  const lines = text.split(/\r?\n/)
  const target = normTitle(title)
  const pattern = /bili content title=("(?:[^"\\]|\\.)*") bvid=(BV[0-9A-Za-z]+)/
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(pattern)
    if (!match) continue
    let loggedTitle = ''
    try { loggedTitle = JSON.parse(match[1]) } catch { continue }
    if (loggedTitle === title || normTitle(loggedTitle) === target) {
      return { bvid: match[2], url: BILI_VIDEO_BASE + match[2], source: 'poll.log' }
    }
  }
  return null
}

/** 用 B 站公开搜索接口按标题反查 bvid；无匹配返回 null（网络错误会抛出）。 */
export async function searchBiliBvid(title) {
  const url = 'https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + encodeURIComponent(title)
  const data = await biliFetch(url, { timeoutMs: 8000, retries: 1 })
  if (data?.code !== 0) throw new Error('bili search code ' + data?.code)
  const results = (data?.data?.result ?? []).filter((item) => item?.bvid)
  if (results.length === 0) return null
  const top = results[0]
  const clean = stripHtml(top.title)
  if (titleSimilar(title, clean) < 0.5) return null
  return { bvid: top.bvid, url: BILI_VIDEO_BASE + top.bvid, source: 'bili-search', matchedTitle: clean }
}

// ── 应用主体 ────────────────────────────────────────────────────────────
export function createApp(ctx, config, deps = {}) {
  const convert = typeof deps.convert === 'function' ? deps.convert : convertMarkdownToDocx
  ensureDir(config.outputDir)
  ensureDir(config.sessionCwd)
  const stateDir = config.stateDir
  const tmpDir = join(stateDir, 'tmp')
  ensureDir(stateDir)
  ensureDir(tmpDir)
  const deliveredPath = join(stateDir, 'delivered.json')
  const statusPath = join(stateDir, 'app-status.json')
  const logPath = join(stateDir, 'delivery.log')
  const coursemapStatePath = join(config.coursemapOutputDir, '.state', 'state.json')
  const manualsDir = join(config.coursemapOutputDir, '.state', 'manuals')
  const pythonPath = config.pythonPath ?? findBundledPython()
  const settingsCache = { at: -1, value: null }
  function readSharedSettings() {
    if (!config.settingsFile) return null
    const m = mtimeMs(config.settingsFile)
    if (settingsCache.at === m) return settingsCache.value
    const value = readJson(config.settingsFile)
    settingsCache.at = m
    settingsCache.value = value
    return value
  }
  function effectiveNotesDir() {
    const shared = readSharedSettings()
    const raw = shared && typeof shared.notesDir === 'string' ? shared.notesDir.trim() : ''
    if (!raw) return config.outputDir
    try { return resolvePath(config.sessionCwd, raw) } catch { return config.outputDir }
  }
  const urlCache = new Map()
  async function resolveVideoUrlDefault(title) {
    if (urlCache.has(title)) return urlCache.get(title)
    let resolved = resolveVideoUrlFromLog(join(config.coursemapOutputDir, '.state', 'poll.log'), title)
    if (!resolved) {
      try {
        resolved = await searchBiliBvid(title)
      } catch (error) {
        log('warn: B站搜索反查失败 title=' + JSON.stringify(title) + ' msg=' + (error?.message ?? error))
      }
    }
    if (resolved) {
      urlCache.set(title, resolved)
      log('video url resolved title=' + JSON.stringify(title) + ' bvid=' + resolved.bvid + ' source=' + resolved.source)
    } else {
      log('warn: 未能解析视频链接 title=' + JSON.stringify(title))
    }
    return resolved ?? null
  }
  const resolveVideoUrl = typeof deps.resolveVideoUrl === 'function' ? deps.resolveVideoUrl : resolveVideoUrlDefault
  const startedAt = Date.now()
  const inFlight = new Set()
  let running = false
  let cachedState = null
  let cachedMtime = 0
  let lastError = ''

  const delivered = readJson(deliveredPath) || {
    version: 1,
    initializedAt: startedAt,
    seeded: false,
    items: {},
  }
  if (!delivered.items || typeof delivered.items !== 'object') delivered.items = {}

  // 首次加载即固定基线：此刻已存在的视频不再补发（backfillOnFirstRun=true 除外），
  // 之后新出现的视频才交付。这样即使 state.json 在安装时还不存在，也不会把
  // 第一条新视频误判成历史视频。
  if (!delivered.seeded) {
    const initial = readJson(coursemapStatePath)
    if (initial) {
      for (const { subject, title } of listVideos(initial)) {
        const key = itemKey(subject, title)
        if (!delivered.items[key]) {
          delivered.items[key] = {
            status: config.backfillOnFirstRun ? 'pending' : 'skipped',
            attempts: 0,
            at: Date.now(),
            subject,
            title,
          }
        }
      }
    }
    delivered.seeded = true
    delivered.initializedAt = delivered.initializedAt ?? startedAt
    saveDelivered()
  }

  function log(message) {
    const line = '[' + new Date().toISOString() + '] ' + message + '\n'
    try {
      if (existsSync(logPath) && statSync(logPath).size > 2 * 1024 * 1024) writeFileSync(logPath, '')
      appendFileSync(logPath, line, 'utf8')
    } catch { /* 忽略 */ }
    if (/error|失败|fail/i.test(message)) console.warn('[dsh-course-notes] ' + message)
  }

  function saveDelivered() {
    try { atomicWrite(deliveredPath, JSON.stringify(delivered, null, 2) + '\n') } catch (error) {
      log('error saving delivered.json: ' + (error?.message ?? error))
    }
  }

  function counts() {
    let pending = 0
    let deliveredCount = 0
    let failed = 0
    let skipped = 0
    for (const item of Object.values(delivered.items)) {
      if (!item || typeof item !== 'object') continue
      if (item.status === 'pending') pending++
      else if (item.status === 'delivered') deliveredCount++
      else if (item.status === 'failed') failed++
      else if (item.status === 'skipped') skipped++
    }
    return { pending, delivered: deliveredCount, failed, skipped }
  }

  function lastDelivery() {
    let best = null
    for (const item of Object.values(delivered.items)) {
      if (!item || item.status !== 'delivered') continue
      if (!best || (item.at ?? 0) > (best.at ?? 0)) best = item
    }
    return best
  }

  function writeStatus() {
    const c = counts()
    const status = {
      ok: true,
      version: VERSION,
      pid: process.pid,
      startedAt,
      coursemapOutputDir: config.coursemapOutputDir,
      outputDir: effectiveNotesDir(),
      defaultOutputDir: config.outputDir,
      stateDir,
      sessionCwd: config.sessionCwd,
      pollIntervalMs: config.pollIntervalMs,
      stateFile: coursemapStatePath,
      stateExists: existsSync(coursemapStatePath),
      deSession: Boolean(findDeSessionTool()),
      pythonPath,
      counts: c,
      lastDelivery: lastDelivery(),
      lastError,
    }
    try { atomicWrite(statusPath, JSON.stringify(status, null, 2) + '\n') } catch { /* 忽略 */ }
    return status
  }

  function loadCoursemapState(force = false) {
    const m = mtimeMs(coursemapStatePath)
    if (!force && cachedState !== null && m === cachedMtime) return cachedState
    const value = readJson(coursemapStatePath)
    if (!value) return cachedState
    cachedState = value
    cachedMtime = m
    return value
  }

  function listVideos(cm) {
    const out = []
    for (const [subject, data] of Object.entries(cm?.subjects ?? {})) {
      const videos = Array.isArray(data?.videos) ? data.videos : []
      for (const title of videos) {
        if (typeof title === 'string' && title.trim() !== '') out.push({ subject, title })
      }
    }
    return out
  }

  function seedBaseline(cm) {
    if (delivered.seeded) return
    const baseline = listVideos(cm)
    for (const { subject, title } of baseline) {
      const key = itemKey(subject, title)
      if (!delivered.items[key]) {
        delivered.items[key] = {
          status: config.backfillOnFirstRun ? 'pending' : 'skipped',
          attempts: 0,
          at: Date.now(),
          subject,
          title,
        }
      }
    }
    delivered.seeded = true
    delivered.initializedAt = delivered.initializedAt ?? Date.now()
    saveDelivered()
    log('baseline seeded: ' + baseline.length + ' video(s), backfill=' + config.backfillOnFirstRun)
  }

  function collectJobs(cm) {
    const jobs = []
    const now = Date.now()
    for (const { subject, title } of listVideos(cm)) {
      const key = itemKey(subject, title)
      const item = delivered.items[key]
      if (!item) {
        jobs.push({ subject, title, key, attempts: 0 })
        continue
      }
      const attempts = typeof item.attempts === 'number' ? item.attempts : 0
      if (item.status === 'failed' && attempts < config.maxAttempts) {
        jobs.push({ subject, title, key, attempts })
      } else if (item.status === 'pending' && attempts === 0) {
        jobs.push({ subject, title, key, attempts })
      } else if (item.status === 'pending' && now - (item.at ?? 0) > 5 * 60 * 1000) {
        jobs.push({ subject, title, key, attempts })
      }
    }
    return jobs
  }

  function resolveRoute() {
    if (config.provider && config.model) return { provider: config.provider, model: config.model }
    try {
      const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
        return { provider: sel.provider, model: sel.model }
      }
    } catch { /* 忽略 */ }
    return { provider: config.provider ?? null, model: config.model ?? null }
  }

  function findDeSessionTool() {
    try {
      const tools = ctx?.tools
      if (!tools) return null
      if (typeof tools.get === 'function') {
        const def = tools.get('de_session')
        if (def && typeof def.execute === 'function') return def
      }
      if (typeof tools.executable === 'function') {
        const def = tools.executable('de_session')
        if (def && typeof def.execute === 'function') return def
      }
    } catch { /* 忽略 */ }
    return null
  }

  async function spawnViaDeSession(prompt, route) {
    const def = findDeSessionTool()
    if (!def) return null
    const args = {
      action: 'spawn',
      prompt,
      cwd: config.sessionCwd,
      provider: route.provider,
      model: route.model,
    }
    if (config.agentPreset) args.agentPreset = config.agentPreset
    // de_session 的 execute(args, ctx) 只用 ctx.agent 继承路由；这里显式给出。
    const execCtx = { agent: { options: { provider: route.provider, model: route.model } } }
    const result = await def.execute(args, execCtx)
    if (result && result.ok === true && typeof result.sessionId === 'string') {
      return { sessionId: result.sessionId, via: 'de_session' }
    }
    throw new Error('de_session spawn 失败：' + String(result?.message ?? '未知错误'))
  }

  async function spawnDirect(prompt, route) {
    const agents = ctx?.get?.('agents')
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('agents 服务不可用，无法新建会话')
    }
    const sessionId = 'session-' + randomUUID()
    const presets = ctx?.get?.('agentPresets')
    let presetId = config.agentPreset ?? null
    let setup = null
    if (presets && typeof presets.resolve === 'function' && typeof presets.mount === 'function') {
      try {
        const resolvedPreset = await presets.resolve(config.agentPreset ?? undefined)
        presetId = resolvedPreset?.id ?? presetId
        if (presetId) {
          setup = async (agentCtx) => { await presets.mount(agentCtx, presetId) }
        }
      } catch { /* 降级不挂载预设 */ }
    }
    const handle = await agents.create({
      sessionId,
      agentOptions: { provider: route.provider, model: route.model },
      meta: {
        cwd: config.sessionCwd,
        ...(presetId ? { agentPreset: presetId } : {}),
      },
      ...(setup ? { setup } : {}),
    })
    handle.agent.followup({
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    })
    return { sessionId, via: 'direct' }
  }

  function buildPrompt({ subject, title, docxPath, mdPath, manualPath, summary, url }) {
    const lines = [
      '【B站课程知识笔记 · 自动交付】',
      '视频：' + title,
      '视频链接：' + (url || '（未解析）'),
      '学科：' + subject,
      '生成时间：' + new Date().toLocaleString('zh-CN', { hour12: false }),
      '',
      '交付文件（Word）：' + docxPath,
      '交付文件（Markdown）：' + mdPath,
      '学科手册：' + manualPath,
    ]
    if (summary) lines.push('本视频一句话简介：' + summary)
    lines.push(
      '',
      '请依次完成：',
      '1. 阅读本视频 Markdown 笔记（' + mdPath + '）核对总结（不要重新抓取 B 站、不要调用 course_map_* 工具）。',
      '2. 用 memory 工具 action=add target=project，把本视频 3~5 条核心知识点写入（首行建议「课程笔记/' + subject + '｜' + title + '」）；若判断是长期通用知识，可另提交 target=key 建议（走待确认队列）。',
      '3. 用 present 工具同时呈现两个文件：files:[{path:"' + docxPath + '", description:"《' + title + '》知识笔记 · Word · 学科 ' + subject + '"},{path:"' + mdPath + '", description:"《' + title + '》知识笔记 · Markdown · 学科 ' + subject + '"}]。',
      '4. 用一句话总结本视频' + (url ? '（并给出视频链接）' : '') + '后结束。',
    )
    return lines.join('\n')
  }

  function buildVideoMarkdown({ subject, title, section, url }) {
    const linkLine = url
      ? '> 视频链接：' + url
      : '> 视频链接：未能解析到 B 站链接（可按标题在 B 站搜索）'
    const header = [
      '# ' + subject + ' · ' + title,
      '',
      linkLine,
      '> 自动生成于 ' + new Date().toLocaleString('zh-CN', { hour12: false }),
      '> 来源：B站视频课程实时总结（dsh-video-coursemap 抓取简介/字幕/弹幕/评论）',
      '',
    ]
    return header.join('\n') + section.body + '\n'
  }

  async function deliverJob(job, options = {}) {
    const { subject, title, key } = job
    if (inFlight.has(key)) {
      return delivered.items[key] ?? { status: 'pending', subject, title }
    }
    inFlight.add(key)
    const attempts = (typeof delivered.items[key]?.attempts === 'number' ? delivered.items[key].attempts : 0) + 1
    delivered.items[key] = {
      status: 'pending',
      attempts,
      at: Date.now(),
      subject,
      title,
    }
    saveDelivered()
    try {
      const manualPath = join(manualsDir, subject + '.md')
      if (!existsSync(manualPath)) throw new Error('找不到学习手册 Markdown：' + manualPath)
      const markdown = readFileSync(manualPath, 'utf8')
      const section = extractSection(markdown, title)
      if (!section || section.body.trim() === '') throw new Error('手册中找不到该视频章节：' + title)
      if (!section.exact) log('warn: 标题未精确匹配，回退到最后一个章节 title=' + JSON.stringify(title))

      let resolved = null
      try {
        resolved = await resolveVideoUrl(title)
      } catch (error) {
        log('warn: 视频链接解析异常 title=' + JSON.stringify(title) + ' msg=' + (error?.message ?? error))
      }
      const url = resolved?.url ?? ''
      const subjectDir = join(effectiveNotesDir(), sanitizeFilename(subject))
      const baseName = sanitizeFilename(title)
      const mdPath = join(subjectDir, baseName + '.md')
      const docxPath = join(subjectDir, baseName + '.docx')
      ensureDir(subjectDir)
      atomicWrite(mdPath, buildVideoMarkdown({ subject, title, section, url }))
      const docxTmp = docxPath + '.tmp.docx'
      const converted = convert(pythonPath, mdPath, docxTmp, tmpDir)
      if (!converted.ok) throw new Error('Word 转换失败：' + converted.error)
      renameSync(docxTmp, docxPath)

      const route = resolveRoute()
      if (!route.provider || !route.model) throw new Error('无法确定新会话的 provider/model（默认模型服务未就绪）')
      const prompt = buildPrompt({ subject, title, docxPath, mdPath, manualPath, summary: section.summary, url })
      let spawned = await spawnViaDeSession(prompt, route)
      if (spawned === null) spawned = await spawnDirect(prompt, route)

      delivered.items[key] = {
        status: 'delivered',
        attempts,
        at: Date.now(),
        subject,
        title,
        md: mdPath,
        docx: docxPath,
        url,
        bvid: resolved?.bvid ?? null,
        sessionId: spawned.sessionId,
        via: spawned.via,
      }
      saveDelivered()
      log('delivered subject=' + JSON.stringify(subject) + ' title=' + JSON.stringify(title) + ' md=' + JSON.stringify(mdPath) + ' docx=' + JSON.stringify(docxPath) + ' url=' + JSON.stringify(url) + ' session=' + spawned.sessionId + ' via=' + spawned.via)
      lastError = ''
      return delivered.items[key]
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      delivered.items[key] = {
        status: 'failed',
        attempts,
        at: Date.now(),
        subject,
        title,
        error: message,
      }
      saveDelivered()
      lastError = message
      log('error delivering subject=' + JSON.stringify(subject) + ' title=' + JSON.stringify(title) + ' attempts=' + attempts + ' msg=' + message)
      return delivered.items[key]
    } finally {
      inFlight.delete(key)
      writeStatus()
    }
  }

  async function tick() {
    if (running) return
    running = true
    try {
      const cm = loadCoursemapState()
      if (!cm) return
      seedBaseline(cm)
      const jobs = collectJobs(cm)
      if (jobs.length === 0) return
      for (const job of jobs.slice(0, config.maxDeliveriesPerPoll)) {
        await deliverJob(job)
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      log('tick error: ' + lastError)
      writeStatus()
    } finally {
      running = false
    }
  }

  async function deliverByTitle(args) {
    const title = String(args?.title ?? '').trim()
    if (!title) return { ok: false, message: 'title 不能为空' }
    const cm = loadCoursemapState(true)
    let subject = args?.subject ? String(args.subject).trim() : ''
    if (!subject) {
      const match = listVideos(cm).find((v) => v.title === title)
      if (match) subject = match.subject
    }
    if (!subject) return { ok: false, message: '未找到该视频所属学科，请显式传 subject' }
    const key = itemKey(subject, title)
    const existing = delivered.items[key]
    if (args?.force !== true && existing?.status === 'delivered') {
      return { ok: true, message: '该视频已交付过（force=true 可重发）', md: existing.md, docx: existing.docx, url: existing.url, sessionId: existing.sessionId }
    }
    const item = await deliverJob({ subject, title, key })
    if (item.status === 'delivered') {
      return { ok: true, message: '已生成 Markdown + Word 并新建会话：' + item.sessionId, md: item.md, docx: item.docx, url: item.url, sessionId: item.sessionId }
    }
    return { ok: false, message: item.error || '交付失败' }
  }

  function status() {
    const cm = loadCoursemapState(true)
    const c = counts()
    const latest = lastDelivery()
    const latestText = latest
      ? latest.title + ' → ' + (latest.sessionId ?? '') + '（' + new Date(latest.at ?? Date.now()).toLocaleString('zh-CN', { hour12: false }) + '）'
      : ''
    const subjects = Object.entries(cm?.subjects ?? {}).map(([subject, data]) => ({
      subject,
      videos: Array.isArray(data?.videos) ? data.videos.length : 0,
    }))
    const message = [
      '课程知识笔记应用状态：',
      '- coursemap 输出：' + config.coursemapOutputDir + (existsSync(coursemapStatePath) ? '' : '（state.json 尚未生成）'),
      '- 单视频笔记目录：' + effectiveNotesDir(),
      '- 状态目录：' + stateDir,
      '- 新会话 cwd：' + config.sessionCwd,
      '- de_session：' + (findDeSessionTool() ? '可用' : '不可用（会走兜底 spawn）'),
      '- Python：' + pythonPath,
      '- 计数：delivered=' + c.delivered + ' pending=' + c.pending + ' failed=' + c.failed + ' skipped=' + c.skipped,
      subjects.length > 0 ? '- 学科：' + subjects.map((s) => s.subject + '(' + s.videos + ')').join('、') : '- 学科：暂无',
      latest ? '- 最近交付：' + latest.title + ' → ' + (latest.sessionId ?? '') : '- 最近交付：无',
      lastError ? '- 最近错误：' + lastError : '',
    ].filter(Boolean).join('\n')
    return { ok: true, message, coursemapOutputDir: config.coursemapOutputDir, outputDir: effectiveNotesDir(), stateDir, sessionCwd: config.sessionCwd, deSession: Boolean(findDeSessionTool()), pythonPath, ...c, lastDelivery: latestText, lastError }
  }

  return {
    config,
    delivered,
    tick,
    status,
    deliverByTitle,
    writeStatus,
    paths: { deliveredPath, statusPath, logPath, coursemapStatePath, manualsDir, pythonPath },
  }
}

// ── 工具定义 ────────────────────────────────────────────────────────────
function statusTool(app) {
  return {
    name: 'course_notes_status',
    description: '查看「B站课程知识笔记」应用状态：coursemap 输出目录、单视频笔记目录、状态目录、de_session 是否可用、已交付/待交付/失败计数、最近交付与最近错误。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          coursemapOutputDir: { type: 'string' },
          outputDir: { type: 'string' },
          stateDir: { type: 'string' },
          sessionCwd: { type: 'string' },
          deSession: { type: 'boolean' },
          pythonPath: { type: 'string' },
          pending: { type: 'integer' },
          delivered: { type: 'integer' },
          failed: { type: 'integer' },
          skipped: { type: 'integer' },
          lastDelivery: { type: 'string' },
          lastError: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute() {
      return app.status()
    },
  }
}

function deliverTool(app) {
  return {
    name: 'course_notes_deliver',
    description: '手动补发单个视频的知识笔记：从 coursemap 学习手册抽取该视频章节，解析视频链接，生成同名 Markdown + Word，并新建会话同时呈现（用于测试或补发）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '视频标题（需出现在 coursemap 的 state.json 或手册中）' },
        subject: { type: 'string', description: '可选：学科名；缺省从 state.json 反查' },
        force: { type: 'boolean', description: '已交付过是否强制重发（默认 false）' },
      },
      required: ['title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          md: { type: 'string' },
          docx: { type: 'string' },
          url: { type: 'string' },
          sessionId: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
    },
    async execute(args) {
      return app.deliverByTitle(args)
    },
  }
}

// ── 插件入口 ────────────────────────────────────────────────────────────
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const app = createApp(ctx, config)
  app.writeStatus()
  console.log('[dsh-course-notes] 已启动：coursemap=' + config.coursemapOutputDir + '，笔记=' + config.outputDir + '，每 ' + config.pollIntervalMs + 'ms 轮询')

  ctx.effect(() => ctx.tools.register(statusTool(app)), 'dsh-course-notes: status tool')
  ctx.effect(() => ctx.tools.register(deliverTool(app)), 'dsh-course-notes: deliver tool')
  ctx.effect(() => {
    const id = setInterval(() => { app.tick().catch((error) => console.error('[dsh-course-notes] tick 异常：', error)) }, config.pollIntervalMs)
    return () => clearInterval(id)
  }, 'dsh-course-notes: poll timer')
  ctx.effect(() => {
    const id = setTimeout(() => { app.tick().catch(() => {}) }, 1200)
    return () => clearTimeout(id)
  }, 'dsh-course-notes: initial tick')
  return app
}

export const _internals = {
  resolveConfig,
  extractSection,
  sanitizeFilename,
  convertMarkdownToDocx,
  itemKey,
  resolveVideoUrlFromLog,
  searchBiliBvid,
}
