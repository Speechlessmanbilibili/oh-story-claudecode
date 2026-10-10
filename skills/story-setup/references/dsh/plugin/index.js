/**
 * dsh-oh-story — DeepSeek Harness 原生宿主适配插件。
 *
 * 把 oh-story 的四个运行时时机接到 Harness 原生的拦截点上：
 *   - `agent/created`        会话开始 → 注入活跃书目、续写状态卡、连续性提醒、角色名册
 *   - `tools/pre-execute`    写正文前 → 缺细纲/细纲为空/追踪检查点不成立/git commit 校验 → deny
 *   - `tools/post-execute`   写完正文 → 跑写后网（AI 句式、截断、落盘）→ 回灌检查结果
 *   - `agent/turn-stopping`  回合收尾 → 连续性欠账 → steer 一轮
 *   - `session/event` + `agent/pre-step`  压缩兜底 → 压缩后重注续写状态卡
 *
 * 设计约束（与 Harness 官方插件同构）：
 *   1. 零运行时依赖。不 import 任何 `@deepseek-ai/*`，因此插件既不依赖 profile 的
 *      node_modules 形状，也不受 asar 内解析规则影响；`createUserMessage` 按官方
 *      实现就地复刻（`{...input, role:'user', id: uuid}` + deepFreeze）。
 *   2. 非写作项目必须完全静默。插件挂在 profile 上会对**该 profile 的所有会话**加载，
 *      所以每个时机先解析会话工作目录，向上找项目标记（默认 `.story-deployed`），
 *      找不到就直接 `next()`，不产生任何上下文、不拦任何工具。
 *   3. 判定归核。所有规则判定都调 `story_hook_cli.js` 的共享核 `story_hook_core.js`，
 *      与 claude-code / codex / opencode / zcode 各端同一份实现，避免出现两端结论不一致。
 *   4. 任何异常一律降级放行。核缺失、解析失败、路径算不出来都返回 `next()`，
 *      宁可漏拦不可误伤。
 *
 * @module dsh-oh-story
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

/** Cordis 插件元数据。 */
export const name = 'oh-story'

/**
 * 不声明任何 inject。
 *
 * Cordis 里 `inject` 是激活前置：列进去的服务没就绪，`apply` 根本不会被调用。
 * 早期版本声明了 `workingDirectory`，一旦该服务名或装载时机跟预期不符，插件就会
 * 静默地永不激活，而 Harness 默认没有可见日志，这种失败查不出来。
 * 工作目录改为在事件里惰性取（见 rootFor 的三级回落），拿不到就按非写作项目静默放行。
 */
export const inject = []

/** 默认的项目标记文件，与其它宿主的 `.story-deployed` 保持一致。 */
export const DEFAULT_PROJECT_MARKER = '.story-deployed'

/** 会话开始注入的来源名。 */
export const CONTEXT_SECTION = 'oh-story'

/** 会写文件的工具名（小写比较）。 */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'multi_edit',
  'multiedit',
  'str_replace_editor',
  'str-replace-editor',
  'notebook_edit',
  'apply_patch',
])

/** 会执行 shell 的工具名（小写比较）。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'terminal', 'run_command'])

/** 工具参数里可能承载目标文件路径的键。 */
const FILE_ARG_KEYS = ['file_path', 'filePath', 'path', 'filename', 'target_file', 'targetFile']

/** 工具参数里可能承载命令的键。 */
const COMMAND_ARG_KEYS = ['command', 'cmd', 'script']

/**
 * 复刻 `@deepseek-ai/dsh-llm` 的 `createUserMessage`。
 * 官方实现就是 `createMessage({ ...input, role: 'user' })`，
 * 而 `createMessage` 是 `deepFreeze(structuredClone({ ...input, id: randomUUID() }))`。
 * 复刻它是为了让本插件零运行时依赖 —— 见文件头设计约束 1。
 * @param {{ content: unknown[], source: unknown }} input - 内容块与来源。
 * @returns {object} 冻结后的用户消息。
 */
