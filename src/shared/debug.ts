/**
 * Codingns4DSH 调试日志开关。
 *
 * 调试输出默认关闭。需要查看启动或 RPC 追踪时，使用
 * `CODINGNS4DSH_DEBUG=1 dsh ...` 启动 DSH；浏览器侧同时支持 `?dshDebug=1`。
 */
export const CODINGNS4DSH_DEBUG_ENV = 'CODINGNS4DSH_DEBUG'

const LEGACY_DEBUG_ENV = 'CODINGNS4DSH_TUNNEL_DEBUG'

/** 当前运行环境是否明确要求输出调试日志。 */
export function resolveCodingNsDebugEnabled(): boolean {
  const globals = globalThis as typeof globalThis & {
    __CODINGNS4DSH_DEBUG_ENABLED__?: unknown
    __CODINGNS4DSH_TUNNEL_DEBUG__?: unknown
  }
  const globalValue = globals.__CODINGNS4DSH_DEBUG_ENABLED__ ?? globals.__CODINGNS4DSH_TUNNEL_DEBUG__
  if (globalValue !== undefined) return parseDebugValue(globalValue)

  if (typeof location !== 'undefined') {
    const queryValue = new URL(location.href).searchParams.get('dshDebug')
    if (queryValue !== null) return parseDebugValue(queryValue)
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const stored = localStorage.getItem('codingns4dsh-debug')
        ?? localStorage.getItem('codingns4dsh-tunnel-debug')
      if (stored !== null) return parseDebugValue(stored)
    } catch {
      // 隐私模式或受限 iframe 可能禁止读取 localStorage，继续检查进程环境变量。
    }
  }

  if (typeof process !== 'undefined') {
    return parseDebugValue(process.env[CODINGNS4DSH_DEBUG_ENV] ?? process.env[LEGACY_DEBUG_ENV])
  }
  return false
}

/** 输出受统一开关控制的调试信息。 */
export function debugInfo(message: unknown, ...args: unknown[]): void {
  if (resolveCodingNsDebugEnabled()) console.info(message, ...args)
}

/** 输出受统一开关控制的调试警告。 */
export function debugWarn(message: unknown, ...args: unknown[]): void {
  if (resolveCodingNsDebugEnabled()) console.warn(message, ...args)
}

function parseDebugValue(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return false
  return /^(1|true|yes|on)$/iu.test(value.trim())
}
