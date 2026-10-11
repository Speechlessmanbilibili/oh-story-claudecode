#!/usr/bin/env node
/**
 * generate-dsh-agents.mjs — 把 story-setup 的角色剧本适配成 DeepSeek Harness 版，
 * 写入写作项目的 `.oh-story/agents/`，同时铺 `.oh-story/rules/`。
 *
 * 为什么要生成而不是直接复制：剧本正文里写死了 Claude Code 的路径与调用语法
 * （`{项目根}/.claude/skills/...`、`$CLAUDE_PROJECT_DIR/.claude/hooks/...`、
 * `Agent(subagent_type: "x")`）。dsh 的项目级 skills 在 `.dsh/skills/`，hooks 在
 * `$DSH_HOME/oh-story/hooks/`，也没有 subagent_type 这个参数。照字面复制过去，
 * 子代理会去 `.claude/` 找参考文件，找不到就返回缺失事实，整条链白跑。
 *
 * 做法与上游 `generate-antigravity-agents.mjs` 同构：保留剧本的方法论正文不动，
 * 只置换宿主相关的字面量，并在文末追加一段宿主适配说明。
 *
 * 用法：
 *   node generate-dsh-agents.mjs --target <项目根> [--source <skill 包 references 目录>] [--hooks-dir <路径>]
 *
 * 输出：一行 JSON 报告（agents / rules / rewrites）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const AGENT_NAMES = [
  'chapter-extractor',
  'character-designer',
  'consistency-checker',
  'narrative-writer',
  'story-architect',
  'story-explorer',
  'story-researcher',
]

/** dsh 项目级 skills 根，剧本里所有 references 相对路径都按它解析。 */
const DSH_SKILLS_ROOT = '.dsh/skills'

/** dsh 的 hooks 落点；部署时会被铺到 $DSH_HOME/oh-story/hooks/。 */
const DEFAULT_HOOKS_DIR = '$DSH_HOME/oh-story/hooks'

/**
 * 解析命令行参数。
 * @returns {{target: string, source: string, hooksDir: string}} 参数。
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  const out = { target: '', source: '', hooksDir: DEFAULT_HOOKS_DIR }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1] ?? ''
    if (key === '--target') { out.target = value; i += 1 } else if (key === '--source') { out.source = value; i += 1 } else if (key === '--hooks-dir') { out.hooksDir = value; i += 1 }
  }
  if (!out.target) {
    process.stderr.write('usage: node generate-dsh-agents.mjs --target <项目根> [--source <skill 包 references 目录>] [--hooks-dir <路径>]\n')
    process.exit(2)
  }
  if (!out.source) {
    out.source = path.resolve(import.meta.dirname, '../references')
  }
  return out
}

/**
 * 拆分 frontmatter 与正文。
 * @param {string} text - 文件全文。
 * @returns {{frontmatter: string, body: string}} 两段。
 */
function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (!normalized.startsWith('---\n')) return { frontmatter: '', body: normalized }
  const end = normalized.indexOf('\n---', 4)
  if (end < 0) return { frontmatter: '', body: normalized }
  return {
    frontmatter: normalized.slice(0, end + 4),
    body: normalized.slice(end + 5).replace(/^\s+/, ''),
  }
}

/**
 * 从 frontmatter 里摘掉 `hooks:` 块。
 *
 * 上游只有 chapter-extractor 带这一块，用来把 `analysis-input-guard` 挂到它自己的
 * Write/Edit 上。dsh 没有 per-agent hooks，这块照搬过去既不会执行、又留着一个别的
 * 宿主的路径。摘掉，并在宿主说明里讲明这条守卫改由自律承担。
 *
 * @param {string} frontmatter - 原始 frontmatter（含首尾 ---）。
 * @returns {{text: string, removed: boolean}} 处理后的 frontmatter 与是否摘过。
 */
