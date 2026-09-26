import { createElement, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitBranchSnapshot, GitChangeItem, GitHistoryItem, GitStatus } from '../shared/contracts/git.js'
import type { CodingNsClientFeatureModule, CodingNsRpcClient, CodingNsRpcResult } from './features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { dshThemeColor } from './theme.js'

export const GIT_PANEL_ID = 'codingns4dsh/git'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: { readonly size: number; readonly active: boolean } }
  }
}

type MainProps = PropsRuntime<'main'>
type GitServices = { readonly rpc: CodingNsRpcClient }

/** 注册左侧全局 Git 面板；主面板不绑定单个 Session，因此跨会话保持。 */
export function registerGitManagementUi(ctx: Context, services: GitServices): () => void {
  const disposers: Array<() => void> = []
  disposers.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: GIT_PANEL_ID, order: 45, label: 'Git',
  }, GitPanelIcon)))
  disposers.push(ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: GIT_PANEL_ID,
  }, createGitPanel(services))))
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function GitPanelIcon({ active }: { readonly active: boolean }): ReactElement {
  return createElement('span', {
    title: 'Git 仓库管理', 'aria-label': 'Git 仓库管理', style: { display: 'inline-flex', width: 22, height: 22, alignItems: 'center', justifyContent: 'center', color: active ? dshThemeColor.accent : dshThemeColor.labelSecondary, fontSize: 15, fontWeight: 700 },
  }, '⑂')
}

function createGitPanel(services: GitServices): (props: MainProps) => ReactElement {
  return (props) => createElement(GitPanel, { ...props, ...services })
}

