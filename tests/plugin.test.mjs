import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  createApp, resolveConfig, extractSection, sanitizeFilename, convertMarkdownToDocx,
  resolveVideoUrlFromLog,
} from '../lib/index.js'

const BASE = join(process.cwd(), '.test-tmp', 'run-' + process.pid + '-' + Date.now())
let seq = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

after(() => {
  try { rmSync(join(process.cwd(), '.test-tmp'), { recursive: true, force: true }) } catch { /* 忽略 */ }
})

const SUBJECT = 'AI工具'
const TITLE_A = '视频A'
const TITLE_B = '视频B'

const MANUAL = [
  '# AI工具 学习手册',
  '',
  '<!-- OVERVIEW_START -->',
  '## 学科总览',
  '这里不是正文',
  '<!-- OVERVIEW_END -->',
  '',
  '---',
  '',
  '## 视频A',
  '',
  '> 简介A',
  '',
  '### 核心知识点',
  '- **A1**',
  '- 要点A',
  '',
  '---',
  '',
  '## 视频B',
  '',
  '> 简介B',
  '',
  '### 核心知识点',
  '- **B1**',
  '- 要点B',
  '',
  '### 思维导图',
  'mindmap',
  '  root((视频B))',
  '    主题',
  '',
].join('\n')

function makeEnv() {
  const root = join(BASE, 'env-' + (++seq))
  const coursemap = join(root, '课程知识地图')
  mkdirSync(join(coursemap, '.state', 'manuals'), { recursive: true })
  const statePath = join(coursemap, '.state', 'state.json')
  const manualPath = join(coursemap, '.state', 'manuals', SUBJECT + '.md')
  const state = { subjects: { [SUBJECT]: { createdAt: 1, videos: [TITLE_A] } }, seen: {}, lastTitle: '', lastRunAt: 1 }
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  writeFileSync(manualPath, MANUAL)
  const config = resolveConfig({
    coursemapOutputDir: coursemap,
    outputDir: join(root, '知识笔记'),
    sessionCwd: join(root, 'ws'),
    pollIntervalMs: 2000,
    maxAttempts: 3,
  })
  return { root, coursemap, statePath, state, config }
}

async function addVideo(env, title) {
  env.state.subjects[SUBJECT].videos.push(title)
  writeFileSync(env.statePath, JSON.stringify(env.state, null, 2))
  await sleep(30)
}

function makeCtx(options = {}) {
  const registered = new Map()
  const spawnCalls = []
  const followups = []
  const deSession = options.deSession === false ? null : {
    async execute(args) {
      spawnCalls.push(args)
      if (typeof options.spawnResult === 'function') return options.spawnResult(args)
      return { ok: true, sessionId: 'session-fake-' + spawnCalls.length }
    },
  }
  const ctx = {
    tools: {
      register(def) {
        registered.set(def.name, def)
        return () => registered.delete(def.name)
      },
      get(name) {
        if (name === 'de_session') return deSession
        return undefined
      },
      executable() { return undefined },
    },
    get(name) {
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) }
      }
      if (name === 'agents') {
        return {
          async create() {
            return { agent: { followup(message) { followups.push(message) } } }
          },
        }
      }
      if (name === 'agentPresets') return null
      return undefined
    },
  }
  return { ctx, registered, spawnCalls, followups }
}

function fakeConvert() {
  return (_python, _mdPath, docxPath) => {
    writeFileSync(docxPath, 'PK fake docx', 'utf8')
    return { ok: true, error: '' }
  }
}

const FAKE_BVID = 'BV1TEST00001'
const FAKE_URL = 'https://www.bilibili.com/video/' + FAKE_BVID

function makeDeps(resolveVideoUrl) {
  return {
    convert: fakeConvert(),
    resolveVideoUrl: typeof resolveVideoUrl === 'function'
      ? resolveVideoUrl
      : async () => ({ bvid: FAKE_BVID, url: FAKE_URL, source: 'test' }),
  }
}

test('resolveConfig: 默认值与未知键校验', () => {
  const config = resolveConfig({ pollIntervalMs: 3000, maxDeliveriesPerPoll: 1, maxAttempts: 2, backfillOnFirstRun: false })
  assert.equal(config.pollIntervalMs, 3000)
  assert.equal(config.coursemapOutputDir, join(homedir(), '课程知识地图'))
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置项/)
  assert.throws(() => resolveConfig({ pollIntervalMs: -1 }), /必须是正数/)
  assert.throws(() => resolveConfig({ backfillOnFirstRun: 'x' }), /布尔值/)
})

