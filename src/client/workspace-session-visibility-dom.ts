import {
  findWorkspaceContainer,
  findWorkspaceHeaders,
  loadWorkspaceRecords,
  resolveWorkspaceId,
  type WorkspaceRecord,
} from './workspace-session-archive-dom.js'

/** 工作区隐藏注入节点的标记，便于重复扫描和停用时完整清理。 */
export const WORKSPACE_SESSION_HIDDEN_ATTRIBUTE = 'data-codingns-hidden-workspace'
export const WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE = 'data-codingns-hidden-workspace-menu'
export const WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE = 'data-codingns-hidden-workspaces'
const WORKSPACE_SESSION_HIDDEN_MENU_WORKSPACE_ATTRIBUTE = 'data-codingns-hidden-workspace-id'

const MENU_ATTRIBUTE = 'aria-haspopup'
const WORKSPACE_MENU_PATTERN = /(?:更多|菜单|选项|more|menu|option)/iu

export interface WorkspaceSessionVisibilityDomController {
  /** 重新读取工作区并同步侧栏 DOM。 */
  refresh(): void
  /** 设置当前隐藏的工作区 ID，并触发一次扫描。 */
  setHiddenWorkspaceIds(ids: readonly string[]): void
  /** 断开观察器并恢复所有被插件隐藏的节点。 */
  dispose(): void
}

export interface WorkspaceSessionVisibilityDomOptions {
  readonly document?: Document
  readonly MutationObserver?: typeof MutationObserver
  readonly remote?: unknown
  readonly hiddenWorkspaceIds?: readonly string[]
  /** 持久化由功能模块完成；回调失败时控制器会恢复上一次可见状态。 */
  readonly onHiddenWorkspaceIdsChange?: (ids: readonly string[]) => Promise<void> | void
}

/**
 * 给原生工作区菜单增加隐藏动作，并在工作区列表底部渲染恢复入口。
 *
 * DSH 当前版本没有公开工作区可见性 API，因此这里仅隐藏原生 DOM，工作区
 * 本身仍由 DSH Workspace Controller 管理；隐藏 ID 存在 Codingns4DSH 设置中。
 */
