/**
 * DSH Client 入口。
 *
 * 该文件只使用浏览器安全的 TypeScript/JavaScript。Client 侧能力全部以功能模块
 * 形式交给 FeatureRegistry 管理：设置页遍历注册表渲染卡片，设置里的启用开关
 * 驱动模块 start/disable 与资源清理。入口只负责装配与依赖声明。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { TypertDisposer, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
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
import { debugInfo } from '../shared/debug.js'
import { createConfigFormSettingsStore, type DshClientConfigForms, type DshConfigForm } from '../dsh-capabilities/client/config-forms-adapter.js'
import type { CodingNsSettingsStore } from '../dsh-capabilities/settings-store.js'
import { CodingNsWebTerminals, registerCodingNsTerminalUi } from './terminal/index.js'
import type { TerminalRemote } from './terminal/model.js'
import { startCodingNsAccountBar } from './account-bar.js'
import { assertInjectedDshVersion } from './dsh-runtime-version.js'
import { createDshCapabilityRegistry } from '../dsh-capabilities/index.js'
import { TYPERT_REMOTE } from '../typert.remote-client.js'

export { ensureCryptoRandomUUID } from './lan-access.js'
export type {
  CryptoRandomUUIDInstallResult,
  LanAccessCrypto,
  LanAccessGlobal,
} from './lan-access.js'
export { CLIENT_FEATURES, settingsModules, startBrowserRelayConnection, gitManagementFeature } from './features/index.js'
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
export {
  startWorkspaceSessionVisibilityDom,
  WORKSPACE_SESSION_HIDDEN_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE,
} from './workspace-session-visibility-dom.js'
export { CodingNsTerminalView, CodingNsWebTerminals, registerCodingNsTerminalUi } from './terminal/index.js'
export { registerSubscriptionSlot, registerCommandCodeSubscriptionSlot, CommandCodeSubscriptionSlot } from './subscription-slot.js'

/** Client Runner 用于等待服务就绪的 Cordis 依赖声明。 */
export const inject = ['slots', 'connection', 'remote', 'remote.workspace', 'remote.session', 'sidebarRight', 'sidebarRightTabs', 'theme', 'locale', 'uiConversation'] as const

/**
 * 把 Codingns4DSH 设置页挂载到 DSH 设置左侧导航，并让模块开关驱动启停。
 *
 * 设置页与启停同步共享同一个注册表实例，所以界面上的模块清单就是运行时实际
 * 管理的模块清单，两者不会漂移。
 */
