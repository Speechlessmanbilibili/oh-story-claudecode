import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件元数据。 */
export const name: 'oh-story'
/** 需要的工作目录服务。 */
export const inject: string[]
/** 默认项目标记文件名。 */
export const DEFAULT_PROJECT_MARKER: '.story-deployed'
/** 注入上下文的来源名。 */
export const CONTEXT_SECTION: 'oh-story'

/** 复刻官方的 `createUserMessage`，避免运行时依赖。 */
export function createUserMessage(input: { content: unknown[]; source: unknown }): object

/** 归一化并校验插件配置。 */
export function normalizeConfig(raw: unknown): {
  hooksDir: string
  projectMarker: string
  contextMaxChars: number
  blockOnPostWrite: boolean
  steerOnGaps: boolean
  rosterDir: string | null
  maxRootWalk: number
}

/** 从起始目录向上找带项目标记的目录。 */
export function walkToRoot(startDir: string, marker: string, maxWalk: number): string | null

/** 插件入口。 */
export function apply(ctx: Context, rawConfig: unknown): void

declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply }
export default plugin