export function startWorkspaceSessionVisibilityDom(
  options: WorkspaceSessionVisibilityDomOptions = {},
): WorkspaceSessionVisibilityDomController {
  const dom = options.document ?? (typeof document === 'undefined' ? undefined : document)
  const Observer = options.MutationObserver
    ?? (typeof MutationObserver === 'undefined' ? undefined : MutationObserver)
  const remote = options.remote
  let hiddenWorkspaceIds = new Set(normalizeIds(options.hiddenWorkspaceIds ?? []))
  let workspaces: readonly WorkspaceRecord[] = []
  let disposed = false
  let scanQueued = false
  let loading: Promise<void> | undefined
  let activeMenuWorkspaceId: string | undefined
  let changeSequence = 0
  const menuWorkspaceIds = new WeakMap<HTMLElement, string>()

  const persist = options.onHiddenWorkspaceIdsChange
  const updateVisibility = (workspaceId: string, hidden: boolean): void => {
    const previous = [...hiddenWorkspaceIds]
    const change = ++changeSequence
    const next = new Set(previous)
    if (hidden) next.add(workspaceId)
    else next.delete(workspaceId)
    const normalized = normalizeIds([...next])
    hiddenWorkspaceIds = new Set(normalized)
    scan()
    if (persist === undefined) return
    Promise.resolve(persist(normalized)).catch(() => {
      if (change !== changeSequence) return
      hiddenWorkspaceIds = new Set(previous)
      scan()
    })
  }

  const refreshData = async (): Promise<void> => {
    if (disposed) return
    if (loading !== undefined) {
      await loading
      return
    }
    loading = loadWorkspaceRecords(remote).then((next) => {
      if (disposed) return
      workspaces = next
      scan()
    }).catch(() => undefined).finally(() => {
      loading = undefined
    })
    await loading
  }

  const scan = (): void => {
    if (disposed || dom === undefined) return
    observer?.disconnect()
    try {
      clearHiddenWorkspaceNodes(dom)
      removeVisibilityEntries(dom)
      const headers = findWorkspaceHeaders(dom)
      const workspaceIds = new Set(workspaces.map((workspace) => workspace.workspaceId))
      for (const header of headers) {
        const workspaceId = resolveWorkspaceId(header)
        if (workspaceId === undefined) continue
        workspaceIds.add(workspaceId)
        bindWorkspaceMenuTriggers(header, workspaceId, () => {
          activeMenuWorkspaceId = workspaceId
          // 菜单由 DSH 在点击事件后异步挂载到 Portal；在事件队列结束后再扫描，
          // 避免在宿主菜单尚未完成打开时同步改写它的 DOM。
          scheduleScan()
        })
        if (hiddenWorkspaceIds.has(workspaceId)) markWorkspaceHidden(header, workspaceId)
      }
      injectMenuActions(dom, activeMenuWorkspaceId, workspaceIds, menuWorkspaceIds, (workspaceId) => updateVisibility(workspaceId, true))
      if (dom.querySelectorAll<HTMLElement>('[role="menu"]').length > 0) activeMenuWorkspaceId = undefined
      injectHiddenWorkspaceFooter(dom, headers, workspaces, hiddenWorkspaceIds, (workspaceId) => updateVisibility(workspaceId, false))
    } finally {
      if (!disposed && observer !== undefined && dom.documentElement !== null) {
        observer.observe(dom.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
      }
    }
  }

  const scheduleScan = (mutations: readonly MutationRecord[] = []): void => {
    if (disposed || scanQueued) return
    // 展开恢复列表也使用 aria-expanded；忽略插件自身的属性变化，避免每次
    // 点击列表都被观察器重建成收起状态。
    if (mutations.length > 0 && mutations.every((mutation) => (
      isVisibilityMutation(mutation.target) || isNativeMenuMutation(mutation.target)
    ))) return
    scanQueued = true
    queueMicrotask(() => {
      scanQueued = false
      scan()
    })
  }

  const observer = dom === undefined || Observer === undefined
    ? undefined
    : new Observer(scheduleScan)
  if (observer !== undefined && dom !== undefined) {
    observer.observe(dom.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-expanded'] })
  }

  scan()
  void refreshData()

  return {
    refresh() {
      scheduleScan()
      void refreshData()
    },
    setHiddenWorkspaceIds(ids) {
      changeSequence += 1
      hiddenWorkspaceIds = new Set(normalizeIds(ids))
      scheduleScan()
    },
    dispose() {
      if (disposed) return
      disposed = true
      observer?.disconnect()
      if (dom !== undefined) {
        clearHiddenWorkspaceNodes(dom)
        removeVisibilityEntries(dom)
        removeMenuEntries(dom)
      }
    },
  }
}

function isVisibilityMutation(target: Node): boolean {
  return typeof Element !== 'undefined' && target instanceof Element
    && (target.closest(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`) !== null
      || target.closest(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`) !== null)
}

function isNativeMenuMutation(target: Node): boolean {
  return typeof Element !== 'undefined'
    && target instanceof Element
    && target.closest('[role="menu"]') !== null
}

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.flatMap((value) => {
    const normalized = typeof value === 'string' ? value.trim() : ''
    return normalized === '' ? [] : [normalized]
  }))]
}

function bindWorkspaceMenuTriggers(header: HTMLElement, workspaceId: string, rememberWorkspace: () => void): void {
  const elements = [header, ...header.querySelectorAll<HTMLElement>('button,[role="button"]')]
  for (const element of elements) {
    if (element === header || !isWorkspaceMenuTrigger(element)) continue
    if (element.getAttribute('data-codingns-hidden-menu-bound') === workspaceId) continue
    element.setAttribute('data-codingns-hidden-menu-bound', workspaceId)
    element.addEventListener('pointerdown', rememberWorkspace)
    element.addEventListener('click', rememberWorkspace)
  }
}

