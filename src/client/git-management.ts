import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GitBranchSnapshot, GitChangeItem, GitCommitChangedFile, GitCommitDiff, GitHistoryItem, GitStatus } from '../shared/contracts/git.js'
import type { CodingNsClientFeatureModule, CodingNsRpcClient, CodingNsRpcResult } from './features/types.js'
import { CODINGNS_RPC_CHANNEL } from '../shared/contracts/transport.js'
import { debugWarn } from '../shared/debug.js'
import { dshSettingsToastStyle, dshThemeColor } from './theme.js'
import type { SettingsNotice } from './features/types.js'

export const GIT_PROVIDER_ID = 'codingns4dsh/git'
export const GIT_KIND = 'git'
const INITIAL_HISTORY_LIMIT = 50
const HISTORY_PAGE_SIZE = 100
/** 兼容早期调用方使用的面板标识；实际注册已迁移到右侧 Sidebar。 */
export const GIT_PANEL_ID = GIT_PROVIDER_ID

type GitTabProps = PropsRuntime<'sidebar.right.pane.tab'> & {
  readonly rpc: CodingNsRpcClient
  readonly remote?: unknown
}
type GitTabTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>
type GitServices = { readonly rpc: CodingNsRpcClient; readonly remote?: unknown }
type GitOperation = 'fetch' | 'pull' | 'push' | 'undo' | 'refresh'

interface GitSidebarTab {
  readonly id: string
  readonly kind: string
  readonly contentId?: string
}

interface GitSidebarOpenTabs {
  readonly getSnapshot: () => readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[]
  readonly subscribe?: (listener: () => void) => () => void
}

interface GitSidebarRuntime {
  readonly openTabs?: GitSidebarOpenTabs
  readonly tabsIn?: (sessionId: string) => readonly GitSidebarTab[]
  readonly openTabIn?: (sessionId: string, kind: string) => void
  readonly closeIn?: (sessionId: string, tabId: string) => void
  readonly registerCloseHandler?: (kind: string, handler: (sessionId: string, tab: GitSidebarTab) => void) => () => void
}

interface GitPanelCache {
  readonly status: GitStatus
  readonly history: readonly GitHistoryItem[]
  readonly historyTotalCount: number
  readonly branches: GitBranchSnapshot | null
}

interface GitWorkspaceRecoveryProps extends PropsRuntime<'shell.overlay'> {
  readonly remote?: unknown
  readonly sidebarRight: GitSidebarRuntime
}

interface GitTreeDirectory {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: readonly GitTreeNode[]
}

interface GitTreeFile {
  readonly kind: 'file'
  readonly name: string
  readonly path: string
  readonly item: GitChangeItem
}

type GitTreeNode = GitTreeDirectory | GitTreeFile

interface MutableGitTreeDirectory {
  readonly kind: 'directory'
  readonly name: string
  readonly path: string
  readonly children: Map<string, MutableGitTreeDirectory | GitTreeFile>
}

/** 注册 DSH 右侧 Sidebar 的 Git 标签类型，数据按 Workspace 复用。 */
export function registerGitManagementUi(ctx: Context, services: GitServices): () => void {
  const disposers: Array<() => void> = []
  const sidebarRight = ctx.sidebarRight as typeof ctx.sidebarRight & GitSidebarRuntime
  try {
    disposers.push(ctx.sidebarRightTabs.register({
      id: GIT_PROVIDER_ID,
      kind: GIT_KIND,
      multiple: false,
      priority: 'extension',
      title: () => 'Git',
      guide: [{ id: 'git', order: 40, title: () => 'Git', description: () => '查看改动、提交和版本历史', icon: GitPanelIcon }],
    }))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: GIT_PROVIDER_ID,
      inject: () => ({ rpc: services.rpc, remote: services.remote }),
    }, GitPanel)))
    disposers.push(ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: GIT_PROVIDER_ID,
    }, GitTabTitle)))
    disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'codingns4dsh-git-workspace-recovery', order: 990,
      inject: () => ({ remote: services.remote, sidebarRight }),
    }, GitWorkspaceRecovery)))
    if (typeof sidebarRight.registerCloseHandler === 'function') {
      disposers.push(sidebarRight.registerCloseHandler(GIT_KIND, (sessionId, tab) => closeGitWorkspaceTabs(sidebarRight, services.remote, sessionId, tab)))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    if (isDuplicateGitRegistration(error)) {
      debugWarn(`codingns4dsh: Git Sidebar 已注册，跳过重复注册: ${GIT_PROVIDER_ID}`)
      return () => {}
    }
    throw error
  }
  return () => { for (const dispose of disposers.reverse()) dispose() }
}

function isDuplicateGitRegistration(error: unknown): boolean {
  return error instanceof Error && /sidebarRight: (?:tab type id|tab kind) .* already registered/u.test(error.message)
}

function GitPanelIcon({ size = 16 }: { readonly size?: number | undefined }): ReactElement {
  return createElement('span', {
    title: 'Git 仓库管理', 'aria-label': 'Git 仓库管理', style: { display: 'inline-flex', width: size, height: size, alignItems: 'center', justifyContent: 'center', color: dshThemeColor.labelSecondary, fontSize: Math.max(12, size - 2), fontWeight: 700 },
  }, '⑂')
}

function GitTabTitle({ useTabInfo }: GitTabTitleProps): ReactElement {
  useTabInfo()
  return createElement('span', { title: 'Git 仓库管理', 'aria-label': 'Git 仓库管理', style: tabTitleStyle }, 'Git')
}

