import type { CodingNsSettings } from '../../shared/contracts/config.js'
import { accepted, type CodingNsSettingsStore } from '../settings-store.js'

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
      const result = await accepted(form.mutate(operations, revision))
      refresh()
      return result
    },
    set: async (field, value) => {
      const result = await accepted(form.set(field, value))
      refresh()
      return result
    },
    unset: async (field) => {
      const result = await accepted(form.unset(field))
      refresh()
      return result
    },
    dispose: () => {
      unsubscribeForm()
      listeners.clear()
    },
  }
}

function toStoreSnapshot(snapshot: ReturnType<DshConfigForm<CodingNsSettings>['getSnapshot']>) {
  return {
    value: snapshot.value,
    revision: snapshot.revision,
    writable: snapshot.writable,
    status: snapshot.status ?? 'ready' as const,
  }
}

function sameSnapshot(left: ReturnType<typeof toStoreSnapshot>, right: ReturnType<typeof toStoreSnapshot>): boolean {
  return left.value === right.value
    && left.revision === right.revision
    && left.writable === right.writable
    && left.status === right.status
}
