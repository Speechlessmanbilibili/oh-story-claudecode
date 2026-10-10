# DeepSeek Harness 部署

`target_cli` 含 `dsh` 时，由 SKILL.md Phase 2 完整读取本文件并按顺序执行。路径安全检查、幂等重跑、清理自嵌套残留、部署标记、模板占位符、AGENTS.md 合并策略和安装报告的写法在 SKILL.md，这里只写 DeepSeek Harness 专属部分。

## 这一路跟 generic 的区别

generic 只往项目里放 `skills/` 和 `AGENTS.md`，没有运行时拦截、没有多 agent 分工。DeepSeek Harness 一样都不缺，所以 dsh 不走 generic：

- **运行时拦截走原生插件。** Harness 自带 `@deepseek-ai/dsh-hooks-claude-code` 与 `@deepseek-ai/dsh-hooks-codex` 两个兼容桥，它们只支持 SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop，**不支持 PreCompact、PostCompact、SessionEnd**，而且一个进程只认一份配置。所以本路不用兼容桥，改用本仓库的 `dsh-oh-story` 原生插件，把六个时机一次接齐：`agent/created`（会话开始注入）、`tools/pre-execute`（写前拦截）、`tools/post-execute`（写后检查）、`agent/turn-stopping`（收尾提醒）、`session/event`（嗅探 compaction）、`agent/pre-step`（压缩后重注）。
- **多 agent 走 subagent + 剧本。** Harness 没有“按名字 spawn 的自定义 agent”注册表，7 个角色以剧本文件随项目部署，插件把名册注入上下文，写作流程用 `subagent` 工具带上剧本 spawn。
- **skills 放项目级。** Harness 的技能发现顺序是 `<项目>/.dsh/skills`（100）→ `<项目>/.agents/skills`（200）→ 自定义目录（300）→ `<DSH_HOME>/skills`（400）→ 用户 agent 目录（500）→ 内置（600），数字小的赢。放项目级只有该项目看得见；放 `~/.agents/skills` 会让**所有会话**的技能目录里都出现这 13 个名字，每轮都要吃一点上下文。

## 部署清单（机械可检查）

`$DSH_HOME` 通常就是 `~/.dsh`；`<profile>` 是当前在用的 profile 名（桌面版一般是 `desktop`，命令行 web 版一般是 `web`）。

| Source path | Target path | Owner class | Merge mode | Validation check |
|-------------|-------------|-------------|------------|------------------|
| `skills/story-setup/references/templates/hooks/` | `$DSH_HOME/oh-story/hooks/` | story-setup managed | replace | `story_hook_core.js`、`story_hook_cli.js`、`lib/common.sh` 存在 |
| `skills/story-setup/references/dsh/plugin/` | `$DSH_HOME/oh-story/plugin/`（随后装进 profile） | story-setup managed | replace | `index.js`、`package.json`、`cordis.patch.yml` 存在 |
| `$DSH_HOME/oh-story/plugin`（本地目录） | profile 依赖 | profile managed | `dsh plugin --profile <profile> add` | `node_modules/dsh-oh-story/index.js` 存在 |
| （无 source，写配置） | `$DSH_HOME/profiles/<profile>/cordis.patch.yml` | user+managed | marker/section merge | 含 `id: oh-story` 的 insert 条目，`config.hooksDir` 指向部署后的 hooks |
| `skills/story-setup/references/dsh/AGENTS.md.tmpl` | `<项目>/AGENTS.md` | user+managed | marker/section merge | 含 dsh story skill routing sections |
| `skills/story-setup/references/templates/agents/*.md` | `<项目>/.oh-story/agents/` | story-setup managed | replace known names | 7 个角色剧本齐全 |
| `skills/story-setup/references/templates/rules/*.md` | `<项目>/.oh-story/rules/` | story-setup managed | replace known names | 4 份规则齐全 |
| 仓库 `skills/{browser-cdp,story*}/` | `<项目>/.dsh/skills/{browser-cdp,story*}/` | story-setup managed for known skill names | replace known skill dirs only | 13 个 `SKILL.md` 存在 |

## 部署算法

