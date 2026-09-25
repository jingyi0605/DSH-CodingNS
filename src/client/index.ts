/**
 * DSH Client 入口。
 *
 * 该文件只使用浏览器安全的 TypeScript/JavaScript。Client 侧能力全部以功能模块
 * 形式交给 FeatureRegistry 管理：设置页遍历注册表渲染卡片，设置里的启用开关
 * 驱动模块 start/disable 与资源清理。入口只负责装配与依赖声明。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import './provider-icon-assets.js'
import { FeatureRegistry } from '../features/registry.js'
import { registerCodingNsLocale } from './locale.js'
import {
  CODINGNS_SETTINGS_NAMESPACE,
  captureRestartFeatureStates,
  enabledFeatureNames,
  type CodingNsSettings,
} from '../shared/contracts/config.js'
import { CLIENT_FEATURES } from './features/index.js'
import type { CodingNsClientFeatureModule, CodingNsClientServices, CodingNsRpcClient } from './features/types.js'
import { ensureCryptoRandomUUID } from './lan-access.js'
import { CodingNsSettingsSection } from './settings-section.js'
import { createCodingNsSettingsBridge } from './settings-bridge.js'
import { createConfigFormSettingsStore, type DshClientConfigForms, type DshConfigForm } from '../dsh-capabilities/client/config-forms-adapter.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import { CodingNsWebTerminals, registerCodingNsTerminalUi } from './terminal/index.js'
import type { TerminalRemote } from './terminal/model.js'
import { startCodingNsAccountBar } from './account-bar.js'
import { assertInjectedDshVersion } from './dsh-runtime-version.js'
import { createDshCapabilityRegistry } from '../dsh-capabilities/index.js'

export { ensureCryptoRandomUUID } from './lan-access.js'
export type {
  CryptoRandomUUIDInstallResult,
  LanAccessCrypto,
  LanAccessGlobal,
} from './lan-access.js'
export { CLIENT_FEATURES, settingsModules, startBrowserRelayConnection } from './features/index.js'
export { chooseDshDevice, createHttpDshH5ControlApi, startDshH5Bootstrap, startDshH5BrowserBootstrap } from './dsh-h5-bootstrap.js'
export type {
  DshH5BootstrapOptions,
  DshH5BootstrapResult,
  DshH5BrowserBootstrapOptions,
  DshH5BrowserBootstrapResult,
  DshH5BrowserControlApi,
} from './dsh-h5-bootstrap.js'
export { RemoteDshWebContext } from './remote-web-context.js'
export type { RemoteDshWebBoot, RemoteDshWebContextOptions } from './remote-web-context.js'
export type {
  CodingNsClientFeatureModule,
  CodingNsClientServices,
  CodingNsRpcClient,
  CodingNsRpcResult,
  FeaturePanelProps,
} from './features/index.js'
export { CodingNsSettingsSection } from './settings-section.js'
export {
  startWorkspaceSessionArchiveDom,
  WORKSPACE_SESSION_ARCHIVE_ATTRIBUTE,
  WORKSPACE_SESSION_ARCHIVE_MODAL_ATTRIBUTE,
} from './workspace-session-archive-dom.js'
export { CodingNsTerminalView, CodingNsWebTerminals, registerCodingNsTerminalUi } from './terminal/index.js'
export { registerSubscriptionSlot, registerCommandCodeSubscriptionSlot, CommandCodeSubscriptionSlot } from './subscription-slot.js'

/** Client Runner 用于等待服务就绪的 Cordis 依赖声明。 */
export const inject = ['slots', 'connection', 'remote', 'remote.workspace', 'remote.session', 'remote.terminal', 'sidebarRight', 'sidebarRightTabs', 'theme', 'locale', 'uiConversation'] as const

/**
 * 把 Codingns4DSH 设置页挂载到 DSH 设置左侧导航，并让模块开关驱动启停。
 *
 * 设置页与启停同步共享同一个注册表实例，所以界面上的模块清单就是运行时实际
 * 管理的模块清单，两者不会漂移。
 */