function isWorkspaceMenuTrigger(element: HTMLElement): boolean {
  if (element.getAttribute(MENU_ATTRIBUTE) === 'menu') return true
  const label = `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''} ${element.title}`.replace(/\s+/gu, ' ')
  return WORKSPACE_MENU_PATTERN.test(label)
}

function injectMenuActions(
  dom: Pick<Document, 'querySelectorAll' | 'createElement'>,
  activeWorkspaceId: string | undefined,
  workspaceIds: ReadonlySet<string>,
  menuWorkspaceIds: WeakMap<HTMLElement, string>,
  onHide: (workspaceId: string) => void,
): void {
  for (const menu of dom.querySelectorAll<HTMLElement>('[role="menu"]')) {
    const workspaceId = activeWorkspaceId ?? resolveWorkspaceId(menu) ?? menuWorkspaceIds.get(menu)
    if (workspaceId === undefined) continue
    if (!workspaceIds.has(workspaceId)) continue
    menuWorkspaceIds.set(menu, workspaceId)
    const existing = menu.querySelector<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)
    if (existing?.getAttribute(WORKSPACE_SESSION_HIDDEN_MENU_WORKSPACE_ATTRIBUTE) === workspaceId) continue
    existing?.remove()
    const action = dom.createElement('button')
    action.type = 'button'
    action.setAttribute('role', 'menuitem')
    action.setAttribute(WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE, '')
    action.setAttribute(WORKSPACE_SESSION_HIDDEN_MENU_WORKSPACE_ATTRIBUTE, workspaceId)
    action.setAttribute('aria-label', '隐藏工作区')
    action.textContent = '隐藏工作区'
    Object.assign(action.style, menuItemStyle)
    action.addEventListener('click', () => {
      onHide(workspaceId)
      // 隐藏动作由插件追加，DSH 菜单本身不会替它自动收起；移除当前
      // Portal 菜单可以避免用户看到已经失效的菜单项。
      menu.remove()
    })
    menu.appendChild(action)
  }
}

function injectHiddenWorkspaceFooter(
  dom: Pick<Document, 'body' | 'querySelectorAll' | 'createElement'>,
  headers: readonly HTMLElement[],
  workspaces: readonly WorkspaceRecord[],
  hiddenWorkspaceIds: ReadonlySet<string>,
  onRestore: (workspaceId: string) => void,
): void {
  const recordsById = new Map(workspaces.map((workspace) => [workspace.workspaceId, workspace]))
  for (const header of headers) {
    const workspaceId = resolveWorkspaceId(header)
    if (workspaceId !== undefined && !recordsById.has(workspaceId)) {
      recordsById.set(workspaceId, { workspaceId, title: workspaceId, sessionIds: [], archivedSessionIds: [] })
    }
  }
  // 新近隐藏的工作区排在前面，恢复入口更符合用户刚刚完成的操作顺序。
  const hidden = [...hiddenWorkspaceIds].reverse().flatMap((workspaceId) => {
    const workspace = recordsById.get(workspaceId)
    return workspace === undefined ? [] : [workspace]
  })
  if (hidden.length === 0) return
  const host = findWorkspaceListContainer(dom, headers)
  if (host === null) return
  const entry = dom.createElement('div')
  entry.setAttribute(WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE, '')
  Object.assign(entry.style, footerStyle)
  const toggle = dom.createElement('button')
  toggle.type = 'button'
  toggle.setAttribute('aria-expanded', 'false')
  toggle.setAttribute('aria-label', `隐藏的工作区 ${hidden.length}`)
  toggle.textContent = `隐藏的工作区 ${hidden.length}`
  Object.assign(toggle.style, menuItemStyle)
  const list = dom.createElement('div')
  list.hidden = true
  Object.assign(list.style, { display: 'none', flexDirection: 'column', gap: '2px', marginTop: '2px' })
  for (const workspace of hidden) {
    const restore = dom.createElement('button')
    restore.type = 'button'
    restore.setAttribute('role', 'menuitem')
    restore.setAttribute('aria-label', `恢复工作区 ${workspace.title}`)
    restore.textContent = workspace.title
    restore.title = workspace.path ?? workspace.workspaceId
    Object.assign(restore.style, menuItemStyle, { paddingLeft: '28px' })
    restore.addEventListener('click', () => onRestore(workspace.workspaceId))
    list.appendChild(restore)
  }
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true')
    list.hidden = expanded
    list.style.display = expanded ? 'none' : 'flex'
  })
  entry.append(toggle, list)
  host.appendChild(entry)
}