function GitPanel(props: GitTabProps): ReactElement {
  const sessionId = String(props.sessionId)
  const tabInfo = props.useTabInfo()
  const [workspaceId, setWorkspaceId] = useState<string | undefined>()
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [history, setHistory] = useState<readonly GitHistoryItem[]>([])
  const [branches, setBranches] = useState<GitBranchSnapshot | null>(null)
  const [subject, setSubject] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<SettingsNotice | null>(null)
  const [diffView, setDiffView] = useState<GitCommitDiff | null>(null)
  const [historyTotalCount, setHistoryTotalCount] = useState(0)
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false)
  const historyExpanded = useRef(false)

  useEffect(() => {
    if (toast === null) return
    const timer = globalThis.setTimeout(() => setToast(null), 3200)
    return () => globalThis.clearTimeout(timer)
  }, [toast])

  const notify = (kind: SettingsNotice['kind'], message: string): void => setToast({ kind, message })

  useEffect(() => {
    let disposed = false
    let cleanupTimer: (() => void) | undefined
    setToast(null)
    setWorkspaceId(undefined)
    setStatus(null)
    setHistory([])
    setHistoryTotalCount(0)
    historyExpanded.current = false
    setBranches(null)
    setDiffView(null)
    const load = async (resolvedWorkspaceId: string): Promise<void> => {
      const cached = readCache(resolvedWorkspaceId)
      // 已经手动展开历史后，定时刷新只能更新状态和分支，不能用首屏缓存覆盖已加载的分页。
      if (cached !== null && !historyExpanded.current) { setStatus(cached.status); setHistory(cached.history); setHistoryTotalCount(cached.historyTotalCount); setBranches(cached.branches) }
      try {
        const nextStatus = await call<GitStatus>(props.rpc, 'git/status', { workspaceId: resolvedWorkspaceId })
        if (disposed) return
        if (nextStatus.snapshot.enabled === false) {
          setStatus(nextStatus); setHistory([]); setHistoryTotalCount(0); setBranches(null); writeCache(resolvedWorkspaceId, { status: nextStatus, history: [], historyTotalCount: 0, branches: null }); setToast(null)
          return
        }
        const [nextHistory, nextBranches] = await Promise.all([
          historyExpanded.current ? Promise.resolve(null) : call<{ items: readonly GitHistoryItem[]; totalCount: number }>(props.rpc, 'git/history', { workspaceId: resolvedWorkspaceId, limit: INITIAL_HISTORY_LIMIT, offset: 0 }),
          call<GitBranchSnapshot>(props.rpc, 'git/branches', { workspaceId: resolvedWorkspaceId }),
        ])
        if (disposed) return
        const normalizedBranches = normalizeBranchSnapshot(nextBranches)
        if (nextHistory !== null) { setHistory(nextHistory.items); setHistoryTotalCount(nextHistory.totalCount); writeCache(resolvedWorkspaceId, { status: nextStatus, history: nextHistory.items, historyTotalCount: nextHistory.totalCount, branches: normalizedBranches }) }
        setStatus(nextStatus); setBranches(normalizedBranches)
        setToast(null)
      } catch (error) {
        if (!disposed) notify('error', error instanceof Error ? error.message : String(error))
      }
    }
    void resolveGitWorkspaceId(props.remote, sessionId).then((resolvedWorkspaceId) => {
      if (disposed) return
      if (resolvedWorkspaceId === undefined) { notify('error', '当前没有可用的工作区'); return }
      rememberGitWorkspaceSession(sessionId, resolvedWorkspaceId)
      writeGitWorkspaceOpen(resolvedWorkspaceId, true)
      setWorkspaceId(resolvedWorkspaceId)
      void load(resolvedWorkspaceId)
      const timer = globalThis.setInterval(() => { void load(resolvedWorkspaceId) }, 5_000)
      cleanupTimer = () => globalThis.clearInterval(timer)
    }).catch((error: unknown) => { if (!disposed) notify('error', error instanceof Error ? error.message : String(error)) })
    return () => { disposed = true; cleanupTimer?.() }
  }, [props.remote, props.rpc, sessionId])

  useEffect(() => {
    const close = (): void => {
      if (!tabInfo.tab.signal.aborted) return
      const resolvedWorkspaceId = workspaceBySession.get(sessionId)
      if (resolvedWorkspaceId !== undefined) writeGitWorkspaceOpen(resolvedWorkspaceId, false)
    }
    if (tabInfo.tab.signal.aborted) close()
    else tabInfo.tab.signal.addEventListener('abort', close, { once: true })
    return () => tabInfo.tab.signal.removeEventListener('abort', close)
  }, [sessionId, tabInfo.tab.signal])

  const run = async (action: string, payload: Record<string, unknown>, onSuccess?: (value: unknown) => void): Promise<void> => {
    setBusy(true); setToast(null)
    if (workspaceId === undefined) { notify('error', '当前没有可用的工作区'); setBusy(false); return }
    const targetWorkspaceId = workspaceId
    const preserveExpandedHistory = action === 'git/status' && historyExpanded.current
    if (!preserveExpandedHistory) historyExpanded.current = false
    try {
      const value = await call(props.rpc, action, { workspaceId: targetWorkspaceId, ...payload })
      onSuccess?.(value)
      const nextStatus = await call<GitStatus>(props.rpc, 'git/status', { workspaceId: targetWorkspaceId })
      setStatus(nextStatus)
      if (nextStatus.snapshot.enabled !== false) {
        const [nextHistory, nextBranches] = await Promise.all([
          preserveExpandedHistory ? Promise.resolve(null) : call<{ items: readonly GitHistoryItem[]; totalCount: number }>(props.rpc, 'git/history', { workspaceId: targetWorkspaceId, limit: INITIAL_HISTORY_LIMIT, offset: 0 }),
          call<GitBranchSnapshot>(props.rpc, 'git/branches', { workspaceId: targetWorkspaceId }),
        ])
        const normalizedBranches = normalizeBranchSnapshot(nextBranches)
        if (nextHistory !== null) { setHistory(nextHistory.items); setHistoryTotalCount(nextHistory.totalCount); writeCache(targetWorkspaceId, { status: nextStatus, history: nextHistory.items, historyTotalCount: nextHistory.totalCount, branches: normalizedBranches }) }
        setBranches(normalizedBranches)
      } else {
        setHistory([]); setHistoryTotalCount(0); setBranches(null); writeCache(targetWorkspaceId, { status: nextStatus, history: [], historyTotalCount: 0, branches: null })
      }
      notify('success', '操作已完成')
    }
    catch (error) { notify('error', error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const commit = (): void => {
    const value = subject.trim()
    if (!value) { notify('error', '请输入提交说明'); return }
    void run('git/commit', { subject: value }, () => setSubject(''))
  }
  const copyCommitHash = (commitHash: string): void => {
    void copyText(commitHash).then((copied) => notify(copied ? 'success' : 'error', copied ? 'Git 版本号已复制' : '当前环境不支持复制'))
  }
  const copyCommitMessage = (value: string): void => {
    void copyText(value).then((copied) => notify(copied ? 'success' : 'error', copied ? '提交信息已复制' : '当前环境不支持复制'))
  }
  const openCommitDiff = (commitHash: string): void => {
    if (workspaceId === undefined) return
    setBusy(true)
    notify('info', '正在读取提交 Diff…')
    void call<GitCommitDiff>(props.rpc, 'git/commit-diff', { workspaceId, commitHash }).then((value) => {
      setDiffView(value)
      setToast(null)
    }).catch((error: unknown) => notify('error', error instanceof Error ? error.message : String(error))).finally(() => setBusy(false))
  }
  const loadMoreHistory = (): void => {
    if (workspaceId === undefined || historyLoadingMore || history.length >= historyTotalCount) return
    setHistoryLoadingMore(true)
    historyExpanded.current = true
    void call<{ items: readonly GitHistoryItem[]; totalCount: number }>(props.rpc, 'git/history', { workspaceId, limit: HISTORY_PAGE_SIZE, offset: history.length }).then((page) => {
      setHistory((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.commitHash === item.commitHash))])
      setHistoryTotalCount(page.totalCount)
    }).catch((error: unknown) => { historyExpanded.current = history.length > INITIAL_HISTORY_LIMIT; notify('error', error instanceof Error ? error.message : String(error)) }).finally(() => setHistoryLoadingMore(false))
  }
  const changes = status?.changes ?? []
  const staged = changes.filter((item) => hasStagedChanges(item))
  const unstaged = changes.filter((item) => hasUnstagedChanges(item))
  const runGitOperation = (action: GitOperation): void => {
    if (action === 'refresh') { void run('git/status', {}, (value) => setStatus(value as GitStatus)); return }
    void run(`git/${action}`, {})
  }
  const stageAll = (): void => { void run('git/stage', { targets: unstaged.map((item) => item.path) }) }
  const discardAll = (): void => { void run('git/discard', { targets: changes.map((item) => item.path) }) }
  return createElement('section', { style: panelStyle, 'data-git-management-panel': 'true' },
    createElement('header', { style: headerStyle },
      createElement('div', { style: { minWidth: 0 } }, createElement('h1', { style: titleStyle }, 'Git'), createElement('div', { style: branchStyle, title: status?.snapshot.repoRoot }, status?.snapshot.branch ?? '读取中')),
      createElement('div', { style: headerActionsStyle },
        createElement(GitOperationsMenu, { busy, hasRemote: Boolean(status?.snapshot.hasRemote || branches?.remote.length), canUndo: history.length > 0, hasMoreVersions: history.length < historyTotalCount, stagedCount: staged.length, unstagedCount: unstaged.length, onStageAll: stageAll, onDiscardAll: discardAll, onLoadMore: loadMoreHistory, onOperation: runGitOperation }),
      ),
    ),
    toast === null ? null : createElement('div', { role: toast.kind === 'error' ? 'alert' : 'status', 'aria-live': 'polite', style: { ...dshSettingsToastStyle, position: 'absolute', top: 8, right: 'auto', left: '50%', transform: 'translateX(-50%)', width: 'min(300px, calc(100% - 24px))', pointerEvents: 'none', borderColor: toast.kind === 'error' ? dshThemeColor.error : toast.kind === 'success' ? dshThemeColor.success : dshThemeColor.border } }, toast.message),
    status === null ? createElement('div', { style: emptyStyle }, '正在读取 Git 状态…') : null,
    status !== null && status.snapshot.enabled === false ? createElement('section', { style: sectionStyle },
      createElement('strong', undefined, '当前目录还没有 Git 仓库'),
      createElement('div', { style: mutedStyle }, '初始化后即可查看改动、提交和版本历史。'),
      createElement('button', { type: 'button', disabled: busy, onClick: () => void run('git/init', {}), style: primaryButtonStyle }, '初始化 Git'),
    ) : null,
    status !== null ? createElement('div', { style: summaryStyle }, `${staged.length} 个已暂存 · ${unstaged.length} 个未暂存 · ${historyTotalCount} 条提交`) : null,
    diffView !== null ? createElement(DiffViewer, { diff: diffView, onClose: () => setDiffView(null) }) : null,
    status !== null && status.snapshot.enabled !== false ? createElement('div', { style: contentGridStyle },
      createElement('div', { style: columnStyle },
        createElement('section', { style: commitSectionStyle },
          createElement('div', { style: commitEditorRowStyle },
            createElement('textarea', { value: subject, disabled: busy || workspaceId === undefined, onChange: (event: { currentTarget: { value: string } }) => setSubject(event.currentTarget.value), onKeyDown: (event: { key: string; preventDefault: () => void }) => { if (event.key === 'Enter') event.preventDefault() }, placeholder: '在这里输入提交信息', rows: 1, style: commitSubjectStyle }),
            createElement('button', { type: 'button', disabled: busy || workspaceId === undefined, onClick: () => notify('info', '生成提交信息功能暂未开放'), style: draftButtonStyle, title: '生成提交信息', 'aria-label': '生成提交信息' }, '✦'),
          ),
          createElement('div', { style: commitActionsStyle },
            createElement('button', { type: 'button', disabled: busy || workspaceId === undefined, onClick: () => void run('git/status', {}, (value) => setStatus(value as GitStatus)), style: refreshActionStyle }, '刷新'),
            createElement('button', { type: 'button', disabled: busy || workspaceId === undefined || staged.length === 0 || subject.trim().length === 0, onClick: commit, style: submitActionStyle }, '提交'),
          ),
        ),
        staged.length > 0 ? createElement(ChangeSection, { title: '暂存文件', items: staged, busy, onAction: (action, path) => void run(`git/${action}`, { targets: [path] }), onBatchAction: (action, paths) => void run(`git/${action}`, { targets: paths }), onBulkAction: () => void run('git/unstage', { targets: staged.map((item) => item.path) }) }) : null,
        unstaged.length > 0 ? createElement(ChangeSection, { title: '未提交文件', items: unstaged, busy, onAction: (action, path) => void run(`git/${action}`, { targets: [path] }), onBatchAction: (action, paths) => void run(`git/${action}`, { targets: paths }), onBulkAction: () => void run('git/stage', { targets: unstaged.map((item) => item.path) }) }) : null,
      ),
      createElement('div', { style: columnStyle },
        createElement(HistorySection, { history, totalCount: historyTotalCount, hasMore: history.length < historyTotalCount, loadingMore: historyLoadingMore, onLoadMore: loadMoreHistory, branches, busy, onSwitch: (branchName) => void run('git/switch', { branchName, create: false }, (value) => setBranches(normalizeBranchSnapshot(value as GitBranchSnapshot))), onCopy: copyCommitHash, onCopyMessage: copyCommitMessage, onViewDiff: openCommitDiff, onUndo: () => runGitOperation('undo') }),
      ),
    ) : null,
  )
}