export function createUserMessage(input) {
  return Object.freeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/**
 * 构造本插件注入上下文的 source 字段。
 * @param {string} section - 小节名，便于在会话记录里区分注入点。
 * @param {string} text - 注入文本。
 * @returns {{ kind: string, form: string, sections: { name: string, text: string }[] }} 来源描述。
 */
function contextSource(section, text) {
  return { kind: CONTEXT_SECTION, form: 'snapshot', sections: [{ name: section, text }] }
}

/**
 * 归一化并校验插件配置。缺 `hooksDir` 直接抛错，让加载期就暴露问题。
 * @param {unknown} raw - 加载器传入的原始配置。
 * @returns {{ hooksDir: string, projectMarker: string, contextMaxChars: number, blockOnPostWrite: boolean, steerOnGaps: boolean, rosterDir: string|null, maxRootWalk: number }} 归一化后的配置。
 */
export function normalizeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  // hooksDir 不给就用默认位置：$DSH_HOME/oh-story/hooks。装了包但没写 profile 补丁时
  // 也能落在正确目录上，不用因为少一个字段就让整个插件不激活。
  const hooksDir = typeof cfg.hooksDir === 'string' && cfg.hooksDir
    ? path.resolve(cfg.hooksDir)
    : path.join(dshHome(), 'oh-story', 'hooks')
  const rosterDir = typeof cfg.rosterDir === 'string' && cfg.rosterDir ? cfg.rosterDir : null
  const contextMaxChars = Number.isInteger(cfg.contextMaxChars) && cfg.contextMaxChars > 0
    ? cfg.contextMaxChars
    : 8000
  const maxRootWalk = Number.isInteger(cfg.maxRootWalk) && cfg.maxRootWalk > 0
    ? cfg.maxRootWalk
    : 8
  return {
    hooksDir,
    projectMarker: typeof cfg.projectMarker === 'string' && cfg.projectMarker
      ? cfg.projectMarker
      : DEFAULT_PROJECT_MARKER,
    contextMaxChars,
    blockOnPostWrite: cfg.blockOnPostWrite === true,
    // 默认开：连续性欠账在回合收尾时提醒一轮；设 false 可只保留工具拦截。
    steerOnGaps: cfg.steerOnGaps !== false,
    rosterDir,
    maxRootWalk,
  }
}

/**
 * 解析 Harness home：优先 `DSH_HOME`，否则 `~/.dsh`。
 * @returns {string} home 绝对路径。
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

/**
 * 写一份加载状态文件，供部署验证与排障读取。
 *
 * Harness 默认没有可见日志，插件「加载失败」和「加载成功但没命中」在外部看起来
 * 一模一样。落一份状态文件是最省事的判据：文件在且 `ok: true` 就说明插件真的起来了。
 *
 * @param {Record<string, unknown>} status - 状态内容。
 * @returns {void}
 */
