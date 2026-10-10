/**
 * dsh-oh-story 的最小验证：用桩 context 驱动每个拦截点，断言
 * “非写作项目完全静默”与“写作项目按共享核判定拦截”两条主契约。
 *
 * 运行：node --test skills/story-setup/references/dsh/plugin/test/
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { apply, authorFacingBlock, authorFacingPostWrite, dshHome, normalizeConfig, walkToRoot, writeStatus } from '../index.js'

const HOOKS_DIR = path.resolve(import.meta.dirname, '../../../templates/hooks')

// 状态文件写在 $DSH_HOME 下，测试必须先把 home 指到临时目录，别污染真实的 ~/.dsh。
const TEST_HOME = mkdtempSync(path.join(tmpdir(), 'oh-story-home-'))
process.env.DSH_HOME = TEST_HOME

/**
 * 读插件落的加载状态文件。
 * @returns {object|null} 状态对象，读不到返回 null。
 */
function readStatus() {
  try {
    return JSON.parse(readFileSync(path.join(TEST_HOME, 'oh-story', 'plugin-status.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 造一个桩 context，记录注册的监听器与日志。
 * @returns {{ctx: object, listeners: Map<string, Function[]>, warnings: string[], setCwd: (dir: string) => void, agent: object, injected: object[], steered: object[]}} 桩环境。
 */
function makeHarness() {
  const listeners = new Map()
  const warnings = []
  const injected = []
  const steered = []
  let cwd = process.cwd()

  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    workingDirectory: { ensure: async () => cwd },
    on: (event, handler) => {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect: () => () => {},
  }

  const agent = {
    session: { header: { id: 'session-1' } },
    inject: (message) => injected.push(message),
    steer: (message) => steered.push(message),
  }

  return { ctx, listeners, warnings, setCwd: (dir) => { cwd = dir }, agent, injected, steered }
}

/**
 * 触发某个事件的第一个监听器。
 * @param {Map<string, Function[]>} listeners - 监听器表。
 * @param {string} event - 事件名。
 * @param {...unknown} args - 参数。
 * @returns {Promise<unknown>} 监听器返回值。
 */
async function fire(listeners, event, ...args) {
  const handler = listeners.get(event)?.[0]
  assert.ok(handler, `期望 ${event} 有监听器`)
  return handler(...args)
}

const ALLOW = async () => ({ kind: 'allow' })

/**
 * 造一个最小写作项目。
 * @param {{tracking?: boolean}} [options] - tracking 为 true 时写入可用的追踪状态。
 * @returns {string} 项目根。
 */
function makeStoryProject(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'oh-story-'))
  writeFileSync(path.join(root, '.story-deployed'), 'agents_version: 34\ntarget_cli: dsh\n', 'utf8')
  const book = path.join(root, '测试书')
  mkdirSync(path.join(book, '正文'), { recursive: true })
  mkdirSync(path.join(book, '大纲'), { recursive: true })
  mkdirSync(path.join(book, '追踪'), { recursive: true })
  writeFileSync(path.join(book, '设定.md'), '# 设定\n', 'utf8')
  if (options.tracking) {
    writeFileSync(
      path.join(book, '追踪', '_tracking-state.json'),
      JSON.stringify({ schema_version: 4, state_revision: 1, last_committed_chapter: 0 }),
      'utf8',
    )
    writeFileSync(path.join(book, '追踪', '上下文.md'), '## 当前位置\n- 状态修订：1\n', 'utf8')
  } else {
    writeFileSync(path.join(book, '追踪', '上下文.md'), '## 当前位置\n- 当前章：第1章\n', 'utf8')
  }
  mkdirSync(path.join(root, '.oh-story', 'agents'), { recursive: true })
  writeFileSync(path.join(root, '.oh-story', 'agents', 'narrative-writer.md'), '# 叙事写手\n', 'utf8')
  return root
}

test('缺 hooksDir 时落到默认位置，而不是让插件不激活', () => {
  const cfg = normalizeConfig({})
  assert.equal(cfg.hooksDir, path.join(TEST_HOME, 'oh-story', 'hooks'))
  const explicit = normalizeConfig({ hooksDir: 'D:/somewhere/hooks' })
  assert.equal(explicit.hooksDir, path.normalize('D:/somewhere/hooks'))
})

test('共享核加载不了时：不注册监听器，并落一份失败状态', () => {
  const h = makeHarness()
  h.setCwd(tmpdir())
  apply(h.ctx, { hooksDir: path.join(tmpdir(), 'definitely-not-here') })
  assert.equal(h.listeners.size, 0, '核缺失时不该注册任何监听器')
  const status = readStatus()
  assert.equal(status?.ok, false)
  assert.equal(status?.stage, 'load-core')
})

test('共享核装好时：注册六个时机，并落一份 ok 状态', () => {
  const h = makeHarness()
  apply(h.ctx, { hooksDir: HOOKS_DIR })
  for (const event of ['agent/created', 'tools/pre-execute', 'tools/post-execute', 'agent/turn-stopping', 'session/event', 'agent/pre-step']) {
    assert.ok(h.listeners.has(event), `应当注册 ${event}`)
  }
  const status = readStatus()
  assert.equal(status?.ok, true)
  assert.equal(path.normalize(status.hooksDir), path.normalize(HOOKS_DIR))
})

test('walkToRoot 能向上找到带标记的项目根', () => {
  const root = makeStoryProject()
  try {
    const nested = path.join(root, '测试书', '正文')
    assert.equal(walkToRoot(nested, '.story-deployed', 8), root)
    assert.equal(walkToRoot(tmpdir(), '.story-deployed', 2), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('非写作项目：所有时机都静默放行', async () => {
  const h = makeHarness()
  h.setCwd(tmpdir())
  apply(h.ctx, { hooksDir: HOOKS_DIR })

  await fire(h.listeners, 'agent/created', { agent: h.agent, signal: undefined })
  assert.equal(h.injected.length, 0, '不该注入上下文')

  const decision = await fire(h.listeners, 'tools/pre-execute', {
    name: 'write',
    arguments: { file_path: path.join(tmpdir(), '随便.md'), content: 'x' },
  }, ALLOW)
  assert.equal(decision.kind, 'allow', '不该拦工具')

  await fire(h.listeners, 'agent/turn-stopping', { agent: h.agent, turn: 1, signal: undefined })
  assert.equal(h.steered.length, 0, '不该 steer')
})

test('写作项目：会话开始注入状态卡与角色名册', async () => {
  const root = makeStoryProject()
  try {
    const h = makeHarness()
    h.setCwd(path.join(root, '测试书'))
    apply(h.ctx, { hooksDir: HOOKS_DIR })

    await fire(h.listeners, 'agent/created', { agent: h.agent, signal: undefined })
    assert.equal(h.injected.length, 1, '应当注入一次')
    const text = h.injected[0].content[0].text
    assert.match(text, /测试书/, '应当带上当前书目')
    assert.match(text, /续写状态卡/, '应当带上状态卡')
    assert.match(text, /narrative-writer/, '应当带上角色名册')
    assert.equal(h.injected[0].role, 'user')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写作项目：缺细纲写正文被拦下', async () => {
  const root = makeStoryProject()
  try {
    const h = makeHarness()
    h.setCwd(path.join(root, '测试书'))
    apply(h.ctx, { hooksDir: HOOKS_DIR })

    const target = path.join(root, '测试书', '正文', '第001章_开端.md')
    const decision = await fire(h.listeners, 'tools/pre-execute', {
      name: 'write',
      arguments: { file_path: target, content: '# 第1章\n正文……' },
    }, ALLOW)

    assert.equal(decision.kind, 'deny', '缺细纲应当 deny')
    assert.match(decision.reason, /细纲/, '原因里应当点明缺细纲')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写作项目：追踪状态缺失时，细纲齐了也照样拦', async () => {
  const root = makeStoryProject({ tracking: false })
  try {
    writeFileSync(
      path.join(root, '测试书', '大纲', '细纲_第001章.md'),
      `# 第1章 细纲\n${'情节点。'.repeat(20)}`,
      'utf8',
    )

    const h = makeHarness()
    h.setCwd(path.join(root, '测试书'))
    apply(h.ctx, { hooksDir: HOOKS_DIR })

    const decision = await fire(h.listeners, 'tools/pre-execute', {
      name: 'write',
      arguments: { file_path: path.join(root, '测试书', '正文', '第001章_开端.md'), content: '# 第1章\n正文……' },
    }, ALLOW)

    assert.equal(decision.kind, 'deny', '缺追踪状态应当 deny')
    assert.match(decision.reason, /_tracking-state\.json/, '原因里应当点明追踪状态缺失')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写作项目：细纲与追踪状态都齐了才放行', async () => {
  const root = makeStoryProject({ tracking: true })
  try {
    writeFileSync(
      path.join(root, '测试书', '大纲', '细纲_第001章.md'),
      `# 第1章 细纲\n${'情节点。'.repeat(20)}`,
      'utf8',
    )

    const h = makeHarness()
    h.setCwd(path.join(root, '测试书'))
    apply(h.ctx, { hooksDir: HOOKS_DIR })

    const decision = await fire(h.listeners, 'tools/pre-execute', {
      name: 'write',
      arguments: { file_path: path.join(root, '测试书', '正文', '第001章_开端.md'), content: '# 第1章\n正文……' },
    }, ALLOW)

    assert.equal(decision.kind, 'allow', `有细纲且追踪成立应当放行，实际：${decision.reason ?? ''}`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('写作项目：写完正文后回灌写后检查结论', async () => {
  const root = makeStoryProject({ tracking: true })
  try {
    const h = makeHarness()
    h.setCwd(path.join(root, '测试书'))
    apply(h.ctx, { hooksDir: HOOKS_DIR })

    const target = path.join(root, '测试书', '正文', '第001章_开端.md')
    writeFileSync(target, '短', 'utf8')

    const decision = await fire(h.listeners, 'tools/post-execute', {
      name: 'write',
      arguments: { file_path: target },
    }, { kind: 'accept', content: [] }, async () => ({ kind: 'accept', content: [] }))

    assert.equal(decision.kind, 'accept')
    assert.ok(Array.isArray(decision.additionalContexts) && decision.additionalContexts.length === 1,
      '应当回灌一条写后检查上下文')
    assert.match(decision.additionalContexts[0].content[0].text, /落盘|字节/, '应当点出落盘字节数异常')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('拦截文案：人话在前，共享核原文在后', () => {
  const raw = '⛔ 写正文被拦截：测试书 的追踪/_tracking-state.json 缺失；已有正文项目走 /story-import 的「旧追踪项目迁移」重建追踪（不必重跑全书拆解），新书先用 tracking_commit.py init 初始化。'
  const text = authorFacingBlock(raw, 'D:/proj/测试书/正文/第001章.md', 'write')
  const [head, ...rest] = text.split('\n')
  assert.ok(!/_tracking-state\.json|tracking_commit\.py/.test(head), '第一行不该出现脚本名或字段名')
  assert.match(head, /追踪状态还没建立/, '第一行应当是人话')
  assert.match(head, /第001章\.md/, '应当点名被拦的文件')
  assert.match(rest.join('\n'), /_tracking-state\.json/, '原文要留在后面，别丢信息')
})

test('拦截文案：认不出的形态按类别兜底，不吞原文', () => {
  const text = authorFacingBlock('某种没见过的失败', '', 'commit')
  assert.match(text.split('\n')[0], /这次提交被拦下了/)
  assert.match(text, /某种没见过的失败/)
  assert.equal(authorFacingBlock('', '', 'write'), '')
})

test('写后检查文案：摘掉横幅，命中行原样保留', () => {
  const raw = '=== 正文兜底检测（测试书/正文/第001章.md）===\n轻量确定性网自动复扫（模型无关，防主会话漏跑收尾）。按类型处理后复扫到净：\n第3行 工程词泄漏：「细纲」'
  const text = authorFacingPostWrite(raw, 'D:/proj/测试书/正文/第001章.md')
  assert.ok(!text.includes('==='), '不该留横幅')
  assert.ok(!text.includes('轻量确定性网'), '不该留说明性旁白')
  assert.match(text, /第3行 工程词泄漏：「细纲」/, '命中行要原样保留')
})