function ChangeSection({ title, items, busy, onAction, onBatchAction, onBulkAction }: { readonly title: string; readonly items: readonly GitChangeItem[]; readonly busy: boolean; readonly onAction: (action: 'stage' | 'unstage' | 'discard', path: string) => void; readonly onBatchAction: (action: 'stage' | 'unstage' | 'discard', paths: readonly string[]) => void; readonly onBulkAction: () => void }): ReactElement {
  const [hoveredPath, setHoveredPath] = useState<string | null>(null)
  const nodes = buildChangeTree(items)
  const staged = title === '暂存文件'
  const renderNode = (node: GitTreeNode, depth: number): ReactElement => {
    if (node.kind === 'directory') {
      const directoryKey = `dir:${node.path}`
      const directoryTargets = collectTreeTargets(node)
      const isHovered = hoveredPath === directoryKey
      return createElement('details', { key: `dir:${node.path}`, open: true, style: treeDirectoryStyle },
        createElement('summary', { style: { ...treeRowStyle, paddingLeft: 8 + depth * 14 }, onMouseEnter: () => setHoveredPath(directoryKey), onMouseLeave: () => setHoveredPath(null) },
          createElement('span', { style: treeChevronStyle }, '⌄'), createElement('span', { style: folderIconStyle }, '▰'), createElement('span', { style: fileNameStyle, title: node.path }, node.name), createElement('span', { style: mutedStyle }, countTreeFiles(node)),
          isHovered ? createElement('div', { style: rowActionsStyle },
            createElement('button', { type: 'button', disabled: busy, onClick: (event: { stopPropagation: () => void; preventDefault: () => void }) => { event.preventDefault(); event.stopPropagation(); onBatchAction(staged ? 'unstage' : 'stage', directoryTargets) }, style: iconButtonStyle, title: staged ? '撤销目录暂存' : '将目录添加到暂存区', 'aria-label': staged ? '撤销目录暂存' : '将目录添加到暂存区' }, staged ? '↶' : '+'),
            !staged ? createElement('button', { type: 'button', disabled: busy, onClick: (event: { stopPropagation: () => void; preventDefault: () => void }) => { event.preventDefault(); event.stopPropagation(); onBatchAction('discard', directoryTargets) }, style: dangerIconButtonStyle, title: '撤销目录变更', 'aria-label': '撤销目录变更' }, '×') : null,
          ) : null,
        ),
        createElement('div', undefined, ...node.children.map((child) => renderNode(child, depth + 1))),
      )
    }
    const isHovered = hoveredPath === node.path
    return createElement('div', { key: `file:${node.path}`, style: { ...treeRowStyle, paddingLeft: 28 + depth * 14 }, onMouseEnter: () => setHoveredPath(node.path), onMouseLeave: () => setHoveredPath(null) },
      createElement('span', { style: fileIconStyle }, fileIcon(node.name)),
      createElement('span', { title: node.path, style: fileNameStyle }, node.name),
      createElement('span', { style: fileStatusStyle }, changeStatus(node.item, staged)),
      isHovered ? createElement('div', { style: rowActionsStyle },
        createElement('button', { type: 'button', disabled: busy, onClick: () => onAction(staged ? 'unstage' : 'stage', node.path), style: iconButtonStyle, title: staged ? '撤销暂存' : '添加到暂存区', 'aria-label': staged ? '撤销暂存' : '添加到暂存区' }, staged ? '↶' : '+'),
        !staged ? createElement('button', { type: 'button', disabled: busy, onClick: () => onAction('discard', node.path), style: dangerIconButtonStyle, title: '撤销变更', 'aria-label': '撤销变更' }, '×') : null,
      ) : null,
    )
  }
  return createElement('section', { style: sectionStyle },
    createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `${title} (${items.length})`), createElement('button', { type: 'button', disabled: busy, onClick: onBulkAction, style: iconButtonStyle, title: staged ? '取消全部暂存' : '全部添加到暂存区', 'aria-label': staged ? '取消全部暂存' : '全部添加到暂存区' }, staged ? '↶' : '+')),
    createElement('div', { style: treeStyle }, ...nodes.map((node) => renderNode(node, 0))),
  )
}