function stripHooksBlock(frontmatter) {
  const lines = frontmatter.split('\n')
  const kept = []
  let removed = false
  let skipping = false
  for (const line of lines) {
    if (/^hooks:\s*$/.test(line)) {
      removed = true
      skipping = true
      continue
    }
    if (skipping) {
      // 缩进行与空行属于该块；遇到下一个顶层键或收尾的 --- 才停。
      if (/^\s/.test(line) || line.trim() === '') continue
      skipping = false
    }
    kept.push(line)
  }
  return { text: kept.join('\n'), removed }
}

/**
 * 把剧本正文里的 Claude Code 字面量换成 dsh 的。
 *
 * 每一条都记进 rewrites，便于部署报告与回归检查核对“换了什么、换了几处”——
 * 静默替换会让上游改了措辞之后这里悄悄失配。
 *
 * @param {string} text - 待适配的文本（frontmatter 与正文都过一遍）。
 * @param {string} name - 角色名。
 * @param {string} hooksDir - dsh 的 hooks 落点。
 * @returns {{text: string, rewrites: {rule: string, count: number}[]}} 适配后的文本与替换统计。
 */
function adaptText(text, name, hooksDir) {
  const rewrites = []
  /**
   * 记录并执行一次字符串替换。
   * @param {string} from - 原文。
   * @param {string} to - 新文。
   * @returns {void}
   */
  const swap = (from, to) => {
    const count = text.split(from).length - 1
    if (count > 0) {
      text = text.split(from).join(to)
      rewrites.push({ rule: `${from} → ${to}`, count })
    }
  }

  swap('.claude/skills/story-setup/references/', `${DSH_SKILLS_ROOT}/story-setup/references/`)
  swap('"$CLAUDE_PROJECT_DIR"/.claude/hooks/', `"${hooksDir}"/`)
  swap('当前 Claude 部署', '当前 DeepSeek Harness 部署')
  swap('Claude Code subagent', 'DeepSeek Harness 角色剧本')
  swap('**确定项目根目录：** 执行 `git rev-parse --show-toplevel`，失败则用当前工作目录。以下所有路径均为项目根下的绝对路径。',
    '**确定项目根目录：** 直接使用宿主交给你的当前工作区/项目根；不要执行 shell。以下所有路径均从该根目录解析。')
  swap(`Agent(subagent_type: "${name}")`, `subagent 工具（prompt 里带上 \`.oh-story/agents/${name}.md\` 的路径）`)
  // chapter-extractor 的 frontmatter 注释谈的是别的宿主的挂载点，dsh 没有这一层。
  swap('# analysis-input-guard，经本挂载点只作用于本 agent。改 tools 就同步改 matcher。',
    '# analysis-input-guard。dsh 没有这个挂载点，这条写入范围约束靠你自己守。')
  swap('# OpenCode 没有这个挂载点：sync-opencode.py 按守卫名把 edit 权限收窄到同一批路径。', '')

  return { text, rewrites }
}

/**
 * 追加宿主适配说明。
 *
 * 说明文本本身刻意不出现别的宿主的目录名与参数名，好让部署校验能用一个严格断言
 * 卡住「产物里不许再有任何宿主专有字面量」。
 *
 * @param {string} body - 适配后的正文。
 * @param {string} name - 角色名。
 * @param {string} hooksDir - dsh 的 hooks 落点。
 * @param {boolean} hooksStripped - frontmatter 的 hooks 块是否被摘掉。
 * @returns {string} 带说明的正文。
 */
