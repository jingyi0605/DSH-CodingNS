import {
  assertSupportedDshVersion,
  CODINGNS_DSH_ERROR_CODES,
  CODINGNS_DSH_VERSION_GLOBAL,
  CodingNsDshError,
} from '../shared/index.js'
import type { Context } from '@deepseek-ai/cordis'

type DshVersionGlobal = typeof globalThis & {
  [CODINGNS_DSH_VERSION_GLOBAL]?: unknown
}

/**
 * 读取 Host 注入的真实 DSH 版本，并在无法读取时拒绝启用 Client。
 *
 * DSH 0.1.7 的设置服务迁移会让旧 Host 启动页注入钩子无法执行；此时
 * `configForms` 是新版 Client 唯一可靠的运行时标志，使用其最低现代版本
 * 作为能力路由版本，避免因为旧注入链失败而误判整个 Client 不兼容。
 */
export function assertInjectedDshVersion(ctx?: Context): string {
  const value = (globalThis as DshVersionGlobal)[CODINGNS_DSH_VERSION_GLOBAL]
  if (typeof value !== 'string' || value.trim() === '') {
    if (hasModernConfigForms(ctx)) {
      const modernVersion = '0.1.7-rc.2'
      assertSupportedDshVersion(modernVersion)
      return modernVersion
    }
    throw new CodingNsDshError(
      CODINGNS_DSH_ERROR_CODES.DSH_VERSION_UNSUPPORTED,
      '无法读取当前 DSH 版本；为避免 Client API 不兼容，已拒绝启用 codingns4dsh',
    )
  }
  assertSupportedDshVersion(value)
  return value
}

function hasModernConfigForms(ctx: Context | undefined): boolean {
  if (ctx === undefined) return false
  try {
    const forms = ctx.get('configForms') as { readonly get?: unknown } | undefined
    return typeof forms?.get === 'function'
  } catch {
    return false
  }
}