1. **定 profile。** 列 `$DSH_HOME/profiles/` 下的目录，问作者现在用的是哪个（桌面版通常是 `desktop`）。定不下来就用一句白话问“你现在是在桌面版还是命令行 web 版里用 dsh”。
2. **铺基础设施。** 把 `templates/hooks/` 整份复制到 `$DSH_HOME/oh-story/hooks/`，把 `references/dsh/plugin/` 整份复制到 `$DSH_HOME/oh-story/plugin/`。这两处是进程级共享的，**不按项目铺**，因为 Harness 的插件加载与配置读取都是进程级的。
3. **装插件。** 在 profile 里装本地包：
   ```bash
   dsh plugin --profile <profile> add "$DSH_HOME/oh-story/plugin"
   ```
   装不动时（例如离线、pnpm 不可用）退回按绝对路径挂载：`cordis.patch.yml` 里 `name` 写 `file:///<绝对路径>/index.js`。**Windows 上必须用 `file://` URL，裸的 `C:/…` 会让 ESM 加载器报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。**
4. **写配置。** 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 里合并一条 insert（已有同 id 条目就只替换 config）：
   ```yaml
   - insert:
       - id: oh-story
         name: dsh-oh-story
         config:
           hooksDir: '<$DSH_HOME 的绝对路径，用正斜杠>/oh-story/hooks'
           rosterDir: '.oh-story/agents'
   ```
   `hooksDir` 必须指向第 2 步铺好的 hooks 目录，插件加载时会检查 `story_hook_core.js` 在不在，不在就直接报错。
5. **铺项目。** 在写作项目根：
   - 合并 `references/dsh/AGENTS.md.tmpl` 到 `<项目>/AGENTS.md`；
   - 复制 7 个角色剧本到 `<项目>/.oh-story/agents/`；
   - 复制 4 份规则到 `<项目>/.oh-story/rules/`；
   - 复制 13 个 skill 目录到 `<项目>/.dsh/skills/`；
   - 写 `.story-deployed`（字段见 SKILL.md Phase 2 Step 2，`target_cli` 写 `dsh`，`references_dir` 写 `.dsh/skills/story-setup/references/agent-references`）。
6. **清用户级残留。** 如果作者先前用过 `npx skills add … -g`，`~/.agents/skills/` 下会留一份同名 skill。问作者要不要撤掉：留着的话所有会话的技能目录都会列出这 13 个名字；撤掉只有本项目看得见。撤的时候只删这 13 个目录，别动同目录下其它 skill。

## 验证

- `$DSH_HOME/oh-story/hooks/story_hook_core.js` 存在且可解析。
- profile 的 `node_modules/dsh-oh-story/index.js` 存在；`cordis.patch.yml` 里 `id: oh-story` 的条目存在且 `hooksDir` 指向真实目录。
- `<项目>/.dsh/skills/` 下 13 个 `SKILL.md` 可读；`<项目>/.oh-story/agents/` 下 7 个剧本齐全。
- `<项目>/AGENTS.md` 含 dsh story skill routing sections。
- 插件自检（不需要起 Harness，可直接跑）：
  ```bash
  cd $DSH_HOME/oh-story/plugin && node --test test/
  ```
  8 条断言覆盖“非写作项目完全静默”“缺细纲拦下”“追踪状态缺失拦下”“齐了放行”“写后回灌”“会话开始注入”，全绿才算铺对。
- **生效条件**：插件与 profile 依赖是启动期读的，装完要**重启 DSH**；只改 `cordis.patch.yml` 的话由 profile 的 patch 热重载接管。

## 安装报告必须提示

- 装完要**重启 DeepSeek Harness**，不然插件不加载。
- 插件挂在 profile 上，**该 profile 的所有会话都会加载它**；非写作项目自动静默，但作者要知道它不是按项目加载的。
- 压缩前后在 Harness 里不是一对真事件，插件是从会话事件流里嗅探 `compaction/*` 再在下一步重注，属于兜底。
- 7 个角色不是 Harness 原生的自定义 agent，是剧本 + `subagent` 工具分工；`story-review` 的多视角审查按 solo/direct 执行。
- skills 放项目级只有这个项目看得见；`~/.agents/skills` 里若还有一份，所有会话都看得见，建议撤掉。
