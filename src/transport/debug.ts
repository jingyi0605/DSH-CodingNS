import { resolveCodingNsDebugEnabled } from '../shared/debug.js'

/**
 * DSH Tunnel 调试日志。
 *
 * 日志只接受调用方明确传入的协议元数据，禁止把 Envelope body、票据、Cookie
 * 或本地 Web 响应正文交给这个模块。默认关闭，生产环境不会产生额外输出。
 */

export type DshTransportDebugSide = 'h5' | 'host' | 'relay' | 'unknown'

export interface DshTransportDebugLogger {
  readonly enabled: boolean
  log(event: string, fields?: Readonly<Record<string, unknown>>): void
}

export interface DshTransportDebugOptions {
  readonly enabled?: boolean
  readonly side?: DshTransportDebugSide
  readonly component?: string
  readonly sink?: (record: Readonly<Record<string, unknown>>) => void
}

/** 创建一个可注入测试 sink 的调试 logger。默认开关由当前运行环境决定。 */
export function createDshTransportDebugLogger(options: DshTransportDebugOptions = {}): DshTransportDebugLogger {
  const enabled = options.enabled ?? resolveDshTransportDebugEnabled()
  const side = options.side ?? 'unknown'
  const component = options.component ?? 'transport'
  const sink = options.sink ?? ((record) => {
    // console.info 在 Node 和浏览器中都能稳定显示，并且不会把正文拼进字符串。
    console.info('[codingns4dsh:tunnel]', record)
  })
  return {
    enabled,
    log(event, fields = {}) {
      if (!enabled) return
      sink({
        at: new Date().toISOString(),
        side,
        component,
        event,
        ...fields,
      })
    },
  }
}

/** 解析统一的 Codingns4DSH 调试开关，保留旧隧道变量作为兼容别名。 */
export function resolveDshTransportDebugEnabled(): boolean {
  return resolveCodingNsDebugEnabled()
}