function GitPanel(props: MainProps & GitServices): ReactElement {
  const useSessions = (props as unknown as { useSessions?: (selector: (state: unknown) => unknown) => unknown }).useSessions
  const useWorkspaces = (props as unknown as { useWorkspaces?: (selector: (state: unknown) => unknown) => unknown }).useWorkspaces
  const currentSessionId = typeof useSessions === 'function'
    ? useSessions((state) => findCurrentSessionId(state)) as string | undefined
    : undefined
  const workspaceItems = typeof useWorkspaces === 'function'
    ? useWorkspaces((state) => readWorkspaceItems(state)) as readonly WorkspaceItem[]
    : []
  const workspaceId = useMemo(() => resolveWorkspaceId(currentSessionId, workspaceItems), [currentSessionId, workspaceItems])
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [history, setHistory] = useState<readonly GitHistoryItem[]>([])
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    let disposed = false
    setMessage('')
    setStatus(null)
    setHistory([])
    setBranches(null)
    if (workspaceId === undefined) {
      setMessage('当前没有可用的工作区')
      return () => { disposed = true }
    }
    const cached = readCache(workspaceId)
    if (cached !== null) { setStatus(cached.status); setHistory(cached.history); setBranches(cached.branches) }
    const load = async (): Promise<void> => {
      try {
        const nextStatus = await call<GitStatus>(props.rpc, 'git/status', { workspaceId })
        if (disposed) return
        if (nextStatus.snapshot.enabled === false) {
          setStatus(nextStatus); setHistory([]); setBranches(null); writeCache(workspaceId, { status: nextStatus, history: [], branches: null }); setMessage('')
          return
        }
        const [nextHistory, nextBranches] = await Promise.all([
          call<{ items: readonly GitHistoryItem[] }>(props.rpc, 'git/history', { workspaceId, limit: 20 }),
          call<GitBranchSnapshot>(props.rpc, 'git/branches', { workspaceId }),
        ])
        if (disposed) return
        setStatus(nextStatus); setHistory(nextHistory.items); setBranches(nextBranches); writeCache(workspaceId, { status: nextStatus, history: nextHistory.items, branches: nextBranches })
        setMessage('')
      } catch (error) {
        if (!disposed) setMessage(error instanceof Error ? error.message : String(error))
      }
    }
    void load()
    const timer = globalThis.setInterval(() => { void load() }, 5_000)
    return () => { disposed = true; globalThis.clearInterval(timer) }
  }, [props.rpc, workspaceId])

  const run = async (action: string, payload: Record<string, unknown>, onSuccess?: (value: unknown) => void): Promise<void> => {
    setBusy(true); setMessage('')
    if (workspaceId === undefined) { setMessage('当前没有可用的工作区'); setBusy(false); return }
    const targetWorkspaceId = workspaceId
    try {
      const value = await call(props.rpc, action, { workspaceId: targetWorkspaceId, ...payload })
      onSuccess?.(value)
      const nextStatus = await call<GitStatus>(props.rpc, 'git/status', { workspaceId: targetWorkspaceId })
      setStatus(nextStatus)
      if (nextStatus.snapshot.enabled !== false) {
        const [nextHistory, nextBranches] = await Promise.all([
          call<{ items: readonly GitHistoryItem[] }>(props.rpc, 'git/history', { workspaceId: targetWorkspaceId, limit: 20 }),
          call<GitBranchSnapshot>(props.rpc, 'git/branches', { workspaceId: targetWorkspaceId }),
        ])
        setHistory(nextHistory.items); setBranches(nextBranches); writeCache(targetWorkspaceId, { status: nextStatus, history: nextHistory.items, branches: nextBranches })
      } else {
        setHistory([]); setBranches(null); writeCache(targetWorkspaceId, { status: nextStatus, history: [], branches: null })
      }
      setMessage('操作已完成')
    }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const commit = (): void => {
    const value = subject.trim()
    if (!value) { setMessage('请输入提交说明'); return }
    void run('git/commit', { subject: value }, () => setSubject(''))
  }
  const copyCommitHash = (commitHash: string): void => {
    void copyText(commitHash).then((copied) => setMessage(copied ? 'Git 版本号已复制' : '当前环境不支持复制'))
  }
  const changes = status?.changes ?? []
  const staged = changes.filter((item) => item.staged)
  const unstaged = changes.filter((item) => !item.staged)
  return createElement('section', { style: panelStyle, 'data-git-management-panel': 'true' },
    createElement('header', { style: headerStyle },
      createElement('div', { style: { minWidth: 0 } }, createElement('h1', { style: titleStyle }, 'Git'), createElement('div', { style: branchStyle, title: status?.snapshot.repoRoot }, status?.snapshot.branch ?? '读取中')),
      createElement('button', { type: 'button', disabled: busy || workspaceId === undefined, onClick: () => void run('git/status', {}, (value) => setStatus(value as GitStatus)), style: quietButtonStyle, title: '刷新 Git 状态' }, '↻'),
    ),
    message ? createElement('div', { role: 'status', style: messageStyle }, message) : null,
    status === null && !message ? createElement('div', { style: emptyStyle }, '正在读取 Git 状态…') : null,
    status !== null && status.snapshot.enabled === false ? createElement('section', { style: sectionStyle },
      createElement('strong', undefined, '当前目录还没有 Git 仓库'),
      createElement('div', { style: mutedStyle }, '初始化后即可查看改动、提交和版本历史。'),
      createElement('button', { type: 'button', disabled: busy, onClick: () => void run('git/init', {}), style: primaryButtonStyle }, '初始化 Git'),
    ) : null,
    status !== null ? createElement('div', { style: summaryStyle }, `${staged.length} 个已暂存 · ${unstaged.length} 个未暂存 · ${history.length} 条提交`) : null,
    status !== null && status.snapshot.enabled !== false ? createElement('section', { style: sectionStyle },
      createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, '提交'), createElement('button', { type: 'button', disabled: busy || staged.length === 0, onClick: commit, style: primaryButtonStyle }, '提交')),
      createElement('textarea', { value: subject, disabled: busy || workspaceId === undefined, onChange: (event: { currentTarget: { value: string } }) => setSubject(event.currentTarget.value), placeholder: '提交说明', rows: 2, style: subjectStyle }),
    ) : null,
    status !== null && status.snapshot.enabled !== false ? createElement(ChangeSection, { title: '暂存文件', items: staged, busy, onAction: (action, path) => void run(`git/${action}`, { targets: [path] }) }) : null,
    status !== null && status.snapshot.enabled !== false ? createElement(ChangeSection, { title: '未提交文件', items: unstaged, busy, onAction: (action, path) => void run(`git/${action}`, { targets: [path] }) }) : null,
    status !== null && status.snapshot.enabled !== false ? createElement(HistorySection, { history, branches, busy, onSwitch: (branchName) => void run('git/switch', { branchName, create: false }, (value) => setBranches(value as GitBranchSnapshot)), onCopy: copyCommitHash }) : null,
  )
}

