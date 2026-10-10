# dsh-oh-story

DeepSeek Harness（dsh）原生宿主适配插件。把 oh-story 的运行时时机接到 Harness 原生的拦截点上，不经过任何“兼容桥”，也不要求把 hook 写成 shell 脚本。

## 它接到哪些时机

| oh-story 的时机 | Harness 的接入点 | 行为 |
|---|---|---|
| SessionStart | `agent/created` | 注入活跃书目、续写状态卡（`追踪/上下文.md`）、连续性提醒、角色名册 |
| PreToolUse（写正文） | `tools/pre-execute` | 缺细纲、细纲为空、追踪检查点不成立 → `deny`，原因给模型看 |
| PreToolUse（git commit） | `tools/pre-execute` | 暂存区 markdown 校验不通过 → `deny` |
| PostToolUse（写完正文） | `tools/post-execute` | 跑写后网（AI 句式、截断、落盘字节数）→ 回灌结论 |
| Stop | `agent/turn-stopping` | 还有连续性欠账 → `steer` 续一轮 |
| PreCompact / PostCompact | `session/event` + `agent/pre-step` | 嗅探 `compaction/*`，下一步把续写状态卡补回上下文 |
| SessionEnd | 无需实现 | 追踪状态由 `追踪/` 下的文件承载，会话结束不需要额外落盘 |

## 为什么零运行时依赖

插件不 import 任何 `@deepseek-ai/*`。`createUserMessage` 按官方实现就地复刻：

```js
Object.freeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
```

这样插件既不受 profile 的 `node_modules` 形状影响，也不受 Harness 自身打包进 asar 之后的模块解析规则影响。判定逻辑全部来自 `story_hook_core.js`（与 claude-code / codex / opencode / zcode 各端同一份共享核），插件只做“Harness 事件 → 共享核调用 → Harness 决策”这一层薄适配。

## 非写作项目一定静默

Harness 的插件挂在 profile 上，会对**该 profile 的所有会话**加载。所以每个时机都先做门控：解析会话工作目录，向上最多 8 层找项目标记（默认 `.story-deployed`，另外把含 `追踪/` 或 `.active-book` 的目录也算写作项目）。找不到就直接 `next()`，不注入上下文、不拦工具、不产生任何副作用。

## 配置

插件包自带 bundle patch（`dsh.bundle.patch` → `cordis.patch.yml`），所以用 `dsh plugin --profile <profile> add <目录>` 装好、或把它加进 profile 的 `dsh.profile.bundles` 之后，它会以默认配置自己挂上。要改配置就走 **id 定向覆盖**，不要再 insert 一次（同一个 `oh-story` id insert 两次会撞）：

```yaml
- id: oh-story
  config:
    hooksDir: 'C:/Users/<你>/.dsh/oh-story/hooks'
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `hooksDir` | `$DSH_HOME/oh-story/hooks` | 部署后的 oh-story hooks 目录，必须含 `story_hook_core.js` |
| `projectMarker` | `.story-deployed` | 写作项目标记文件名 |
| `rosterDir` | `.oh-story/agents` | 角色剧本目录，相对项目根 |
| `contextMaxChars` | `8000` | 续写状态卡注入的字符上限，超出截断并提示读原文件 |
| `blockOnPostWrite` | `false` | 写后检查默认只回灌结论；设 `true` 改成阻断该次写入 |
| `steerOnGaps` | `true` | 回合收尾发现有连续性欠账时 `steer` 续一轮；设 `false` 只保留工具拦截 |

## 加载状态与排障

Harness 默认没有可见日志，插件「加载失败」和「加载成功但没命中」从外面看一模一样。所以插件每次装载都会落一份状态文件：

```json
{ "ok": true, "hooksDir": "C:/Users/<你>/.dsh/oh-story/hooks", "guardHits": 0, "pid": 1234, "at": "..." }
```

- 文件在且 `ok: true`：插件真的起来了。
- `ok: false` 带 `stage`：卡在哪一步（`normalizeConfig` 配置解析、`load-core` 共享核加载），`error` 是原始报错。
- 第一次真拦下一次写入时会再写一次，带 `guardHits` 与拦截原因，用来区分「起来了」和「在干活」。

状态文件写失败默认静默；排障时设 `OH_STORY_DEBUG=1` 让写入错误直接抛出来。

## 已知限制

- **压缩前后不是一对真事件。** Harness 只暴露 `compaction/summary-error` 与 `session/event` 流，插件从事件流里嗅探 `compaction/*` 再在下一步重注，属于兜底而非硬保证。
- **没有「按名字 spawn 的自定义 agent」注册表。** 7 个角色以剧本文件随项目部署，插件把名册注入上下文，由写作流程用 `subagent` 工具带上剧本 spawn；不是 Harness 原生 agent 类型。
- **不声明 `inject`。** 不依赖任何服务就激活，代价是工作目录要惰性解析；三级回落（工作目录服务 → session header → 进程 cwd）都拿不到时按非写作项目静默放行。
- **`Config` 未导出。** 插件不依赖 `@deepseek-ai/schemastery`，配置校验在 `normalizeConfig` 里做，缺字段一律落默认值而不是拒绝加载。