function GitOperationsMenu({ busy, hasRemote, canUndo, hasMoreVersions, stagedCount, unstagedCount, onStageAll, onDiscardAll, onLoadMore, onOperation }: { readonly busy: boolean; readonly hasRemote: boolean; readonly canUndo: boolean; readonly hasMoreVersions: boolean; readonly stagedCount: number; readonly unstagedCount: number; readonly onStageAll: () => void; readonly onDiscardAll: () => void; readonly onLoadMore: () => void; readonly onOperation: (action: GitOperation) => void }): ReactElement {
  return createElement('details', { style: menuStyle },
    createElement('summary', { style: menuSummaryStyle, title: 'Git 操作菜单', 'aria-label': 'Git 操作菜单' }, '⋯'),
    createElement('div', { style: menuPopupStyle },
      createElement('button', { type: 'button', disabled: busy || unstagedCount === 0, onClick: onStageAll, style: menuButtonStyle }, '暂存全部'),
      createElement('button', { type: 'button', disabled: busy || stagedCount + unstagedCount === 0, onClick: onDiscardAll, style: dangerMenuButtonStyle }, '放弃全部改动'),
      createElement('button', { type: 'button', disabled: busy || !hasRemote, onClick: () => onOperation('fetch'), style: menuButtonStyle }, 'Fetch'),
      createElement('button', { type: 'button', disabled: busy || !hasRemote, onClick: () => onOperation('pull'), style: menuButtonStyle }, 'Pull'),
      createElement('button', { type: 'button', disabled: busy || !hasRemote || stagedCount > 0 || unstagedCount > 0, onClick: () => onOperation('push'), style: menuButtonStyle }, 'Push'),
      createElement('button', { type: 'button', disabled: busy || !hasMoreVersions, onClick: onLoadMore, style: menuButtonStyle, title: '查看所有版本' }, '查看更多版本（每次 100 条）'),
      createElement('button', { type: 'button', disabled: busy || !canUndo, onClick: () => onOperation('undo'), style: menuButtonStyle }, '撤销上次提交'),
      createElement('button', { type: 'button', disabled: busy, onClick: () => onOperation('refresh'), style: menuButtonStyle }, '刷新'),
    ),
  )
}

interface ParsedDiffLine {
  readonly kind: 'context' | 'add' | 'remove' | 'hunk' | 'meta'
  readonly text: string
  readonly oldLineNo: number | null
  readonly newLineNo: number | null
}

function DiffViewer({ diff, onClose }: { readonly diff: GitCommitDiff; readonly onClose: () => void }): ReactElement {
  const providedFiles = diff.files ?? []
  const files = providedFiles.length > 0 ? providedFiles : parseDiffFiles(diff.content)
  const lines = parseDiffLines(diff.content)
  return createElement('div', { style: diffOverlayStyle },
    createElement('section', { role: 'dialog', 'aria-modal': true, 'aria-label': '提交 Diff', style: diffStyle },
      createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `提交 Diff · ${diff.commitHash.slice(0, 8)}`), createElement('button', { type: 'button', onClick: onClose, style: iconButtonStyle, title: '关闭 Diff', 'aria-label': '关闭 Diff' }, '×')),
      createElement('div', { style: diffBodyStyle },
        createElement('section', { style: diffFilesSectionStyle },
          createElement('div', { style: diffSectionHeaderStyle }, createElement('strong', undefined, '变更文件'), createElement('span', { style: diffCountStyle }, String(files.length))),
          files.length === 0 ? createElement('div', { style: diffEmptyStyle }, '没有检测到文件变更。') : createElement('div', { style: diffFileListStyle }, ...files.map((file) => createElement('div', { key: `${file.status}:${file.oldPath ?? ''}:${file.path}`, style: diffFileRowStyle }, createElement('span', { style: diffFileStatusStyle, 'data-status': file.status }, diffFileStatusLabel(file.status)), createElement('div', { style: diffFileNameStyle }, createElement('strong', undefined, file.path), file.oldPath ? createElement('span', { style: diffFileOldPathStyle }, `原路径：${file.oldPath}`) : null), file.binary ? createElement('span', { style: diffBinaryStyle }, '二进制') : null))),
        ),
        createElement('section', { style: diffDiffSectionStyle },
          createElement('div', { style: diffSectionHeaderStyle }, createElement('strong', undefined, 'Diff'), diff.truncated ? createElement('span', { style: diffTruncatedStyle }, '内容已截断') : null),
          lines.length === 0 ? createElement('div', { style: diffEmptyStyle }, '当前没有可显示的文本差异。') : createElement('div', { style: diffLinesStyle }, ...lines.map((line, index) => createElement('div', { key: `${index}:${line.kind}:${line.text}`, style: diffLineStyle(line.kind) }, createElement('span', { style: diffLineNumberStyle }, line.oldLineNo === null ? '' : String(line.oldLineNo)), createElement('span', { style: diffLineNumberStyle }, line.newLineNo === null ? '' : String(line.newLineNo)), createElement('code', { style: diffCodeStyle }, `${diffLinePrefix(line.kind)}${line.text}`)))),
        ),
      ),
    ),
  )
}

function parseDiffLines(content: string): readonly ParsedDiffLine[] {
  const lines: ParsedDiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const rawLine of content.replace(/\r\n/gu, '\n').split('\n')) {
    if (rawLine.startsWith('diff --git') || rawLine.startsWith('index ') || rawLine.startsWith('--- ') || rawLine.startsWith('+++ ')) {
      lines.push({ kind: 'meta', text: rawLine, oldLineNo: null, newLineNo: null })
      continue
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(rawLine)
    if (hunk !== null) {
      oldLine = Number(hunk[1]); newLine = Number(hunk[2])
      lines.push({ kind: 'hunk', text: rawLine, oldLineNo: null, newLineNo: null })
      continue
    }
    if (rawLine.startsWith(' ') || rawLine === '') {
      lines.push({ kind: 'context', text: rawLine.slice(1), oldLineNo: oldLine, newLineNo: newLine }); oldLine += 1; newLine += 1; continue
    }
    if (rawLine.startsWith('+')) {
      lines.push({ kind: 'add', text: rawLine.slice(1), oldLineNo: null, newLineNo: newLine }); newLine += 1; continue
    }
    if (rawLine.startsWith('-')) {
      lines.push({ kind: 'remove', text: rawLine.slice(1), oldLineNo: oldLine, newLineNo: null }); oldLine += 1; continue
    }
    lines.push({ kind: 'meta', text: rawLine, oldLineNo: null, newLineNo: null })
  }
  return lines
}