function ChangeSection({ title, items, busy, onAction }: { readonly title: string; readonly items: readonly GitChangeItem[]; readonly busy: boolean; readonly onAction: (action: 'stage' | 'unstage' | 'discard', path: string) => void }): ReactElement {
  return createElement('section', { style: sectionStyle },
    createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `${title} (${items.length})`)),
    items.length === 0 ? createElement('div', { style: mutedStyle }, '无') : items.map((item) => createElement('div', { key: `${item.status}:${item.path}`, style: fileRowStyle },
      createElement('span', { title: item.path, style: fileNameStyle }, item.path),
      createElement('span', { style: fileStatusStyle }, item.status),
      createElement('details', { style: menuStyle }, createElement('summary', { style: menuSummaryStyle, title: '操作菜单' }, '⋯'), createElement('div', { style: menuPopupStyle },
        item.staged ? createElement('button', { type: 'button', disabled: busy, onClick: () => onAction('unstage', item.path), style: menuButtonStyle }, '取消暂存') : createElement('button', { type: 'button', disabled: busy, onClick: () => onAction('stage', item.path), style: menuButtonStyle }, '暂存'),
        createElement('button', { type: 'button', disabled: busy, onClick: () => onAction('discard', item.path), style: dangerMenuButtonStyle }, '丢弃更改'),
      )),
    )),
  )
}

function HistorySection({ history, branches, busy, onSwitch, onCopy }: { readonly history: readonly GitHistoryItem[]; readonly branches: GitBranchSnapshot | null; readonly busy: boolean; readonly onSwitch: (branchName: string) => void; readonly onCopy: (commitHash: string) => void }): ReactElement {
  return createElement('section', { style: sectionStyle },
    createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `Git 版本 (${history.length})`), branches === null ? null : createElement('select', { value: branches.currentBranch, disabled: busy, onChange: (event: { currentTarget: { value: string } }) => onSwitch(event.currentTarget.value), style: branchSelectStyle }, ...branches.local.map((branch) => createElement('option', { key: branch.name, value: branch.name }, branch.name)))),
    history.length === 0 ? createElement('div', { style: mutedStyle }, '暂无提交') : history.map((item) => createElement('div', { key: item.commitHash, style: historyRowStyle }, createElement('code', undefined, item.commitHash.slice(0, 8)), createElement('span', { style: fileNameStyle, title: item.subject }, item.subject), createElement('time', { style: mutedStyle }, formatDate(item.authoredAt)), createElement('details', { style: menuStyle }, createElement('summary', { style: menuSummaryStyle, title: '版本操作菜单' }, '⋯'), createElement('div', { style: menuPopupStyle }, createElement('button', { type: 'button', onClick: () => onCopy(item.commitHash), style: menuButtonStyle }, '复制版本号'))))),
  )
}

interface WorkspaceItem { readonly workspaceId: string; readonly sessionIds?: readonly string[] }
function readWorkspaceItems(value: unknown): readonly WorkspaceItem[] { const items = (value as { items?: unknown } | null)?.items; return Array.isArray(items) ? items.filter((item): item is WorkspaceItem => typeof item === 'object' && item !== null && typeof (item as { workspaceId?: unknown }).workspaceId === 'string') : [] }
function findCurrentSessionId(value: unknown): string | undefined { const byId = (value as { byId?: Record<string, { id?: string; retainedBy?: { mainView?: number } }> } | null)?.byId; if (!byId) return undefined; return Object.values(byId).find((item) => (item.retainedBy?.mainView ?? 0) > 0)?.id }
function resolveWorkspaceId(sessionId: string | undefined, workspaces: readonly WorkspaceItem[]): string | undefined { return workspaces.find((item) => sessionId !== undefined && item.sessionIds?.includes(sessionId))?.workspaceId ?? workspaces[0]?.workspaceId }
function cacheKey(workspaceId: string): string { return `codingns4dsh.git.${workspaceId}` }
function readCache(workspaceId: string): { status: GitStatus; history: readonly GitHistoryItem[]; branches: GitBranchSnapshot | null } | null { try { const value = JSON.parse(localStorage.getItem(cacheKey(workspaceId)) ?? 'null') as { status?: GitStatus; history?: readonly GitHistoryItem[]; branches?: GitBranchSnapshot | null } | null; return value?.status ? { status: value.status, history: value.history ?? [], branches: value.branches ?? null } : null } catch { return null } }
function writeCache(workspaceId: string, value: { status: GitStatus; history: readonly GitHistoryItem[]; branches: GitBranchSnapshot | null }): void { try { localStorage.setItem(cacheKey(workspaceId), JSON.stringify(value)) } catch { /* 浏览器禁用存储时仅失去缓存 */ } }
async function call<T = unknown>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> { let result: CodingNsRpcResult; try { result = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload) } catch (error) { if (!/HTTP (?:404|405)\b/u.test(error instanceof Error ? error.message : String(error))) throw error; result = await rpc.call('/api', `codingns/${endpoint}`, payload) } if (!result.ok) throw new Error(result.error.message); return result.value as T }
async function copyText(value: string): Promise<boolean> { try { if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return false; await navigator.clipboard.writeText(value); return true } catch { return false } }
function formatDate(value: string): string { const timestamp = Date.parse(value); return Number.isNaN(timestamp) ? value : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(timestamp) }

