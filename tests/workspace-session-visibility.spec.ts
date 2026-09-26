import assert from 'node:assert/strict'
import test from 'node:test'
import {
  WORKSPACE_SESSION_HIDDEN_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE,
  WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE,
  startWorkspaceSessionVisibilityDom,
} from '../data/build/dist/client/workspace-session-visibility-dom.js'
import { loadWorkspaceRecords } from '../data/build/dist/client/workspace-session-archive-dom.js'

test('工作区基线读取保留标题并兼容缺少标题的旧记录', async () => {
  const records = await loadWorkspaceRecords({
    workspace: {
      async *follow() {
        yield {
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', path: '/repo/a', title: '项目 A', sessionIds: [] },
              { workspaceId: 'workspace-b', path: '/repo/b', sessionIds: [] },
            ],
            archivedSessionIds: [],
          },
        }
      },
    },
  })
  assert.deepEqual(records.map((record) => ({ id: record.workspaceId, title: record.title })), [
    { id: 'workspace-a', title: '项目 A' },
    { id: 'workspace-b', title: '/repo/b' },
  ])
})

test('工作区菜单注入隐藏动作，底部列表支持恢复且销毁时还原原生节点', async () => {
  const root = new FakeElement('div')
  root.setAttribute('role', 'tree')
  const workspaceA = workspaceRow('workspace-a', '项目 A')
  const workspaceB = workspaceRow('workspace-b', '项目 B')
  root.append(workspaceA.container, workspaceB.container)
  const dom = new FakeDocument(root)
  const remote = {
    workspace: {
      async *follow() {
        yield {
          type: 'baseline',
          value: {
            items: [
              { workspaceId: 'workspace-a', path: '/repo/a', title: '项目 A', sessionIds: [] },
              { workspaceId: 'workspace-b', path: '/repo/b', title: '项目 B', sessionIds: [] },
            ],
            archivedSessionIds: [],
          },
        }
      },
    },
  }
  let observer
  class FakeObserver {
    constructor(callback) {
      this.callback = callback
      observer = this
    }
    observe() {}
    disconnect() {}
    trigger(target) { this.callback([{ target }], this) }
  }
  const persisted = []
  const controller = startWorkspaceSessionVisibilityDom({
    document: dom,
    MutationObserver: FakeObserver,
    remote,
    hiddenWorkspaceIds: ['workspace-b'],
    onHiddenWorkspaceIdsChange(ids) { persisted.push([...ids]) },
  })
  await nextTurn()

  assert.equal(workspaceB.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), true)
  assert.equal(workspaceA.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), false)
  const footer = dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)
  assert.ok(footer)
  assert.match(footer.querySelector('button').textContent, /隐藏的工作区 1/u)

  workspaceA.menuTrigger.dispatch('pointerdown')
  const menu = new FakeElement('div')
  menu.setAttribute('role', 'menu')
  root.appendChild(menu)
  observer.trigger(menu)
  await nextTurn()
  const hideAction = menu.querySelector(`[${WORKSPACE_SESSION_HIDDEN_MENU_ATTRIBUTE}]`)
  assert.ok(hideAction)
  hideAction.dispatch('click')
  assert.deepEqual(persisted.at(-1), ['workspace-b', 'workspace-a'])
  assert.equal(workspaceA.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), true)

  const currentFooter = dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`)
  const toggle = currentFooter?.querySelector('button')
  assert.ok(toggle)
  toggle.dispatch('click')
  const restore = currentFooter?.querySelector('[role="menuitem"]')
  assert.ok(restore)
  restore.dispatch('click')
  assert.deepEqual(persisted.at(-1), ['workspace-b'])
  assert.equal(workspaceA.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), false)

  controller.dispose()
  assert.equal(workspaceB.container.hasAttribute(WORKSPACE_SESSION_HIDDEN_ATTRIBUTE), false)
  assert.equal(dom.querySelector(`[${WORKSPACE_SESSION_HIDDEN_LIST_ATTRIBUTE}]`), null)
})

function workspaceRow(id, title) {
  const container = new FakeElement('section')
  const header = new FakeElement('div')
  header.setAttribute('role', 'treeitem')
  header.setAttribute('aria-expanded', 'true')
  attachWorkspaceFiber(header, id)
  const menuTrigger = new FakeElement('button')
  menuTrigger.setAttribute('aria-haspopup', 'menu')
  menuTrigger.setAttribute('aria-label', `${title} 菜单`)
  header.append(menuTrigger)
  const session = new FakeElement('div')
  session.setAttribute('role', 'treeitem')
  container.append(header, session)
  return { container, header, menuTrigger }
}

function attachWorkspaceFiber(element, workspaceId) {
  Object.defineProperty(element, '__reactFiber$test', {
    configurable: true,
    value: { memoizedProps: { workspace: { workspaceId } } },
  })
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve))
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase()
    this.children = []
    this.parentElement = null
    this.attributes = new Map()
    this.dataset = {}
    this.style = {}
    this.hidden = false
    this.textContent = ''
    this.title = ''
    this.listeners = new Map()
  }
  append(...children) { for (const child of children) this.appendChild(child) }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child }
  insertBefore(child, before) { child.parentElement = this; const index = before === null ? -1 : this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child }
  remove() { if (this.parentElement === null) return; this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.parentElement = null }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  hasAttribute(name) { return this.attributes.has(name) }
  removeAttribute(name) { this.attributes.delete(name) }
  contains(node) { return node === this || this.children.some((child) => child.contains(node)) }
  addEventListener(type, listener) { const handlers = this.listeners.get(type) ?? []; handlers.push(listener); this.listeners.set(type, handlers) }
  dispatch(type) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this }) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  querySelectorAll(selector) {
    const matches = []
    const visit = (node) => {
      if (selectorMatches(node, selector)) matches.push(node)
      for (const child of node.children) visit(child)
    }
    visit(this)
    return matches
  }
  closest(selector) { let current = this; while (current !== null) { if (selectorMatches(current, selector)) return current; current = current.parentElement } return null }
}

class FakeDocument {
  constructor(root) {
    this.documentElement = new FakeElement('html')
    this.body = new FakeElement('body')
    this.documentElement.appendChild(this.body)
    this.body.appendChild(root)
  }
  createElement(tagName) { return new FakeElement(tagName) }
  querySelector(selector) { return this.documentElement.querySelector(selector) }
  querySelectorAll(selector) { return this.documentElement.querySelectorAll(selector) }
}

function selectorMatches(element, selector) {
  return selector.split(',').some((part) => {
    const value = part.trim()
    if (value === 'button') return element.tagName === 'BUTTON'
    if (value === '[role="button"]') return element.getAttribute('role') === 'button'
    if (value === '[role="menu"]') return element.getAttribute('role') === 'menu'
    if (value === '[role="menuitem"]') return element.getAttribute('role') === 'menuitem'
    if (value === '[role="treeitem"][aria-expanded]') return element.getAttribute('role') === 'treeitem' && element.hasAttribute('aria-expanded')
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/u.exec(value)
    return attribute !== null && element.hasAttribute(attribute[1]) && (attribute[2] === undefined || element.getAttribute(attribute[1]) === attribute[2])
  })
}