function parseDiffFiles(content: string): readonly GitCommitChangedFile[] {
  const result: GitCommitChangedFile[] = []
  for (const line of content.split(/\r?\n/u)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line)
    if (match === null) continue
    const path = match[2] ?? match[1] ?? ''
    if (path === '' || result.some((file) => file.path === path)) continue
    result.push({ path, oldPath: match[1] === path ? null : match[1] ?? null, status: 'M', binary: false })
  }
  return result
}

function diffFileStatusLabel(status: string): string { return status === 'A' ? '新增' : status === 'D' ? '删除' : status === 'R' ? '重命名' : status === 'C' ? '复制' : '修改' }
function diffLinePrefix(kind: ParsedDiffLine['kind']): string { return kind === 'add' ? '+' : kind === 'remove' ? '-' : kind === 'context' ? ' ' : '' }
function diffLineStyle(kind: ParsedDiffLine['kind']): CSSProperties {
  if (kind === 'add') return { ...diffLineBaseStyle, color: '#1f9d55', background: 'color-mix(in srgb, #22c55e 13%, transparent)' }
  if (kind === 'remove') return { ...diffLineBaseStyle, color: '#e05252', background: 'color-mix(in srgb, #ef4444 13%, transparent)' }
  if (kind === 'hunk') return { ...diffLineBaseStyle, color: dshThemeColor.accent, background: 'color-mix(in srgb, currentColor 10%, transparent)', fontWeight: 600 }
  if (kind === 'meta') return { ...diffLineBaseStyle, color: dshThemeColor.labelTertiary }
  return diffLineBaseStyle
}

function HistorySection({ history, totalCount, hasMore, loadingMore, onLoadMore, branches, busy, onSwitch, onCopy, onCopyMessage, onViewDiff, onUndo }: { readonly history: readonly GitHistoryItem[]; readonly totalCount: number; readonly hasMore: boolean; readonly loadingMore: boolean; readonly onLoadMore: () => void; readonly branches: GitBranchSnapshot | null; readonly busy: boolean; readonly onSwitch: (branchName: string) => void; readonly onCopy: (commitHash: string) => void; readonly onCopyMessage: (message: string) => void; readonly onViewDiff: (commitHash: string) => void; readonly onUndo: () => void }): ReactElement {
  const rows = history.map((item, index) => createElement('div', { key: item.commitHash, style: historyRowStyle },
    createElement('code', { style: hashStyle }, item.commitHash.slice(0, 8)),
    createElement('span', { style: fileNameStyle, title: item.subject }, item.subject),
    createElement('time', { style: mutedStyle }, formatDate(item.authoredAt)),
    createElement('details', { style: menuStyle },
      createElement('summary', { style: menuSummaryStyle, title: '版本操作菜单', 'aria-label': '版本操作菜单' }, '⋯'),
      createElement('div', { style: menuPopupStyle },
        createElement('button', { type: 'button', onClick: () => onViewDiff(item.commitHash), style: menuButtonStyle }, '查看更改文件与 Diff'),
        createElement('button', { type: 'button', onClick: () => onCopy(item.commitHash), style: menuButtonStyle }, '复制 Commit Hash'),
        createElement('button', { type: 'button', onClick: () => onCopyMessage(buildCommitMessageText(item.subject, item.body)), style: menuButtonStyle }, '复制提交信息'),
        createElement('button', { type: 'button', onClick: () => onCopy(item.commitHash), style: menuButtonStyle }, '复制 Git 版本号'),
        index === 0 ? createElement('button', { type: 'button', disabled: busy, onClick: onUndo, style: dangerMenuButtonStyle }, '撤销上次提交') : null,
      ),
    ),
  ))
  return createElement('section', { style: sectionStyle },
    createElement('div', { style: sectionHeaderStyle }, createElement('strong', undefined, `Git 版本 (${totalCount})`), branches === null ? null : createElement('select', { value: branches.currentBranch, disabled: busy, onChange: (event: { currentTarget: { value: string } }) => onSwitch(event.currentTarget.value), style: branchSelectStyle }, ...branches.local.map((branch) => createElement('option', { key: branch.name, value: branch.name }, branch.name)))),
    history.length === 0 ? createElement('div', { style: mutedStyle }, '暂无提交') : rows,
    hasMore ? createElement('button', { type: 'button', disabled: busy || loadingMore, onClick: onLoadMore, style: loadMoreButtonStyle }, loadingMore ? '正在加载…' : '查看更多版本（每次 100 条）') : null,
  )
}

function buildChangeTree(items: readonly GitChangeItem[]): readonly GitTreeNode[] {
  const root = new Map<string, MutableGitTreeDirectory | GitTreeFile>()
  for (const item of items) {
    const parts = item.path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let current = root
    let parentPath = ''
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]!
      parentPath = parentPath ? `${parentPath}/${name}` : name
      const existing = current.get(name)
      if (existing?.kind === 'directory') current = existing.children
      else {
        const directory: MutableGitTreeDirectory = { kind: 'directory', name, path: parentPath, children: new Map() }
        current.set(name, directory)
        current = directory.children
      }
    }
    const fileName = parts.at(-1)!
    current.set(fileName, { kind: 'file', name: fileName, path: item.path, item })
  }
  return finalizeChangeTree(root)
}

function finalizeChangeTree(nodes: Map<string, MutableGitTreeDirectory | GitTreeFile>): readonly GitTreeNode[] {
  return [...nodes.values()].map((node) => node.kind === 'directory' ? { kind: 'directory' as const, name: node.name, path: node.path, children: finalizeChangeTree(node.children) } : node).sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === 'directory' ? -1 : 1)
}

function collectTreeTargets(node: GitTreeNode): readonly string[] {
  if (node.kind === 'file') return [node.path]
  return node.children.flatMap((child) => collectTreeTargets(child))
}

function countTreeFiles(node: GitTreeNode): number { return node.kind === 'file' ? 1 : node.children.reduce((total, child) => total + countTreeFiles(child), 0) }
function hasStagedChanges(item: GitChangeItem): boolean { return item.staged || item.stagedStatus !== null }
function hasUnstagedChanges(item: GitChangeItem): boolean { return !item.staged || item.worktreeStatus !== null }
function changeStatus(item: GitChangeItem, staged: boolean): string { return staged ? item.stagedStatus ?? item.status : item.worktreeStatus ?? item.status }
function fileIcon(name: string): string { return name.endsWith('/') ? '▰' : name.includes('.') ? '·' : '□' }

interface GitWorkspaceApi { readonly follow?: () => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>> }
interface GitSessionApi { readonly list?: (request: { readonly cursor?: string }) => Promise<unknown> }
interface GitRemote { readonly workspace?: GitWorkspaceApi; readonly session?: GitSessionApi }

