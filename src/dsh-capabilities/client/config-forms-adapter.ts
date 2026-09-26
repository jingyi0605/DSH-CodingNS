import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { accepted, type CodingNsSettingsStore } from '../settings-store.js'
import { debugInfo, debugWarn } from '../../shared/debug.js'

/** 0.1.7 Client ConfigForm 的最小结构化边界。 */
export interface DshConfigForm<T> {
  getSnapshot(): { readonly value: T | undefined; readonly revision?: number; readonly writable: boolean; readonly status?: 'loading' | 'ready' | 'unavailable' }
  subscribe(listener: () => void): () => void
  mutate(operations: readonly { readonly op: 'set' | 'unset'; readonly path: readonly string[]; readonly value?: unknown }[], expectedRevision?: number): Promise<void | boolean>
  set(field: string, value: unknown): Promise<void | boolean>
  unset(field: string): Promise<void | boolean>
}

export interface DshClientConfigForms {
  get<T>(namespace: string): DshConfigForm<T> | undefined
}

/** 0.1.7 Client ConfigForm 路由适配器。 */
export function createConfigFormSettingsStore(
  forms: DshClientConfigForms,
  namespace: string,
): CodingNsSettingsStore<CodingNsSettings> {
  const form = forms.get<CodingNsSettings>(namespace)
  if (form === undefined) {
    return {
      getSnapshot: () => ({ value: undefined, revision: undefined, writable: false, status: 'unavailable' }),
      subscribe: () => () => undefined,
      mutate: async () => false,
      set: async () => false,
      unset: async () => false,
    }
  }
  let snapshot = toStoreSnapshot(form.getSnapshot())
  const listeners = new Set<() => void>()
  const refresh = (): void => {
    const next = toStoreSnapshot(form.getSnapshot())
    if (sameSnapshot(snapshot, next)) return
    snapshot = next
    for (const listener of [...listeners]) listener()
  }
  const unsubscribeForm = form.subscribe(refresh)
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    mutate: async (operations, revision) => {
      const result = await writeWithRetry(
        () => form.mutate(operations, revision),
        () => form.mutate(operations),
      )
      refresh()
      return result
    },
    set: async (field, value) => {
      const result = await writeWithRetry(
        () => form.set(field, value),
        () => form.set(field, value),
      )
      refresh()
      return result
    },
    unset: async (field) => {
      const result = await writeWithRetry(
        () => form.unset(field),
        () => form.unset(field),
      )
      refresh()
      return result
    },
    dispose: () => {
      unsubscribeForm()
      listeners.clear()
    },
  }
}

/**
 * ConfigForm 在 revision 过期时会返回 false，并先异步恢复 Host 快照。
 * 设置页的编辑器不会感知这次恢复，因此立刻重试一次最新 revision，避免
 * 用户看到控件可以操作却始终回弹到旧值。只重试一次，真正的拒绝仍然返回
 * false，调用方可以显示明确错误。
 */
async function writeWithRetry(
  first: () => Promise<void | boolean>,
  retry: () => Promise<void | boolean>,
): Promise<boolean> {
  const result = await accepted(first())
  if (result) return true
  debugWarn('codingns4dsh: client config form write rejected; retrying with latest revision')
  const retried = await accepted(retry())
  debugInfo('codingns4dsh: client config form write retry completed', { accepted: retried })
  return retried
}

function toStoreSnapshot(snapshot: ReturnType<DshConfigForm<CodingNsSettings>['getSnapshot']>) {
  const value = snapshot.value === undefined
    ? undefined
    : (({ cliSessions: _cliSessions, ...clientValue }) => clientValue)(snapshot.value)
  return {
    value: value as CodingNsSettings | undefined,
    revision: snapshot.revision,
    writable: snapshot.writable,
    status: snapshot.status ?? 'ready' as const,
  }
}

function sameSnapshot(left: ReturnType<typeof toStoreSnapshot>, right: ReturnType<typeof toStoreSnapshot>): boolean {
  return sameConfigValue(left.value, right.value)
    && left.revision === right.revision
    && left.writable === right.writable
    && left.status === right.status
}

/** ConfigForm 可能在每次读取时返回新对象；按配置内容比较，避免无意义地唤醒所有消费者。 */
function sameConfigValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((value, index) => sameConfigValue(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(rightRecord, key) && sameConfigValue(leftRecord[key], rightRecord[key]))
}