test('extractSection: 精确匹配、回退、简介提取', () => {
  const exact = extractSection(MANUAL, '视频A')
  assert.ok(exact)
  assert.equal(exact.exact, true)
  assert.match(exact.body, /A1/)
  assert.doesNotMatch(exact.body, /B1/)
  assert.equal(exact.summary, '简介A')
  const missing = extractSection(MANUAL, '不存在的标题')
  assert.ok(missing)
  assert.equal(missing.exact, false)
  assert.match(missing.body, /B1/)
  assert.equal(extractSection('# 空', 'x'), null)
})

test('sanitizeFilename: 非法字符与超长标题', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j')
  const long = '长'.repeat(120)
  const safe = sanitizeFilename(long)
  assert.ok(safe.length <= 80)
  assert.match(safe, /-[0-9a-f]{8}$/)
})

test('首次基线跳过历史视频；新视频交付一次并生成同名 Markdown + Word', async () => {
  const env = makeEnv()
  const { ctx, spawnCalls } = makeCtx()
  const app = createApp(ctx, env.config, makeDeps())

  assert.equal(app.delivered.items[SUBJECT + '\u0000' + TITLE_A].status, 'skipped')
  await app.tick()
  assert.equal(spawnCalls.length, 0)

  await addVideo(env, TITLE_B)
  await app.tick()

  const item = app.delivered.items[SUBJECT + '\u0000' + TITLE_B]
  assert.equal(item.status, 'delivered')
  assert.equal(spawnCalls.length, 1)
  assert.equal(item.url, FAKE_URL)
  assert.equal(item.bvid, FAKE_BVID)
  assert.ok(existsSync(item.md), 'Markdown 笔记应存在')
  assert.ok(existsSync(item.docx), 'Word 笔记应存在')
  assert.equal(item.md.slice(0, -3), item.docx.slice(0, -5), '两个文件基础名应一致')
  const mdText = readFileSync(item.md, 'utf8')
  assert.ok(mdText.startsWith('# ' + SUBJECT + ' · ' + TITLE_B), 'Markdown 以标题开头')
  assert.match(mdText, /^> 视频链接：https:\/\/www\.bilibili\.com\/video\//m)
  assert.ok(mdText.indexOf(FAKE_URL) < mdText.indexOf('### 核心知识点'), '链接应在正文前')
  assert.match(spawnCalls[0].prompt, /视频链接：https:\/\/www\.bilibili\.com\/video\//)
  assert.match(spawnCalls[0].prompt, /交付文件（Markdown）：/)
  assert.ok(spawnCalls[0].prompt.includes(item.md))
  assert.ok(spawnCalls[0].prompt.includes(item.docx))
  assert.match(spawnCalls[0].prompt, /files:\[\{path:/)
  assert.equal(spawnCalls[0].cwd, env.config.sessionCwd)
  assert.match(spawnCalls[0].prompt, /memory/)

  await app.tick()
  assert.equal(spawnCalls.length, 1, '重复轮询不应重复交付')
})

test('交付失败按 maxAttempts 重试后停止', async () => {
  const env = makeEnv()
  const { ctx, spawnCalls } = makeCtx({ spawnResult: () => ({ ok: false, message: 'boom' }) })
  const app = createApp(ctx, env.config, makeDeps())
  await addVideo(env, TITLE_B)
  await app.tick()
  await app.tick()
  await app.tick()
  const item = app.delivered.items[SUBJECT + '\u0000' + TITLE_B]
  assert.equal(item.status, 'failed')
  assert.equal(item.attempts, 3)
  assert.equal(spawnCalls.length, 3)
  await app.tick()
  assert.equal(spawnCalls.length, 3, '达到上限后不再重试')
})

test('de_session 不可用时走 agents.create 兜底', async () => {
  const env = makeEnv()
  const { ctx, followups } = makeCtx({ deSession: false })
  const app = createApp(ctx, env.config, makeDeps())
  await addVideo(env, TITLE_B)
  await app.tick()
  const item = app.delivered.items[SUBJECT + '\u0000' + TITLE_B]
  assert.equal(item.status, 'delivered')
  assert.equal(item.via, 'direct')
  assert.equal(followups.length, 1)
  assert.match(followups[0].content[0].text, /视频B/)
})

test('resolveVideoUrlFromLog: 从 poll.log 取 bvid，支持转义引号', () => {
  const dir = join(BASE, 'log-' + (++seq))
  mkdirSync(dir, { recursive: true })
  const logPath = join(dir, 'poll.log')
  const quoted = '标题"带引号"的视频'
  const lines = [
    '[t1] fg proc=chrome title="普通页面"',
    '[t2] bili content title=' + JSON.stringify(TITLE_B) + ' bvid=BV1REx46NEc4 danmaku=150 comments=3 transcript=0',
    '[t3] bili content title=' + JSON.stringify(quoted) + ' bvid=BV1Quoted0001 danmaku=1',
  ]
  writeFileSync(logPath, lines.join('\n') + '\n', 'utf8')

  const normal = resolveVideoUrlFromLog(logPath, TITLE_B)
  assert.ok(normal)
  assert.equal(normal.bvid, 'BV1REx46NEc4')
  assert.equal(normal.url, 'https://www.bilibili.com/video/BV1REx46NEc4')
  const escaped = resolveVideoUrlFromLog(logPath, quoted)
  assert.ok(escaped)
  assert.equal(escaped.bvid, 'BV1Quoted0001')
  assert.equal(resolveVideoUrlFromLog(logPath, '不存在的视频'), null)
  assert.equal(resolveVideoUrlFromLog(join(dir, 'missing.log'), TITLE_B), null)
})

test('链接解析失败时写占位文案且不阻断交付', async () => {
  const env = makeEnv()
  const { ctx, spawnCalls } = makeCtx()
  const app = createApp(ctx, env.config, makeDeps(async () => null))
  await addVideo(env, TITLE_B)
  await app.tick()
  const item = app.delivered.items[SUBJECT + '\u0000' + TITLE_B]
  assert.equal(item.status, 'delivered')
  assert.equal(item.url, '')
  assert.ok(existsSync(item.md))
  const mdText = readFileSync(item.md, 'utf8')
  assert.match(mdText, /未能解析到 B 站链接/)
  assert.match(spawnCalls[0].prompt, /视频链接：（未解析）/)
})

test('共享设置 notesDir：笔记写入自定义目录，状态仍在原状态目录', async () => {
  const env = makeEnv()
  const settingsDir = join(env.root, 'shared')
  mkdirSync(settingsDir, { recursive: true })
  const customNotes = join(env.root, '自定义笔记')
  const settingsPath = join(settingsDir, 'config.json')
  writeFileSync(settingsPath, JSON.stringify({ notesDir: customNotes }), 'utf8')
  env.config.settingsFile = settingsPath

  const { ctx, spawnCalls } = makeCtx()
  const app = createApp(ctx, env.config, makeDeps())
  await addVideo(env, TITLE_B)
  await app.tick()

  const item = app.delivered.items[SUBJECT + '\u0000' + TITLE_B]
  assert.equal(item.status, 'delivered')
  assert.ok(item.md.startsWith(join(customNotes, SUBJECT)), 'Markdown 应写入自定义目录')
  assert.ok(existsSync(item.md))
  assert.ok(existsSync(item.docx))
  assert.ok(app.paths.deliveredPath.startsWith(join(env.config.outputDir, '.state')), 'delivered 状态应留在原状态目录')
  assert.ok(existsSync(app.paths.deliveredPath))
  assert.match(spawnCalls[0].prompt, /自定义笔记/)
})

test('真实 Python 的 Markdown → Word 转换（捆绑运行时）', (t) => {
  const python = findPython()
  if (!python) {
    t.skip('未找到捆绑 Python')
    return
  }
  const dir = join(BASE, 'docx-' + (++seq))
  mkdirSync(dir, { recursive: true })
  const md = join(dir, 'in.md')
  const docx = join(dir, 'out.docx')
  writeFileSync(md, MANUAL, 'utf8')
  const result = convertMarkdownToDocx(python, md, docx, dir)
  assert.equal(result.ok, true, result.error)
  const buf = readFileSync(docx)
  assert.equal(buf.subarray(0, 2).toString('utf8'), 'PK')
  assert.ok(buf.length > 1000)
})

function findPython() {
  const runtimesDir = join(homedir(), '.dsh', 'dsh-runtimes')
  try {
    for (const rt of readdirSync(runtimesDir)) {
      const candidate = join(runtimesDir, rt, 'dependencies', 'python', 'python.exe')
      if (existsSync(candidate)) return candidate
    }
  } catch { /* 忽略 */ }
  return null
}