const GIT_WORKSPACE_OPEN_PREFIX = 'codingns4dsh.git.open.'
const GIT_WORKSPACE_STATE_EVENT = 'codingns4dsh-git-workspace-state'
const workspaceBySession = new Map<string, string>()
const closingWorkspaces = new Set<string>()

function GitWorkspaceRecovery({ useSessions, remote, sidebarRight }: GitWorkspaceRecoveryProps): ReactElement | null {
  const sessionsSnapshot = useSessions((value: unknown) => value)
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const openTabs = readGitOpenTabs(sidebarRight)
  const openTabSnapshot = useSyncExternalStore(
    openTabs?.subscribe ?? noSubscribe,
    openTabs?.getSnapshot ?? noOpenTabs,
    openTabs?.getSnapshot ?? noOpenTabs,
  )
  const sessionIds = [...new Set([...readSessionIds(sessionsSnapshot), ...openTabSnapshot.map((tab) => String(tab.sessionId))].filter(Boolean))]
  useEffect(() => {
    if (typeof window === 'undefined') return
    const refresh = (): void => setWorkspaceRevision((value) => value + 1)
    window.addEventListener(GIT_WORKSPACE_STATE_EVENT, refresh)
    window.addEventListener('storage', refresh)
    return () => { window.removeEventListener(GIT_WORKSPACE_STATE_EVENT, refresh); window.removeEventListener('storage', refresh) }
  }, [])
  useEffect(() => {
    if (typeof sidebarRight.openTabIn !== 'function') return
    let disposed = false
    const recover = async (): Promise<void> => {
      const workspaceItems = await readWorkspaceItems((remote as GitRemote | undefined)?.workspace)
      const allSessionIds = [...new Set([...sessionIds, ...workspaceItems.flatMap((item) => item.sessionIds)])]
      for (const sessionId of allSessionIds) {
        const workspaceId = await resolveGitWorkspaceId(remote, sessionId).catch(() => undefined)
        if (disposed || workspaceId === undefined) continue
        rememberGitWorkspaceSession(sessionId, workspaceId)
        const existing = readGitTabs(sidebarRight, sessionId, openTabSnapshot)
        const openState = readGitWorkspaceOpen(workspaceId)
        if (openState === false) {
          for (const tab of existing) if (tab.kind === GIT_KIND) sidebarRight.closeIn?.(sessionId, tab.id)
          continue
        }
        if (openState !== true) continue
        if (existing.some((tab) => tab.kind === GIT_KIND)) continue
        sidebarRight.openTabIn?.(sessionId, GIT_KIND)
      }
    }
    void recover()
    return () => { disposed = true }
  }, [openTabSnapshot, remote, sessionIds.join('|'), sidebarRight, workspaceRevision])
  return null
}

function closeGitWorkspaceTabs(sidebar: GitSidebarRuntime, remote: unknown, sessionId: string, tab: GitSidebarTab): void {
  const knownWorkspaceId = workspaceBySession.get(sessionId)
  if (knownWorkspaceId !== undefined) {
    closeKnownGitWorkspaceTabs(sidebar, knownWorkspaceId, sessionId, tab.id)
    return
  }
  void resolveGitWorkspaceId(remote, sessionId).then((workspaceId) => {
    if (workspaceId === undefined) return
    rememberGitWorkspaceSession(sessionId, workspaceId)
    closeKnownGitWorkspaceTabs(sidebar, workspaceId, sessionId, tab.id)
  }).catch(() => undefined)
}

function closeKnownGitWorkspaceTabs(sidebar: GitSidebarRuntime, workspaceId: string, currentSessionId: string, currentTabId: string): void {
  writeGitWorkspaceOpen(workspaceId, false)
  if (closingWorkspaces.has(workspaceId)) return
  closingWorkspaces.add(workspaceId)
  try {
    for (const entry of readGitOpenTabs(sidebar)?.getSnapshot() ?? []) {
      if (entry.kind !== GIT_KIND || entry.sessionId === currentSessionId && entry.tabId === currentTabId) continue
      if (workspaceBySession.get(String(entry.sessionId)) !== workspaceId) continue
      sidebar.closeIn?.(String(entry.sessionId), String(entry.tabId))
    }
  } finally {
    closingWorkspaces.delete(workspaceId)
  }
}

function rememberGitWorkspaceSession(sessionId: string, workspaceId: string): void {
  const normalizedSessionId = sessionId.trim()
  const normalizedWorkspaceId = workspaceId.trim()
  if (normalizedSessionId !== '' && normalizedWorkspaceId !== '') workspaceBySession.set(normalizedSessionId, normalizedWorkspaceId)
}

function gitWorkspaceOpenKey(workspaceId: string): string { return `${GIT_WORKSPACE_OPEN_PREFIX}${workspaceId}` }
function readGitWorkspaceOpen(workspaceId: string): boolean | undefined {
  try {
    const value = localStorage.getItem(gitWorkspaceOpenKey(workspaceId))
    return value === null ? undefined : value === '1'
  } catch { return undefined }
}
function writeGitWorkspaceOpen(workspaceId: string, open: boolean): void {
  try {
    localStorage.setItem(gitWorkspaceOpenKey(workspaceId), open ? '1' : '0')
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(GIT_WORKSPACE_STATE_EVENT))
  } catch { /* 浏览器禁用存储时仅失去跨会话恢复。 */ }
}

function readGitOpenTabs(sidebar: GitSidebarRuntime): GitSidebarOpenTabs | undefined {
  try { return sidebar.openTabs } catch { return undefined }
}
function readGitTabs(sidebar: GitSidebarRuntime, sessionId: string, snapshot: readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[]): readonly GitSidebarTab[] {
  try {
    if (typeof sidebar.tabsIn === 'function') return sidebar.tabsIn(sessionId)
  } catch { /* 旧版没有已装配的 Session store，回退到全局索引。 */ }
  return snapshot.filter((tab) => String(tab.sessionId) === sessionId).map((tab) => ({ id: String(tab.tabId), kind: tab.kind }))
}
function readSessionIds(value: unknown): readonly string[] {
  const record = asRecord(value)
  if (record === undefined) return []
  const result = new Set<string>()
  const byId = asRecord(record.byId)
  if (byId !== undefined) for (const sessionId of Object.keys(byId)) if (sessionId.trim() !== '') result.add(sessionId)
  for (const key of ['sessionId', 'currentSessionId', 'selectedSessionId']) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') result.add(candidate)
  }
  for (const key of ['items', 'sessions']) {
    const items = record[key]
    if (!Array.isArray(items)) continue
    for (const item of items) {
      const itemRecord = asRecord(item)
      const candidate = itemRecord?.sessionId ?? itemRecord?.id
      if (typeof candidate === 'string' && candidate.trim() !== '') result.add(candidate)
    }
  }
  return [...result]
}
function noSubscribe(): () => void { return () => undefined }
const EMPTY_GIT_OPEN_TABS: readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] = []
function noOpenTabs(): readonly { readonly sessionId: string; readonly tabId: string; readonly kind: string }[] { return EMPTY_GIT_OPEN_TABS }