export function apply(ctx?: Context): void {
  if (ctx === undefined) return
  const dshVersion = assertInjectedDshVersion(ctx)
  debugInfo('codingns4dsh: client apply entered', { dshVersion })
  // 版本门禁通过后才修改浏览器全局，避免不兼容 Client 留下半初始化状态。
  ensureCryptoRandomUUID()
  ctx.effect(() => registerCodingNsLocale(ctx), 'codingns4dsh: Client 词典')

  ctx.inject(['slots', 'connection', 'remote', 'remote.workspace', 'remote.session', 'sidebarRight', 'sidebarRightTabs', 'theme', 'locale', 'uiConversation'], async (settingsCtx) => {
    debugInfo('codingns4dsh: client inject ready', {
      hasConnection: settingsCtx.connection !== undefined,
      hasRemote: settingsCtx.remote !== undefined,
      hasSlots: settingsCtx.slots !== undefined,
      hasSidebarRight: settingsCtx.sidebarRight !== undefined,
      hasSidebarRightTabs: settingsCtx.sidebarRightTabs !== undefined,
      hasTheme: settingsCtx.theme !== undefined,
      hasLocale: settingsCtx.locale !== undefined,
      hasUiConversation: settingsCtx.uiConversation !== undefined,
    })
    // Host 与 Client 共用同一个 cordis Context 类型，而 DSH 的 Host 侧声明会把
    // connection 收窄成 Host 句柄；浏览器侧按 ConnectionHandle 收窄回真实形状。
    const connection = settingsCtx.connection as unknown as ConnectionHandle
    const settings = createClientSettingsStore(settingsCtx, connection.rpc)
    debugInfo('codingns4dsh: client settings store ready')
    const disposeTerminalRemote = await ensureTerminalRemote(settingsCtx)
    // `remote` 是 Cordis 代理，读取嵌套命名空间必须在当前 Fiber 显式声明注入。
    // 独立注入避免把 DSH 0.1.7 自动提供的官方 `remote.terminal` 当成插件终端。
    let mountedTerminalRemote: TerminalRemote | undefined
    const terminalRemote = (): TerminalRemote | undefined => mountedTerminalRemote
    const webTerminals = new CodingNsWebTerminals(settingsCtx, terminalRemote)
    settingsCtx.inject(['remote.codingnsTerminal'], (terminalCtx) => {
      mountedTerminalRemote = terminalCtx.get('remote.codingnsTerminal') as TerminalRemote
      debugInfo('codingns4dsh: client terminal remote ready')
      webTerminals.remoteReady()
    })
    debugInfo('codingns4dsh: client terminal UI registration begin')
    const disposeTerminalUi = registerCodingNsTerminalUi(settingsCtx, webTerminals, settings)
    debugInfo('codingns4dsh: client terminal UI registration ready')
    const services: CodingNsClientServices = {
      dshVersion,
      settings,
      rpc: connection.rpc,
      remote: settingsCtx.remote,
      terminalRemote,
      slots: settingsCtx.slots,
      locale: settingsCtx.locale,
      uiConversation: settingsCtx.uiConversation,
      uiContext: settingsCtx,
    }
    debugInfo('codingns4dsh: client account bar registration begin')
    const disposeAccountBar = startCodingNsAccountBar(connection.rpc, undefined, settings)
    debugInfo('codingns4dsh: client account bar registration ready')
    const capabilityProfile = createDshCapabilityRegistry(dshVersion, 'client', settingsCtx).getProfile(settingsCtx)
    debugInfo('codingns4dsh: client capabilities resolved', {
      dshVersion,
      capabilities: [...capabilityProfile.capabilities.entries()].map(([capability, resolution]) => ({ capability, status: resolution.status, route: resolution.routeId, reason: resolution.reason ?? null })),
      diagnostics: capabilityProfile.diagnostics,
    })
    const registry = new FeatureRegistry<CodingNsClientServices, CodingNsClientFeatureModule>(services, capabilityProfile)
    registry.registerMany(CLIENT_FEATURES)
    registry.validate()
    debugInfo('codingns4dsh: client feature registry ready', { features: registry.descriptors().map((item) => item.name) })
    const restartStates: Record<string, boolean> = {}
    let restartStatesCaptured = false

    settingsCtx.effect(() => {
      const sync = (): void => {
        const snapshot = settings.getSnapshot()
        if (!restartStatesCaptured && snapshot.status === 'ready') {
          Object.assign(restartStates, captureRestartFeatureStates(registry.descriptors(), snapshot.value, dshVersion))
          restartStatesCaptured = true
        }
        const enabled = enabledFeatureNames(registry.descriptors(), snapshot.value, restartStates, dshVersion)
        debugInfo('codingns4dsh: client feature sync', {
          settingsStatus: snapshot.status,
          settingsRevision: snapshot.revision,
          enabled,
          states: registry.list(),
        })
        void registry
          .reconcile(enabled)
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
      return async () => {
        unsubscribe()
        await registry.reconcile([])
        disposeTerminalUi()
        await disposeAccountBar.dispose()
        await disposeTerminalRemote()
        await webTerminals.dispose()
        await settings.dispose?.()
      }
    }, 'codingns4dsh: 功能模块启停同步')

    try {
      debugInfo('codingns4dsh: client settings slot registration begin')
      settingsCtx.slots.inject('settings.section', () => {
        debugInfo('codingns4dsh: client settings slot injector invoked')
        return settingsCtx.slots.register({
          name: 'settings.section',
          id: 'codingns',
          order: 30,
          label: 'Codingns4DSH',
          inject: () => ({ settings, registry, services, restartStates }),
        }, CodingNsSettingsSection)
      })
      debugInfo('codingns4dsh: client settings slot registration requested')
    } catch (error) {
      console.error('codingns4dsh: client settings slot registration failed', error)
      throw error
    }
  })
}

/** 按需挂载 Codingns4DSH 自有 Remote 描述，不能复用 DSH 官方 terminal。 */
async function ensureTerminalRemote(ctx: Context): Promise<TypertDisposer> {
  // 这里只能读取已经声明的 `remote`。直接探测
  // `remote.codingnsTerminal` 会触发 Cordis 的 without-inject 错误；
  // Remote 贡献由当前 Client assembly 负责挂载，重复挂载由上层生命周期避免。
  const remote = ctx.get('remote') as {
    readonly $mount: (contribution: TypertRemoteContribution) => Promise<TypertDisposer>
  }
  const dispose = await remote.$mount(TYPERT_REMOTE)
  debugInfo('codingns4dsh: client terminal remote mounted')
  return dispose
}

/** 在设置服务改名期间选择旧 Scope 或 0.1.7 ConfigForm，业务层只接收内部 Store。 */
function createClientSettingsStore(ctx: Context, rpc: CodingNsRpcClient): CodingNsSettingsStore<CodingNsSettings> {
  const scopeBinder = ctx.get('settingsScope') as { bind?: (spec: { readonly namespace: string }) => Parameters<typeof createCodingNsSettingsBridge>[0] } | undefined
  if (typeof scopeBinder?.bind === 'function') {
    debugInfo('codingns4dsh: client settings source=settingsScope')
    const local = scopeBinder.bind({ namespace: CODINGNS_SETTINGS_NAMESPACE })
    return createCodingNsSettingsBridge(local, rpc)
  }

  const forms = ctx.get('configForms') as DshClientConfigForms | undefined
  const form = findConfigForm(forms)
  debugInfo('codingns4dsh: client settings source=configForms', { hasConfigForms: forms !== undefined, hasForm: form !== undefined })
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