export function writeStatus(status) {
  try {
    const dir = path.join(dshHome(), 'oh-story')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'plugin-status.json'),
      `${JSON.stringify({ ...status, pid: process.pid, at: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
  } catch (error) {
    // 状态文件写不了不影响主流程；排障时设 OH_STORY_DEBUG=1 让它抛出来。
    if (process.env.OH_STORY_DEBUG) throw error
  }
}

/**
 * 从起始目录向上找写作项目根。
 *
 * 两轮扫描：先只认项目标记（默认 `.story-deployed`），整条链都找不到时，
 * 才退回认“含 追踪/ 或 .active-book 的目录”。必须分两轮，否则书目录
 * （书下面就有 追踪/）会在标记层之上先被命中，把项目根判成书目录。
 *
 * @param {string} startDir - 会话工作目录。
 * @param {string} marker - 标记文件名。
 * @param {number} maxWalk - 最多向上几层。
 * @returns {string|null} 写作项目根，找不到返回 null。
 */
export function walkToRoot(startDir, marker, maxWalk) {
  if (!startDir) return null
  const start = path.resolve(startDir)
  for (const mode of ['marker', 'legacy']) {
    let dir = start
    for (let depth = 0; depth < maxWalk; depth += 1) {
      const hit = mode === 'marker'
        ? existsSync(path.join(dir, marker))
        : existsSync(path.join(dir, '追踪')) || existsSync(path.join(dir, '.active-book'))
      if (hit) return dir
      const up = path.dirname(dir)
      if (up === dir) break
      dir = up
    }
  }
  return null
}

/**
 * 从参数对象里按候选键取第一个非空字符串（含一层嵌套）。
 * @param {unknown} args - 工具参数。
 * @param {string[]} keys - 候选键。
 * @param {boolean} [allowEmpty] - 是否允许空串命中。
 * @returns {string} 命中的字符串或空串。
 */
function firstString(args, keys, allowEmpty = false) {
  if (!args || typeof args !== 'object') return ''
  const record = /** @type {Record<string, unknown>} */ (args)
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && (allowEmpty || value)) return value
  }
  for (const nestedKey of ['tool_input', 'input', 'parameters', 'args']) {
    const nested = record[nestedKey]
    if (nested && typeof nested === 'object') {
      const found = firstString(nested, keys, allowEmpty)
      if (found) return found
    }
  }
  return ''
}

/**
 * 把目标路径按项目根解析成绝对路径。
 * @param {string} root - 项目根。
 * @param {string} target - 工具给的目标路径。
 * @returns {string} 绝对路径。
 */
function absoluteTarget(root, target) {
  if (path.isAbsolute(target)) return path.normalize(target)
  return path.resolve(root, target)
}

/**
 * 读取并拼装会话开始要注入的上下文。
 * @param {object} core - 共享核。
 * @param {object} config - 归一化配置。
 * @param {string} root - 写作项目根。
 * @returns {string} 供注入的文本，无可注入内容时返回空串。
 */
function buildContext(core, config, root) {
  const parts = []

  let book = null
  try {
    book = core.discoverActiveBook(root) || null
  } catch {
    book = null
  }

  if (book) {
    parts.push(`当前写作项目：${path.basename(book)}`)
    const cardPath = path.join(book, '追踪', '上下文.md')
    if (existsSync(cardPath)) {
      let card = ''
      try {
        card = readFileSync(cardPath, 'utf8')
      } catch {
        card = ''
      }
      if (card) {
        if (card.length > config.contextMaxChars) {
          card = `${card.slice(0, config.contextMaxChars)}\n……（内容过长已截断，完整内容见 追踪/上下文.md）`
        }
        parts.push(`续写状态卡（追踪/上下文.md）：\n${card}`)
      }
    }
  }

  try {
    const findings = core.continuityFindings(root)
    if (Array.isArray(findings) && findings.length > 0) {
      parts.push(`连续性提醒：\n${findings.map((item) => `- ${String(item)}`).join('\n')}`)
    }
  } catch {
    /* 核判定失败不注入，见设计约束 4。 */
  }

  const roster = buildRoster(config, root)
  if (roster) parts.push(roster)

  return parts.join('\n\n')
}

/**
 * 列出角色名册。Harness 没有“按名字 spawn 的自定义 agent 注册表”，
 * 所以 7 个角色以剧本文件的形式随项目部署，这里把名册注入上下文，
 * 由写作流程在需要时用 subagent 工具带上对应剧本 spawn。
 * @param {object} config - 归一化配置。
 * @param {string} root - 写作项目根。
 * @returns {string} 名册文本，没部署角色时返回空串。
 */
function buildRoster(config, root) {
  const dir = config.rosterDir
    ? path.resolve(root, config.rosterDir)
    : path.join(root, '.oh-story', 'agents')
  let entries = []
  try {
    entries = readdirSync(dir).filter((file) => file.endsWith('.md')).sort()
  } catch {
    return ''
  }
  if (entries.length === 0) return ''
  const lines = entries.map((file) => `- ${file.replace(/\.md$/, '')} → ${path.join(dir, file)}`)
  return [
    '写作角色名册（需要分工时，用 subagent 工具启动对应角色，并在 prompt 开头附上该角色剧本全文）：',
    ...lines,
  ].join('\n')
}

/**
 * 把共享核给的拦截原文翻成书面语说明。
 *
 * 共享核是各端共用的判定层，它的文案面向实现：带 `_tracking-state.json`、
 * `tracking_commit.py`、`schema_version` 这类脚本名和字段名。作者不该读到这些，
 * 但模型需要原文里的路径与补救步骤，所以做法是「说明在前，原文在后」，
 * 不丢信息也不把工程话摆到第一眼。
 *
 * 认不出形态时按类别给一句兜底，原文照旧附在后面，不猜、不吞。
 *
 * @param {string} raw - 共享核返回的拦截原文。
 * @param {string} target - 被拦的目标文件（可空）。
 * @param {'write'|'commit'} kind - 拦截类型，决定兜底用词。
 * @returns {string} 拦截说明。
 */
export function authorFacingBlock(raw, target = '', kind = 'write') {
  const text = String(raw || '').trim()
  if (!text) return ''
  const name = target ? path.basename(target) : ''
  const rules = [
    { test: /缺少细纲/, say: '本章尚无细纲。请先补建本章细纲，再开始写正文。' },
    { test: /细纲.*(是空的|不到)/, say: '本章细纲内容不足。请先写清本章发生什么、主角做了什么选择，再开始写正文。' },
    { test: /_tracking-state\.json 缺失/, say: '本书尚未建立追踪状态。新书请先完成开书流程以初始化追踪；已有正文的作品请通过导入流程重建，不要手工补写。' },
    { test: /无法解析/, say: '追踪状态文件无法解析。请通过导入流程重建，不要猜测或手工补写。' },
    { test: /schema_version|schema 不是/, say: '追踪状态为旧版结构。请通过导入流程重建，不保留旧结构。' },
    { test: /状态修订/, say: '续写状态卡与追踪状态不一致。请为本章重新提交追踪事务，由工具整份重建派生视图，不要分别手工修改状态卡与伏笔。' },
    { test: /追踪已提交到第|先提交第/, say: '上一章的追踪事务尚未提交。请先完成上一章提交，再开始写本章。' },
    { test: /未清毒句式欠账/, say: '上一章仍有未清理的 AI 句式欠账。请先清零，再开始写本章；若作者明确本章无需去味，请在上一章标题行下标注后再重试。' },
  ]
  const hit = rules.find((rule) => rule.test.test(text))
  const head = hit
    ? hit.say
    : (kind === 'commit' ? '本次提交已被拦截。' : '本次写入已被拦截。')
  const where = name ? `（${name}）` : ''
  return `${head}${where}\n原始提示：${text}`
}

/**
 * 把写后网的原始输出整理成书面语说明。
 *
 * 共享核的输出带一层说明性横幅（`=== 正文兜底检测（路径）===` 与
 * 「轻量确定性网自动复扫……」），对作者是噪音；真正有用的是后面的逐条命中。
 * 这里只摘横幅，命中行原样保留——改写命中就等于改判定。
 *
 * @param {string} findings - 共享核 proseAfterWrite 的输出。
 * @param {string} target - 目标文件。
 * @returns {string} 写后检查说明。
 */
export function authorFacingPostWrite(findings, target) {
  const kept = String(findings || '')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('===') && !line.includes('轻量确定性网自动复扫'))
  if (kept.length === 0) return ''
  return `写后检查（${path.basename(target)}）：\n${kept.join('\n')}`
}

/**
 * 判定本次工具调用是否要被拦截。
 * @param {object} core - 共享核。
 * @param {object} exec - Harness 的工具执行记录。
 * @param {string} root - 写作项目根。
 * @returns {{ reason: string, target: string, kind: 'write'|'commit' }|null} 拦截信息；不该拦时返回 null。
 */
function guardReason(core, exec, root) {
  const tool = String(exec.name || '').toLowerCase()
  const args = exec.arguments

  if (WRITE_TOOLS.has(tool)) {
    const target = firstString(args, FILE_ARG_KEYS)
    if (!target) return null
    const abs = absoluteTarget(root, target)
    try {
      const reason = core.proseBlockReason(root, abs) || ''
      return reason ? { reason, target: abs, kind: 'write' } : null
    } catch {
      return null
    }
  }

  if (SHELL_TOOLS.has(tool)) {
    const command = firstString(args, COMMAND_ARG_KEYS, true)
    if (!command) return null
    try {
      if (core.isGitCommitCommand(command)) {
        const warnings = core.stagedMarkdownWarnings(root)
        if (Array.isArray(warnings) && warnings.length > 0) {
          return { reason: warnings.join('\n'), target: '', kind: 'commit' }
        }
        return null
      }
      const targets = core.extractProseTargets(command)
      if (Array.isArray(targets)) {
        for (const target of targets) {
          const abs = absoluteTarget(root, String(target))
          const reason = core.proseBlockReason(root, abs) || ''
          if (reason) return { reason, target: abs, kind: 'write' }
        }
      }
    } catch {
      return null
    }
  }

  return null
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @param {unknown} rawConfig - 加载器传入的配置。
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  let config
  try {
    config = normalizeConfig(rawConfig)
  } catch (error) {
    writeStatus({ ok: false, stage: 'normalizeConfig', error: String(error) })
    ctx.logger?.warn?.(`oh-story: 配置解析失败，插件不生效：${String(error)}`)
    return
  }
  const require_ = createRequire(import.meta.url)

  let core
  try {
    core = require_(path.join(config.hooksDir, 'story_hook_core.js'))
  } catch (error) {
    writeStatus({ ok: false, stage: 'load-core', hooksDir: config.hooksDir, error: String(error) })
    ctx.logger?.warn?.(`oh-story: 共享核加载失败，插件不生效：${String(error)}`)
    return
  }

  /** sessionId → 项目根（null 表示这个会话不是写作项目）。 */
  const rootCache = new Map()
  /** sessionId → 是否已经注入过会话开始上下文。 */
  const injected = new Set()
  /** sessionId → 检测到压缩、等下一步重注。 */
  const pendingReinject = new Set()
  /** `${sessionId}:${turn}` → 已经 steer 过，避免同一回合反复续写。 */
  const steered = new Set()
  /** 命中计数的落盘节流：只在第一次命中时写状态。 */
  let guardHits = 0
  let firstGuardRecorded = false

  /**
   * 解析某次调用所属的写作项目根，带会话级缓存。
   *
   * 工作目录三级回落：工作目录服务 → session header 里的 cwd → 进程 cwd。
   * 三级都拿不到就返回 null，按非写作项目静默放行（见 inject 的说明）。
   *
   * @param {object|undefined} agent - 会话主体。
   * @param {AbortSignal|undefined} signal - 取消信号。
   * @returns {Promise<string|null>} 项目根或 null。
   */
  async function rootFor(agent, signal) {
    const sessionId = agent?.session?.header?.id ?? null
    if (sessionId && rootCache.has(sessionId)) return rootCache.get(sessionId)

    let cwd = ''
    try {
      cwd = (await ctx.workingDirectory?.ensure?.(agent, signal)) || ''
    } catch {
      cwd = ''
    }
    if (!cwd || typeof cwd !== 'string') {
      const header = agent?.session?.header
      cwd = (typeof header?.cwd === 'string' && header.cwd)
        || (typeof header?.workingDirectory === 'string' && header.workingDirectory)
        || ''
    }
    if (!cwd || typeof cwd !== 'string') cwd = process.cwd()

    const root = walkToRoot(cwd, config.projectMarker, config.maxRootWalk)
    if (sessionId) rootCache.set(sessionId, root)
    return root
  }

  /**
   * 注入一段上下文，失败只记日志。
   * @param {object} agent - 会话主体。
   * @param {string} section - 小节名。
   * @param {string} text - 文本。
   * @returns {object|undefined} 生成的消息，失败返回 undefined。
   */
  function makeMessage(section, text) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: contextSource(section, text),
    })
  }

  // 会话开始：注入活跃书目、续写状态卡、连续性提醒、角色名册。
  ctx.on('agent/created', async ({ agent, signal }) => {
    const sessionId = agent?.session?.header?.id ?? null
    if (sessionId && injected.has(sessionId)) return
    const root = await rootFor(agent, signal)
    if (!root) return
    if (sessionId) injected.add(sessionId)
    const text = buildContext(core, config, root)
    if (!text) return
    try {
      agent.inject?.(makeMessage('session-start', text))
    } catch (error) {
      ctx.logger?.warn?.(`oh-story: 会话开始注入失败：${String(error)}`)
    }
  })

  // 写正文前：细则门、追踪检查点门、git commit 校验。
  ctx.on('tools/pre-execute', async (exec, next) => {
    const root = await rootFor(exec.agent, exec.signal)
    if (!root) return next()
    const blocked = guardReason(core, exec, root)
    if (blocked) {
      // 第一次真拦下来时写一次状态，便于在外部确认插件不只是「起来了」而是「在干活」。
      guardHits += 1
      if (!firstGuardRecorded) {
        firstGuardRecorded = true
        writeStatus({
          ok: true, hooksDir: config.hooksDir, guardHits,
          note: 'first guard hit', tool: String(exec.name || ''), reason: blocked.reason,
        })
      }
      return { kind: 'deny', reason: authorFacingBlock(blocked.reason, blocked.target, blocked.kind) }
    }
    return next()
  })

  // 写正文后：跑写后网，把结论回灌给模型。
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const root = await rootFor(exec.agent, exec.signal)
    if (!root) return next()
    if (!WRITE_TOOLS.has(String(exec.name || '').toLowerCase())) return next()
    const target = firstString(exec.arguments, FILE_ARG_KEYS)
    if (!target) return next()

    let findings = ''
    try {
      findings = core.proseAfterWrite(root, absoluteTarget(root, target)) || ''
    } catch {
      findings = ''
    }
    if (!findings) return next()

    const text = authorFacingPostWrite(findings, target)
    if (!text) return next()
    const downstream = await next()
    if (config.blockOnPostWrite) {
      const feedback = [{ type: 'text', text }]
      if (downstream && downstream.kind === 'block') {
        return { ...downstream, feedback: [...(downstream.feedback ?? []), ...feedback] }
      }
      return { kind: 'block', feedback }
    }
    if (downstream && downstream.kind === 'block') return downstream
    return {
      ...downstream,
      additionalContexts: [...(downstream?.additionalContexts ?? []), makeMessage('post-write', text)],
    }
  })

  // 回合收尾：还有连续性欠账就提醒一轮。
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    if (!config.steerOnGaps) return
    const root = await rootFor(agent, signal)
    if (!root) return
    const key = `${agent?.session?.header?.id ?? 'anon'}:${String(turn)}`
    if (steered.has(key)) return

    let findings = []
    try {
      findings = core.continuityFindings(root) || []
    } catch {
      findings = []
    }
    if (!Array.isArray(findings) || findings.length === 0) return

    steered.add(key)
    const text = `本轮结束前仍有连续性欠账：\n${findings.map((item) => `- ${String(item)}`).join('\n')}`
    try {
      agent.steer?.(makeMessage('turn-stop', text))
    } catch (error) {
      ctx.logger?.warn?.(`oh-story: 收尾提醒失败：${String(error)}`)
    }
  })

  // 压缩兜底：Harness 没有 PreCompact / PostCompact 这一对事件，改从会话事件流里
  // 嗅探 compaction/*，标记该会话；下一步再重注续写状态卡。注册失败不影响其它时机。
  try {
    ctx.on('session/event', (payload) => {
      const type = payload?.event?.type ?? payload?.type
      if (typeof type !== 'string' || !type.startsWith('compaction/')) return
      const sessionId = payload?.session?.header?.id ?? payload?.session?.id ?? payload?.event?.sessionId
      if (sessionId) pendingReinject.add(sessionId)
    })
  } catch {
    ctx.logger?.warn?.('oh-story: 当前 Harness 不支持 session/event，压缩后重注不可用')
  }

  // 压缩后重注：把续写状态卡补回上下文。
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const sessionId = agent?.session?.header?.id ?? null
    if (!sessionId || !pendingReinject.has(sessionId)) return next()
    pendingReinject.delete(sessionId)
    const root = await rootFor(agent, signal)
    const downstream = await next()
    if (!root || !downstream || downstream.kind !== 'enter') return downstream
    const text = buildContext(core, config, root)
    if (!text) return downstream
    return { ...downstream, messages: [...(downstream.messages ?? []), makeMessage('post-compact', text)] }
  })

  // 全部监听器注册完成才写状态：文件在且 ok:true，就证明插件真的被装载并接上了。
  writeStatus({ ok: true, hooksDir: config.hooksDir, guardHits: 0 })
}

export default { name, inject, apply }