export async function resolveGitWorkspaceId(remote: unknown, sessionId: string): Promise<string | undefined> {
  const api = remote as GitRemote | undefined
  const workspaces = await readWorkspaceItems(api?.workspace)
  const direct = workspaces.find((item) => item.sessionIds.includes(sessionId))
  if (direct !== undefined) return direct.workspaceId

  const session = await readCurrentSession(api?.session, sessionId)
  if (session?.workspaceId !== undefined) return session.workspaceId
  const sessionCwd = session?.cwd
  if (sessionCwd !== undefined) {
    const byPath = workspaces
      .filter((item) => item.path !== undefined && isPathWithin(sessionCwd, item.path))
      .sort((left, right) => (right.path?.length ?? 0) - (left.path?.length ?? 0))[0]
    if (byPath !== undefined) return byPath.workspaceId
  }
  if (workspaces.length === 1) return workspaces[0]?.workspaceId
  return undefined
}

async function readWorkspaceItems(api: GitWorkspaceApi | undefined): Promise<readonly WorkspaceItem[]> {
  if (api?.follow === undefined) return []
  const source = await api.follow()
  const iterator = source[Symbol.asyncIterator]()
  const first = await iterator.next()
  await iterator.return?.()
  const unwrapped = asRecord(unwrapRemoteValue(first.value))
  const value = Array.isArray(unwrapped?.items) ? unwrapped : asRecord(unwrapped?.value)
  const items = Array.isArray(value?.items) ? value.items : []
  return items.flatMap((item) => {
    const record = asRecord(item)
    const workspaceId = record?.workspaceId
    if (typeof workspaceId !== 'string' || workspaceId.trim() === '') return []
    const rawSessionIds = record?.sessionIds
    const sessionIds = Array.isArray(rawSessionIds)
      ? rawSessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string')
      : []
    const path = typeof record?.path === 'string' && record.path.trim() !== '' ? record.path : undefined
    return [{ workspaceId, sessionIds, ...(path === undefined ? {} : { path }) }]
  })
}

