import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import type { CodingNsSettings } from '../shared/contracts/config.js'
import { debugInfo, debugWarn } from '../shared/debug.js'
import type { CodingNsRpcClient } from './features/types.js'
import type { CodingNsSettingsSnapshot, CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'

type SettingsMutation = Parameters<SettingsScope<CodingNsSettings>['mutate']>[0]
type SnapshotListener = () => void

interface RemoteSettingsResponse {
  readonly value: CodingNsSettings
  readonly revision: number
}

/**
 * 把 DSH 本地设置和远程 Host 设置 RPC 统一成一个设置作用域。
 * 非回环页面使用 RPC，回环页面完全复用 DSH 的原生设置传输。
 */
export class CodingNsSettingsBridge implements CodingNsSettingsStore<CodingNsSettings> {
  private snapshot: CodingNsSettingsSnapshot<CodingNsSettings>
  private readonly listeners = new Set<SnapshotListener>()
  private readonly localUnsubscribe: () => void
  private remoteLoad: Promise<void> | undefined
  private remoteLoaded = false

  constructor(
    private readonly local: SettingsScope<CodingNsSettings>,
    private readonly rpc: CodingNsRpcClient,
  ) {
    this.snapshot = toStoreSnapshot(local.getSnapshot())
    this.localUnsubscribe = local.subscribe(() => {
      if (this.isRemote()) {
        void this.load().catch(() => undefined)
        return
      }
      this.remoteLoaded = false
      this.publish(toStoreSnapshot(local.getSnapshot()))
    })
  }

  getSnapshot(): CodingNsSettingsSnapshot<CodingNsSettings> { return this.snapshot }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async load(): Promise<void> {
    if (!this.isRemote()) return
    if (this.remoteLoaded) return
    if (this.remoteLoad !== undefined) return this.remoteLoad
    debugInfo('codingns4dsh: client settings load begin')
    this.remoteLoad = this.call<RemoteSettingsResponse>('settings/get', {}).then((response) => {
      this.remoteLoaded = true
      this.publish({
        status: 'ready',
        value: response.value,
        revision: response.revision,
        writable: true,
      })
      debugInfo('codingns4dsh: client settings load success', { revision: response.revision })
    }).finally(() => {
      this.remoteLoad = undefined
    })
    return this.remoteLoad
  }

  async set(field: string, value: unknown): Promise<boolean> {
    if (!this.isRemote()) {
      await this.local.set(field, value)
      return true
    }
    return this.mutate([{ op: 'set', path: [field], value: toJsonValue(value) }])
  }

  async unset(field: string): Promise<boolean> {
    if (!this.isRemote()) {
      await this.local.unset(field)
      return true
    }
    return this.mutate([{ op: 'unset', path: [field] }])
  }

  async mutate(ops: SettingsMutation, expectedRevision?: number): Promise<boolean> {
    if (!this.isRemote()) {
      await this.local.mutate(ops, expectedRevision)
      return true
    }
    const payload = expectedRevision === undefined ? { ops } : { ops, expectedRevision }
    const response = await this.call<RemoteSettingsResponse>('settings/set', payload)
    this.remoteLoaded = true
    this.publish({
      ...this.snapshot,
      status: 'ready',
      value: response.value,
      revision: response.revision,
      writable: true,
    })
    return true
  }

  dispose(): void { this.localUnsubscribe() }

  private async call<T>(endpoint: string, payload: unknown): Promise<T> {
    let result
    try {
      debugInfo('codingns4dsh: client rpc request', { channel: CODINGNS_RPC_CHANNEL, endpoint })
      result = await this.rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload)
    } catch (error) {
      // DSH 原生连接通常把自定义 RPC 映射到 /api；保留逻辑通道兼容
      // Codingns4DSH Transport，同时在普通 Web Host 上回退到实际 Fetch 路由。
      const message = error instanceof Error ? error.message : String(error)
      if (!/HTTP (?:404|405)\b/u.test(message)) throw error
      debugWarn('codingns4dsh: client rpc fallback', { endpoint, error: message })
      try {
        result = await this.rpc.call('/api', `codingns/${endpoint}`, payload)
      } catch (fallbackError) {
        console.error('codingns4dsh: client rpc fallback failed', { endpoint, error: fallbackError })
        throw fallbackError
      }
    }
    if (!result.ok) {
      console.error('codingns4dsh: client rpc response error', { endpoint, error: result.error })
      throw new Error(result.error.message)
    }
    debugInfo('codingns4dsh: client rpc response success', { endpoint })
    return result.value as T
  }

  private publish(next: CodingNsSettingsSnapshot<CodingNsSettings>): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private isRemote(): boolean {
    const snapshot = this.local.getSnapshot()
    return snapshot.mode === 'memory' || snapshot.status === 'unavailable'
  }
}

type JsonValue = Extract<SettingsMutation[number], { readonly op: 'set' }>['value']

/** 设置 RPC 只能传 JSON；在浏览器边界尽早拒绝函数、循环引用等无效值。 */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(toJsonValue)
  if (typeof value !== 'object') throw new TypeError('设置值必须是可序列化的 JSON')
  const result: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(value)) result[key] = toJsonValue(entry)
  return result
}

export function createCodingNsSettingsBridge(
  local: SettingsScope<CodingNsSettings>,
  rpc: CodingNsRpcClient,
): CodingNsSettingsBridge {
  return new CodingNsSettingsBridge(local, rpc)
}

function toStoreSnapshot(snapshot: {
  readonly value: CodingNsSettings | undefined
  readonly revision: number | undefined
  readonly writable: boolean
  readonly status: 'loading' | 'ready' | 'unavailable'
}): CodingNsSettingsSnapshot<CodingNsSettings> {
  return { value: snapshot.value, revision: snapshot.revision, writable: snapshot.writable, status: snapshot.status }
}