const panelStyle: CSSProperties = { boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12, minHeight: '100%', padding: '16px 18px 24px', overflow: 'auto', background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary }
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}` }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: 1.2 }
const branchStyle: CSSProperties = { marginTop: 4, overflow: 'hidden', color: dshThemeColor.labelSecondary, fontSize: 12, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const summaryStyle: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 12 }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, background: dshThemeColor.menuBackground }
const sectionHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const fileRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, fontSize: 12 }
const fileNameStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const fileStatusStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontFamily: 'monospace', fontSize: 11 }
const historyRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, fontSize: 12 }
const mutedStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const messageStyle: CSSProperties = { padding: '7px 9px', borderRadius: 5, color: dshThemeColor.error, background: 'color-mix(in srgb, currentColor 10%, transparent)', fontSize: 12 }
const emptyStyle: CSSProperties = { padding: 16, color: dshThemeColor.labelSecondary, fontSize: 12 }
const subjectStyle: CSSProperties = { width: '100%', boxSizing: 'border-box', resize: 'vertical', border: `1px solid ${dshThemeColor.border}`, borderRadius: 5, padding: '7px 8px', color: dshThemeColor.labelPrimary, background: dshThemeColor.pageBackground, font: 'inherit', fontSize: 12 }
const primaryButtonStyle: CSSProperties = { minHeight: 28, border: 0, borderRadius: 5, padding: '4px 9px', color: '#fff', background: dshThemeColor.accent, cursor: 'pointer', fontSize: 12 }
const quietButtonStyle: CSSProperties = { border: 0, background: 'transparent', color: dshThemeColor.labelSecondary, cursor: 'pointer', fontSize: 18 }
const branchSelectStyle: CSSProperties = { maxWidth: 150, border: `1px solid ${dshThemeColor.border}`, borderRadius: 4, padding: '3px 5px', color: dshThemeColor.labelSecondary, background: dshThemeColor.pageBackground, fontSize: 11 }
const menuStyle: CSSProperties = { position: 'relative', flex: '0 0 auto' }
const menuSummaryStyle: CSSProperties = { listStyle: 'none', cursor: 'pointer', padding: '0 4px', color: dshThemeColor.labelSecondary, fontSize: 16 }
const menuPopupStyle: CSSProperties = { position: 'absolute', right: 0, zIndex: 2, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100, padding: 4, border: `1px solid ${dshThemeColor.border}`, borderRadius: 5, background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.subtleShadow }
const menuButtonStyle: CSSProperties = { border: 0, padding: '5px 7px', color: dshThemeColor.labelPrimary, background: 'transparent', textAlign: 'left', cursor: 'pointer', fontSize: 11 }
const dangerMenuButtonStyle: CSSProperties = { ...menuButtonStyle, color: dshThemeColor.error }

export const gitManagementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'gitManagement', version: '0.1.0', enabledByDefault: true, dependencies: [], runtime: 'client',
    ui: { label: 'Git 仓库管理', description: '在左侧栏查看提交、暂存文件、未提交文件和 Git 版本历史。', order: 40, defaultOpen: false },
  },
  start(context) {
    const uiContext = context.services.uiContext
    if (uiContext === undefined) throw new Error('Git 管理模块缺少 DSH UI 上下文')
    context.resources.add(registerGitManagementUi(uiContext, { rpc: context.services.rpc }))
  },
}