interface WorkspaceItem { readonly workspaceId: string; readonly path?: string; readonly sessionIds: readonly string[] }
interface SessionItem { readonly workspaceId?: string; readonly cwd?: string }
async function readCurrentSession(api: GitSessionApi | undefined, sessionId: string): Promise<SessionItem | undefined> {
  if (api?.list === undefined) return undefined
  const result = asRecord(unwrapRemoteValue(await api.list({})))
  const items = Array.isArray(result?.items) ? result.items : []
  const session = asRecord(items.find((item) => asRecord(item)?.sessionId === sessionId))
  if (session === undefined) return undefined
  const workspaceId = typeof session.workspaceId === 'string' && session.workspaceId.trim() !== '' ? session.workspaceId : undefined
  const cwd = typeof session.cwd === 'string' && session.cwd.trim() !== '' ? session.cwd : undefined
  return workspaceId === undefined && cwd === undefined ? {} : { ...(workspaceId === undefined ? {} : { workspaceId }), ...(cwd === undefined ? {} : { cwd }) }
}
function isPathWithin(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizePath(candidate)
  const normalizedParent = normalizePath(parent)
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`)
}
function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+/u, '/')
  const withoutTrailingSlash = normalized.replace(/\/+$/u, '')
  const result = withoutTrailingSlash || '/'
  return /^[A-Za-z]:\//u.test(result) ? result.toLowerCase() : result
}
function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined }
function unwrapRemoteValue(value: unknown): unknown {
  const record = asRecord(value)
  if (record === undefined || typeof record.ok !== 'boolean') return value
  return record.ok ? record.value : undefined
}
function cacheKey(workspaceId: string): string { return `codingns4dsh.git.${workspaceId}` }
function readCache(workspaceId: string): GitPanelCache | null { try { const value = JSON.parse(localStorage.getItem(cacheKey(workspaceId)) ?? 'null') as { status?: GitStatus; history?: readonly GitHistoryItem[]; historyTotalCount?: number; branches?: GitBranchSnapshot | null } | null; if (!value?.status || typeof value.historyTotalCount !== 'number') return null; return { status: value.status, history: value.history ?? [], historyTotalCount: value.historyTotalCount, branches: normalizeBranchSnapshot(value.branches ?? null) } } catch { return null } }
function writeCache(workspaceId: string, value: GitPanelCache): void { try { localStorage.setItem(cacheKey(workspaceId), JSON.stringify(value)) } catch { /* 浏览器禁用存储时仅失去缓存 */ } }
function normalizeBranchSnapshot(value: GitBranchSnapshot | null): GitBranchSnapshot | null {
  if (value === null) return null
  const normalize = (item: GitBranchSnapshot['local'][number], fallbackRemote: boolean): GitBranchSnapshot['local'][number] | null => {
    const rawName = typeof item.name === 'string' ? item.name.trim() : ''
    if (rawName === '') return null
    const fields = rawName.split(/%x1f/iu)
    const name = (fields[0] ?? '').trim()
    if (name === '') return null
    const upstream = (fields[2] ?? item.upstream ?? '').trim()
    return { name, current: item.current || fields[1] === '*', upstream: upstream || null, remote: item.remote || fallbackRemote || name.startsWith('refs/remotes/') }
  }
  const local = value.local.flatMap((item) => {
    const normalized = normalize(item, false)
    return normalized?.remote === true ? [] : normalized === null ? [] : [normalized]
  })
  const remote = value.remote.flatMap((item) => {
    const normalized = normalize(item, true)
    return normalized === null ? [] : [normalized]
  })
  const currentFields = value.currentBranch.split(/%x1f/iu)
  const currentBranch = (currentFields[0] ?? value.currentBranch).trim() || 'HEAD'
  return { currentBranch, local, remote }
}
async function call<T = unknown>(rpc: CodingNsRpcClient, endpoint: string, payload: unknown): Promise<T> { let result: CodingNsRpcResult; try { result = await rpc.call(CODINGNS_RPC_CHANNEL, endpoint, payload) } catch (error) { if (!/HTTP (?:404|405)\b/u.test(error instanceof Error ? error.message : String(error))) throw error; result = await rpc.call('/api', `codingns/${endpoint}`, payload) } if (!result.ok) throw new Error(result.error.message); return result.value as T }
async function copyText(value: string): Promise<boolean> { try { if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') return false; await navigator.clipboard.writeText(value); return true } catch { return false } }
function formatDate(value: string): string {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return value
  const parts = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp)
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? ''
  return `${get('month')}月${get('day')}日 ${get('hour')}:${get('minute')}`
}
function buildCommitMessageText(subject: string, body: string): string { const normalizedSubject = subject.trim(); const normalizedBody = body.trim(); return normalizedBody ? `${normalizedSubject}\n\n${normalizedBody}` : normalizedSubject }

const panelStyle: CSSProperties = { position: 'relative', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12, minHeight: '100%', padding: '16px 18px 24px', overflow: 'auto', background: dshThemeColor.pageBackground, color: dshThemeColor.labelPrimary }
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingBottom: 10, borderBottom: `1px solid ${dshThemeColor.border}` }
const titleStyle: CSSProperties = { margin: 0, fontSize: 20, lineHeight: 1.2 }
const tabTitleStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', minWidth: 0, color: dshThemeColor.labelPrimary, fontSize: 12 }
const headerActionsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4 }
const branchStyle: CSSProperties = { marginTop: 4, overflow: 'hidden', color: dshThemeColor.labelSecondary, fontSize: 12, textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const summaryStyle: CSSProperties = { color: dshThemeColor.labelSecondary, fontSize: 12 }
const contentGridStyle: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', alignItems: 'start', gap: 12 }
const columnStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }
const sectionStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, border: `1px solid ${dshThemeColor.border}`, borderRadius: 6, background: dshThemeColor.menuBackground }
const sectionHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, fontSize: 12 }
const treeStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 1 }
const treeDirectoryStyle: CSSProperties = { minWidth: 0 }
const treeRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 7, minHeight: 28, fontSize: 12 }
const treeChevronStyle: CSSProperties = { width: 12, color: dshThemeColor.labelTertiary, fontSize: 12 }
const folderIconStyle: CSSProperties = { color: dshThemeColor.accent, fontSize: 11 }
const fileIconStyle: CSSProperties = { width: 12, color: dshThemeColor.labelTertiary, fontSize: 12, textAlign: 'center' }
const fileNameStyle: CSSProperties = { minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const fileStatusStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontFamily: 'monospace', fontSize: 11 }
const historyRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 28, fontSize: 12 }
const hashStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const rowActionsStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 2, flex: '0 0 auto' }
const iconButtonStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: 0, borderRadius: 4, padding: 0, color: dshThemeColor.labelSecondary, background: 'transparent', cursor: 'pointer', fontSize: 16 }
const dangerIconButtonStyle: CSSProperties = { ...iconButtonStyle, color: dshThemeColor.error }
const mutedStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const emptyStyle: CSSProperties = { padding: 16, color: dshThemeColor.labelSecondary, fontSize: 12 }
const diffOverlayStyle: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, boxSizing: 'border-box', background: 'color-mix(in srgb, #000 28%, transparent)' }
const diffStyle: CSSProperties = { ...sectionStyle, width: 'min(1000px, 100%)', maxHeight: 'min(88vh, 760px)', overflow: 'hidden', boxShadow: dshThemeColor.subtleShadow }
const diffBodyStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0, overflow: 'auto', paddingRight: 2 }
const diffFilesSectionStyle: CSSProperties = { ...sectionStyle, gap: 6, padding: 10, background: dshThemeColor.pageBackground }
const diffDiffSectionStyle: CSSProperties = { ...sectionStyle, gap: 6, padding: 10, background: dshThemeColor.pageBackground }
const diffSectionHeaderStyle: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, fontSize: 12 }
const diffCountStyle: CSSProperties = { minWidth: 20, padding: '2px 6px', borderRadius: 10, color: dshThemeColor.labelSecondary, background: dshThemeColor.menuBackground, fontSize: 11, textAlign: 'center' }
const diffFileListStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 2 }
const diffFileRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, padding: '4px 6px', borderRadius: 4, background: dshThemeColor.menuBackground, fontSize: 12 }
const diffFileStatusStyle: CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 42, flex: '0 0 auto', color: dshThemeColor.accent, fontSize: 11, fontWeight: 700 }
const diffFileNameStyle: CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1, overflow: 'hidden' }
const diffFileOldPathStyle: CSSProperties = { overflow: 'hidden', color: dshThemeColor.labelTertiary, textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }
const diffBinaryStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const diffTruncatedStyle: CSSProperties = { color: dshThemeColor.labelTertiary, fontSize: 11 }
const diffEmptyStyle: CSSProperties = { padding: 10, color: dshThemeColor.labelTertiary, fontSize: 12 }
const diffLinesStyle: CSSProperties = { overflow: 'auto', border: `1px solid ${dshThemeColor.border}`, borderRadius: 4, background: dshThemeColor.pageBackground, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }
const diffLineBaseStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '42px 42px minmax(0, 1fr)', minHeight: 21, alignItems: 'stretch', padding: '0 8px', whiteSpace: 'pre', overflowWrap: 'normal', lineHeight: 1.5 }
const diffLineNumberStyle: CSSProperties = { paddingRight: 8, color: dshThemeColor.labelTertiary, borderRight: `1px solid ${dshThemeColor.border}`, textAlign: 'right', userSelect: 'none' }
const diffCodeStyle: CSSProperties = { minWidth: 0, paddingLeft: 10, color: 'inherit', font: 'inherit', overflow: 'visible' }
const commitSectionStyle: CSSProperties = { ...sectionStyle, gap: 14, padding: '16px 14px 12px' }
const commitEditorRowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const commitSubjectStyle: CSSProperties = { width: '100%', minHeight: 30, boxSizing: 'border-box', resize: 'none', border: 0, outline: 'none', padding: '3px 0', color: dshThemeColor.labelPrimary, background: 'transparent', font: 'inherit', fontSize: 16 }
const draftButtonStyle: CSSProperties = { ...iconButtonStyle, width: 30, height: 30, color: dshThemeColor.labelSecondary, fontSize: 21 }
const commitActionsStyle: CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }
const refreshActionStyle: CSSProperties = { minHeight: 30, border: 0, borderRadius: 5, background: 'transparent', color: dshThemeColor.labelSecondary, cursor: 'pointer', fontSize: 13 }
const submitActionStyle: CSSProperties = { ...refreshActionStyle, color: dshThemeColor.accent, fontWeight: 600 }
const primaryButtonStyle: CSSProperties = { minHeight: 28, border: 0, borderRadius: 5, padding: '4px 9px', color: '#fff', background: dshThemeColor.accent, cursor: 'pointer', fontSize: 12 }
const branchSelectStyle: CSSProperties = { maxWidth: 150, border: `1px solid ${dshThemeColor.border}`, borderRadius: 4, padding: '3px 5px', color: dshThemeColor.labelSecondary, background: dshThemeColor.pageBackground, fontSize: 11 }
const loadMoreButtonStyle: CSSProperties = { minHeight: 30, border: `1px solid ${dshThemeColor.border}`, borderRadius: 5, padding: '4px 9px', color: dshThemeColor.labelSecondary, background: 'transparent', cursor: 'pointer', fontSize: 12 }
const menuStyle: CSSProperties = { position: 'relative', flex: '0 0 auto' }
const menuSummaryStyle: CSSProperties = { listStyle: 'none', cursor: 'pointer', padding: '0 4px', color: dshThemeColor.labelSecondary, fontSize: 16 }
const menuPopupStyle: CSSProperties = { position: 'absolute', right: 0, zIndex: 2, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 100, padding: 4, border: `1px solid ${dshThemeColor.border}`, borderRadius: 5, background: dshThemeColor.menuBackground, boxShadow: dshThemeColor.subtleShadow }
const menuButtonStyle: CSSProperties = { border: 0, padding: '5px 7px', color: dshThemeColor.labelPrimary, background: 'transparent', textAlign: 'left', cursor: 'pointer', fontSize: 11 }
const dangerMenuButtonStyle: CSSProperties = { ...menuButtonStyle, color: dshThemeColor.error }

export const gitManagementFeature: CodingNsClientFeatureModule = {
  descriptor: {
    name: 'gitManagement', version: '0.1.0', enabledByDefault: true, dependencies: [], runtime: 'client',
    ui: { label: 'Git 仓库管理', description: '在右侧 Sidebar 标签页查看提交、暂存文件、未提交文件和 Git 版本历史。', order: 40, defaultOpen: false },
  },
  start(context) {
    const uiContext = context.services.uiContext
    if (uiContext === undefined) throw new Error('Git 管理模块缺少 DSH UI 上下文')
    context.resources.add(registerGitManagementUi(uiContext, { rpc: context.services.rpc, remote: context.services.remote }))
  },
}
