import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { createCodingNsRpcHandler } from '../data/build/dist/host/rpc.js'
import { CodingNsRpcTable } from '../data/build/dist/host/rpc-table.js'
import { createGitManagementFeature } from '../data/build/dist/host/features/git-management.js'

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

test('Git Client 与 Host 接线包含侧栏面板和所有版本 RPC', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { dsh: { client: { inject: string[] } } }
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'))
  assert.ok(packageJson.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'))
  const source = await readFile(new URL('../src/client/git-management.ts', import.meta.url), 'utf8')
  const hostRpc = await readFile(new URL('../src/host/rpc.ts', import.meta.url), 'utf8')
  for (const marker of ['sidebar.panellist', 'name: \'main\'', 'git/status', 'git/commit', 'git/history', 'git/branches', 'git/${action}']) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
  for (const marker of ['git/status', 'git/init', 'git/diff', 'git/stage', 'git/unstage', 'git/discard', 'git/commit', 'git/history', 'git/branches', 'git/switch']) {
    assert.match(hostRpc, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  }
})