export function apply(ctx?: Context): void {
  if (ctx === undefined) return
  const dshVersion = assertInjectedDshVersion(ctx)
  // 版本门禁通过后才修改浏览器全局，避免不兼容 Client 留下半初始化状态。
  ensureCryptoRandomUUID()
  ctx.effect(() => registerCodingNsLocale(ctx), 'codingns4dsh: Client 词典')

  ctx.inject(['slots', 'connection', 'remote', 'remote.workspace', 'remote.session', 'remote.terminal', 'sidebarRight', 'sidebarRightTabs', 'theme', 'locale', 'uiConversation'], (settingsCtx) => {
    // Host 与 Client 共用同一个 cordis Context 类型，而 DSH 的 Host 侧声明会把
    // connection 收窄成 Host 句柄；浏览器侧按 ConnectionHandle 收窄回真实形状。
    const connection = settingsCtx.connection as unknown as ConnectionHandle
    const settings = createClientSettingsStore(settingsCtx, connection.rpc)
    // Typert manifest 可能晚于立即加载的 Client 入口完成登记，必须在每次调用时取 Remote。
    // DSH 0.1.7 的 ClientRemote 声明可能尚未包含插件按需挂载的 terminal 命名空间。
    // 运行时仍由 Typert manifest 提供该字段，因此在边界处按可选动态服务读取。
    const terminalRemote = (): TerminalRemote | undefined => (settingsCtx.remote as unknown as { readonly terminal?: TerminalRemote }).terminal
    const webTerminals = new CodingNsWebTerminals(settingsCtx, terminalRemote)
    const disposeTerminalUi = registerCodingNsTerminalUi(settingsCtx, webTerminals, settings)
    const services: CodingNsClientServices = {
      dshVersion,
      settings,
      rpc: connection.rpc,
      remote: settingsCtx.remote,
      slots: settingsCtx.slots,
      locale: settingsCtx.locale,
      uiConversation: settingsCtx.uiConversation,
      uiContext: settingsCtx,
    }
    const disposeAccountBar = startCodingNsAccountBar(connection.rpc, undefined, settings)
    const capabilityProfile = createDshCapabilityRegistry(dshVersion, 'client', settingsCtx).getProfile(settingsCtx)
    const registry = new FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>(services, capabilityProfile)
    registry.registerMany(CLIENT_FEATURES)
    registry.validate()
    const restartStates: Record<string, boolean> = {}
    let restartStatesCaptured = false

    settingsCtx.effect(() => {
      const sync = (): void => {
        const snapshot = settings.getSnapshot()
        if (!restartStatesCaptured && snapshot.status === 'ready') {
          Object.assign(restartStates, captureRestartFeatureStates(registry.descriptors(), snapshot.value, dshVersion))
          restartStatesCaptured = true
        }
        void registry
          .reconcile(enabledFeatureNames(registry.descriptors(), snapshot.value, restartStates, dshVersion))
          .catch((error: unknown) => {
            console.error('codingns4dsh: 功能模块状态同步失败', error)
          })
      }
      sync()
      const loading = settings.load?.()
      if (loading !== undefined) {
        void loading.catch((error: unknown) => {
          console.error('codingns4dsh: 远程设置读取失败', error)
        })
      }
      const unsubscribe = settings.subscribe(sync)
      return () => {
        unsubscribe()
        disposeTerminalUi()
        disposeAccountBar.dispose()
        void webTerminals.dispose()
        void settings.dispose?.()
      }
    }, 'codingns4dsh: 功能模块启停同步')

    settingsCtx.slots.inject('settings.section', () => settingsCtx.slots.register({
      name: 'settings.section',
      id: 'codingns',
      order: 30,
      label: 'Codingns4DSH',
      inject: () => ({ settings, registry, services, restartStates }),
    }, CodingNsSettingsSection))
  })
}

/** 在设置服务改名期间选择旧 Scope 或 0.1.7 ConfigForm，业务层只接收内部 Store。 */
function createClientSettingsStore(ctx: Context, rpc: CodingNsRpcClient): CodingNsSettingsStore<CodingNsSettings> {
  const scopeBinder = ctx.get('settingsScope') as { bind?: (spec: { readonly namespace: string }) => Parameters<typeof createCodingNsSettingsBridge>[0] } | undefined
  if (typeof scopeBinder?.bind === 'function') {
    const local = scopeBinder.bind({ namespace: CODINGNS_SETTINGS_NAMESPACE })
    return createCodingNsSettingsBridge(local, rpc)
  }

  const forms = ctx.get('configForms') as DshClientConfigForms | undefined
  const form = findConfigForm(forms)
  return createConfigFormSettingsStore({ get: <T>() => form as DshConfigForm<T> | undefined }, CODINGNS_SETTINGS_NAMESPACE)
}

function findConfigForm(forms: DshClientConfigForms | undefined): DshConfigForm<CodingNsSettings> | undefined {
  if (forms === undefined) return undefined
  for (const id of ['codingns4dsh', CODINGNS_SETTINGS_NAMESPACE]) {
    try {
      const form = forms.get<CodingNsSettings>(id)
      if (form !== undefined) return form
    } catch {
      // 不同 0.1.7 构建可能只接受其中一个 entry id，继续尝试别名。
    }
  }
  return undefined
}
