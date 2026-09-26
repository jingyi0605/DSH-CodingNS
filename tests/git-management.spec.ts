import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { createCodingNsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createGitManagementFeature } from '../data/build/dist/host/features/git-management.js'
import { registerGitManagementUi, resolveGitWorkspaceId } from '../data/build/dist/client/git-management.js'

const execFile = promisify(execFileCallback)

interface ResourceScope {
  readonly disposers: Array<() => void | Promise<void>>
  add(disposer: () => void | Promise<void>): void
}

function startGitFeature(roots: Map<string, string>): { table: CodingNsRpcTable; resources: ResourceScope } {
  const table = new CodingNsRpcTable()
  const resources: ResourceScope = { disposers: [], add(disposer) { this.disposers.push(disposer) } }
  const feature = createGitManagementFeature()
  feature.start({
    descriptor: feature.descriptor,
    resources,
    services: { rpc: table, resolveWorkspaceRoot: (workspaceId: string) => roots.get(workspaceId) ?? null },
  })
  return { table, resources }
}

async function rpc(table: CodingNsRpcTable, endpoint: string, payload: unknown): Promise<unknown> {
  return createCodingNsRpcHandler(table)(endpoint, payload, new AbortController().signal).then((result) => {
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  })
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile('git', args, { cwd })
}