function markWorkspaceHidden(header: HTMLElement, workspaceId: string): void {
  const container = narrowWorkspaceContainer(header, workspaceId)
  if (container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE)) return
  container.setAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE, workspaceId)
  container.dataset.codingnsHiddenDisplay = container.style.display
  container.dataset.codingnsHiddenValue = container.hidden ? 'true' : 'false'
  container.hidden = true
  container.style.display = 'none'
}

function narrowWorkspaceContainer(header: HTMLElement, workspaceId: string): HTMLElement {
  const candidate = findWorkspaceContainer(header, workspaceId)
  if (candidate === null) return header
  const nestedHeaders = candidate.querySelectorAll('[role="treeitem"][aria-expanded]').length
  const isBroadContainer = candidate.tagName === 'BODY'
    || candidate.tagName === 'HTML'
    || candidate.getAttribute('role') === 'tree'
    || nestedHeaders > 1
  return isBroadContainer ? closestWorkspaceContainer(header) : candidate
}

function closestWorkspaceContainer(header: HTMLElement): HTMLElement {
  const parent = header.parentElement
  if (parent === null
    || parent.tagName === 'BODY'
    || parent.tagName === 'HTML'
    || parent.getAttribute('role') === 'tree'
    || parent.querySelectorAll('[role="treeitem"][aria-expanded]').length > 1) return header
  return parent
}

function clearHiddenWorkspaceNodes(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_ATTRIBUTE}]`)) {
    const display = node.dataset.codingnsHiddenDisplay ?? ''
    const hidden = node.dataset.codingnsHiddenValue === 'true'
    node.hidden = hidden
    node.style.display = display
    delete node.dataset.codingnsHiddenDisplay
    delete node.dataset.codingnsHiddenValue
    node.removeAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE)
  }
}

function removeVisibilityEntries(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)) node.remove()
}

function removeMenuEntries(dom: Pick<Document, 'querySelectorAll'>): void {
  for (const node of dom.querySelectorAll<HTMLElement>(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)) node.remove()
}

function findWorkspaceListContainer(
  dom: Pick<Document, 'body' | 'querySelectorAll'>,
  headers: readonly HTMLElement[],
): HTMLElement | null {
  const first = headers[0]
  if (first !== undefined) {
    let current: HTMLElement | null = first.parentElement
    // 只有一个工作区时，header 的直接父节点往往就是该工作区容器；
    // 再向上一层才能把恢复入口放到工作区列表本身，而不是隐藏容器内。
    if (headers.length === 1 && current?.getAttribute('role') !== 'tree') current = current?.parentElement ?? null
    for (let depth = 0; depth < 10 && current !== null; depth += 1) {
      if (current.getAttribute('role') === 'tree') return current
      if (headers.every((header) => current?.contains(header))) return current
      current = current.parentElement
    }
  }
  return dom.body ?? null
}

const menuItemStyle = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 12px',
  border: '0',
  borderRadius: '6px',
  color: 'inherit',
  background: 'transparent',
  textAlign: 'left',
  cursor: 'pointer',
  font: 'inherit',
}

const footerStyle = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  boxSizing: 'border-box',
  marginTop: '4px',
  paddingTop: '4px',
  borderTop: '1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.18))',
}