function appendHostNote(body, name, hooksDir, hooksStripped) {
  const lines = [
    '',
    '---',
    '',
    'DeepSeek Harness 适配说明：',
    '',
    `- 宿主是 DeepSeek Harness（dsh）。项目级 skills 根是 \`${DSH_SKILLS_ROOT}\`，剧本里所有 \`story-setup/references/...\` 与 \`agent-references/...\` 都按这个根解析，不要去别的宿主的 skills 目录找。`,
    `- 参考文件目录：\`${DSH_SKILLS_ROOT}/story-setup/references/agent-references/\`。按剧本开头的规则逐行判定读取条件，未命中的不要预加载。`,
    `- 本项目的 hooks（含 \`story_hook_cli.js\`）落在 \`${hooksDir}\`，不在项目内。`,
    '- 调用方式：主会话用 `subagent` 工具启动你，prompt 里给出本剧本路径并要求你先完整读取。dsh 没有按类型 spawn 的参数，也没有“按名字 spawn 的自定义 agent 注册表”，角色由剧本承载。',
    '- frontmatter 里的 `model` / `maxTurns` / `tools` / `disallowedTools` 只是上游的声明，dsh 不据此配置运行时；你实际能用什么工具由宿主决定。',
  ]
  if (hooksStripped) {
    lines.push('- 上游给本角色在 frontmatter 挂了 pre-tool 守卫，dsh 没有这一层，该块已移除：守卫不生效，写入范围改由你自己守住。')
  }
  lines.push('- 交付后只回调用方要求的那几项；越出本角色边界的工作交回主会话。', '')
  return `${body.trimEnd()}\n${lines.join('\n')}`
}

/**
 * 主流程。
 * @returns {void}
 */
function main() {
  const args = parseArgs()
  const targetRoot = path.resolve(args.target)
  const agentsSrc = path.join(args.source, 'templates', 'agents')
  const rulesSrc = path.join(args.source, 'templates', 'rules')
  if (!existsSync(agentsSrc)) {
    process.stderr.write(`generate-dsh-agents: 源目录不存在：${agentsSrc}\n`)
    process.exit(1)
  }

  const agentsOut = path.join(targetRoot, '.oh-story', 'agents')
  const rulesOut = path.join(targetRoot, '.oh-story', 'rules')
  // 只替换 story-setup 管理的已知角色目录内容，不动用户放在同层的其它文件。
  mkdirSync(agentsOut, { recursive: true })
  mkdirSync(rulesOut, { recursive: true })

  const report = { agents: [], rules: [], rewrites: {}, missing: [], hooksStripped: [] }
  for (const name of AGENT_NAMES) {
    const src = path.join(agentsSrc, `${name}.md`)
    if (!existsSync(src)) {
      report.missing.push(`${name}.md`)
      continue
    }
    const parsed = splitFrontmatter(readFileSync(src, 'utf8'))
    // frontmatter 也要过一遍：chapter-extractor 的守卫挂在 frontmatter 的 hooks 块里。
    const head = stripHooksBlock(parsed.frontmatter)
    if (head.removed) report.hooksStripped.push(name)

    const rewrites = []
    const adaptedHead = adaptText(head.text, name, args.hooksDir)
    const adaptedBody = adaptText(parsed.body, name, args.hooksDir)
    rewrites.push(...adaptedHead.rewrites, ...adaptedBody.rewrites)

    const rendered = `${adaptedHead.text}\n\n${appendHostNote(adaptedBody.text, name, args.hooksDir, head.removed)}`
    writeFileSync(path.join(agentsOut, `${name}.md`), rendered, 'utf8')
    report.agents.push(name)
    for (const item of rewrites) {
      report.rewrites[item.rule] = (report.rewrites[item.rule] ?? 0) + item.count
    }
  }

  if (existsSync(rulesSrc)) {
    for (const entry of readdirSync(rulesSrc)) {
      if (!entry.endsWith('.md')) continue
      writeFileSync(path.join(rulesOut, entry), readFileSync(path.join(rulesSrc, entry), 'utf8'), 'utf8')
      report.rules.push(entry)
    }
  }

  // 清理上游已删除的角色，避免旧的宿主适配文件留在项目里被误读。
  for (const entry of readdirSync(agentsOut)) {
    if (!entry.endsWith('.md')) continue
    const stem = entry.replace(/\.md$/, '')
    if (!AGENT_NAMES.includes(stem)) {
      rmSync(path.join(agentsOut, entry))
      report.missing.push(`removed stale ${entry}`)
    }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`)
}

main()