test('Git Host 模块能处理未初始化目录、状态、暂存、提交和历史', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-`)
  try {
    const roots = new Map([['workspace-1', root]])
    const { table, resources } = startGitFeature(roots)

    const empty = await rpc(table, 'git/status', { workspaceId: 'workspace-1' }) as { snapshot: { enabled?: boolean }; changes: readonly unknown[] }
    assert.equal(empty.snapshot.enabled, false)
    assert.deepEqual(empty.changes, [])

    await rpc(table, 'git/init', { workspaceId: 'workspace-1' })
    await writeFile(`${root}/README.md`, '# Git\n', 'utf8')
    const changed = await rpc(table, 'git/status', { workspaceId: 'workspace-1' }) as { changes: readonly { path: string; staged: boolean }[] }
    assert.deepEqual(changed.changes.map((item) => [item.path, item.staged]), [['README.md', false]])

    const staged = await rpc(table, 'git/stage', { workspaceId: 'workspace-1', targets: ['README.md'] }) as { changes: readonly { path: string; staged: boolean }[] }
    assert.deepEqual(staged.changes.map((item) => [item.path, item.staged]), [['README.md', true]])

    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])
    const commit = await rpc(table, 'git/commit', { workspaceId: 'workspace-1', subject: '初始化 Git 管理测试' }) as { commitHash: string }
    assert.match(commit.commitHash, /^[0-9a-f]{40}$/u)
    const history = await rpc(table, 'git/history', { workspaceId: 'workspace-1', limit: 20 }) as { items: readonly { commitHash: string; subject: string }[]; totalCount: number }
    assert.equal(history.items[0]?.commitHash, commit.commitHash)
    assert.equal(history.items[0]?.subject, '初始化 Git 管理测试')
    assert.equal(history.totalCount, 1)

    await assert.rejects(() => rpc(table, 'git/stage', { workspaceId: 'workspace-1', targets: ['../outside'] }), /Git 路径无效/u)
    for (const dispose of resources.disposers.reverse()) await dispose()
    assert.equal(table.resolve('git/status'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Host 模块拒绝不存在的 Workspace', async () => {
  const { table } = startGitFeature(new Map())
  await assert.rejects(() => rpc(table, 'git/status', { workspaceId: 'missing' }), /当前 Workspace 没有可用的本地目录/u)
})

test('Git Host 模块支持提交 Diff 和撤销最近提交', async () => {
  const root = await mkdtemp(`${tmpdir()}/codingns-git-undo-`)
  try {
    const { table } = startGitFeature(new Map([['workspace-undo', root]]))
    await rpc(table, 'git/init', { workspaceId: 'workspace-undo' })
    await git(root, ['config', 'user.name', 'CodingNS Test'])
    await git(root, ['config', 'user.email', 'codingns-test@example.invalid'])

    await writeFile(`${root}/README.md`, 'first\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-undo', targets: ['README.md'] })
    const first = await rpc(table, 'git/commit', { workspaceId: 'workspace-undo', subject: '第一次提交' }) as { commitHash: string }

    await writeFile(`${root}/README.md`, 'second\n', 'utf8')
    await rpc(table, 'git/stage', { workspaceId: 'workspace-undo', targets: ['README.md'] })
    const second = await rpc(table, 'git/commit', { workspaceId: 'workspace-undo', subject: '第二次提交' }) as { commitHash: string }

    const diff = await rpc(table, 'git/commit-diff', { workspaceId: 'workspace-undo', commitHash: second.commitHash }) as { commitHash: string; files: readonly { path: string; status: string }[]; content: string }
    assert.equal(diff.commitHash, second.commitHash)
    assert.deepEqual(diff.files, [{ path: 'README.md', oldPath: null, status: 'M', binary: false }])
    assert.match(diff.content, /second/u)

    const pagedHistory = await rpc(table, 'git/history', { workspaceId: 'workspace-undo', limit: 1, offset: 1 }) as { items: readonly { commitHash: string }[]; cursor: string; nextCursor: string | null }
    assert.equal(pagedHistory.items[0]?.commitHash, first.commitHash)
    assert.equal(pagedHistory.cursor, '1')
    assert.equal(pagedHistory.nextCursor, null)

    const undone = await rpc(table, 'git/undo', { workspaceId: 'workspace-undo' }) as { changes: readonly { path: string; staged: boolean }[] }
    assert.deepEqual(undone.changes.map((item) => [item.path, item.staged]), [['README.md', true]])
    const history = await rpc(table, 'git/history', { workspaceId: 'workspace-undo', limit: 20 }) as { items: readonly { commitHash: string }[] }
    assert.deepEqual(history.items.map((item) => item.commitHash), [first.commitHash])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Git Client 与 Host 接线包含侧栏面板和所有版本 RPC', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dsh: { client: { inject: string[] } } }
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
  const source = await readFile(new URL('../src/client/git-management.ts', import.meta.url), 'utf8')
  const hostRpc = await readFile(new URL('../src/host/rpc.ts', import.meta.url), 'utf8')
  for (const marker of ['sidebarRightTabs.register', 'sidebar.right.pane.tab', 'sidebar.right.pane.tab.title', 'git/status', 'git/commit', 'git/commit-diff', 'git/history', 'git/branches', 'git/${action}', 'buildChangeTree', 'collectTreeTargets', 'onBatchAction', '撤销目录暂存', '撤销目录变更', 'hoveredPath', 'contentGridStyle', 'commitSectionStyle', 'commitEditorRowStyle', '在这里输入提交信息', '生成提交信息', 'commitActionsStyle', '暂存全部', '查看所有版本', "onOperation('refresh')"]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  assert.match(source, /cached !== null && !historyExpanded\.current/u)
  assert.match(source, /preserveExpandedHistory = action === 'git\/status'/u)
  assert.doesNotMatch(source, /sidebar\.panellist/u)
  assert.doesNotMatch(source, /name: 'main'/u)
  assert.match(source, /String\(props\.sessionId\)/u)
  assert.doesNotMatch(source, /info\.tab\.sessionId/u)
  for (const marker of ['git/status', 'git/init', 'git/diff', 'git/stage', 'git/unstage', 'git/discard', 'git/commit', 'git/commit-diff', 'git/history', 'git/branches', 'git/switch', 'git/fetch', 'git/pull', 'git/push', 'git/undo']) {
    assert.match(hostRpc, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
})

test('Git Client 遇到热重载残留的 Sidebar 注册时保持幂等', () => {
  const ctx = {
    sidebarRight: {},
    sidebarRightTabs: {
      register: () => { throw new Error('sidebarRight: tab type id "codingns4dsh/git" is already registered') },
    },
    slots: {},
  } as unknown as Parameters<typeof registerGitManagementUi>[0]
  assert.doesNotThrow(() => registerGitManagementUi(ctx, { rpc: {} as never }))
})

test('Git Client 按当前会话归属解析 Workspace', async () => {
  const follow = (value: unknown): AsyncIterable<unknown> => (async function* () { yield value })()
  const bySessionId = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ value: { items: [{ workspaceId: 'workspace-a', path: '/work/a', sessionIds: ['session-a'] }] } }) },
  }, 'session-a')
  assert.equal(bySessionId, 'workspace-a')

  const byRemoteResult = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ ok: true, value: { items: [{ workspaceId: 'workspace-b', path: '/work/b', sessionIds: ['session-b'] }] } }) },
  }, 'session-b')
  assert.equal(byRemoteResult, 'workspace-b')

  const byCwd = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ value: { items: [
      { workspaceId: 'workspace-parent', path: '/work', sessionIds: [] },
      { workspaceId: 'workspace-child', path: 'C:\\work\\repo', sessionIds: [] },
      { workspaceId: 'workspace-similar', path: '/work/repository', sessionIds: [] },
    ] } }) },
    session: { list: async () => ({ items: [{ sessionId: 'session-c', cwd: 'C:\\work\\repo\\src' }] }) },
  }, 'session-c')
  assert.equal(byCwd, 'workspace-child')

  const bySingleWorkspaceFallback = await resolveGitWorkspaceId({
    workspace: { follow: async () => follow({ value: { items: [{ workspaceId: 'workspace-only', path: '/work/only', sessionIds: [] }] } }) },
    session: { list: async () => ({ items: [] }) },
  }, 'session-missing')
  assert.equal(bySingleWorkspaceFallback, 'workspace-only')
})
