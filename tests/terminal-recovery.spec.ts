import assert from 'node:assert/strict'
import test from 'node:test'
import { createTerminalSessionRecovery } from '../data/build/dist/client/terminal/recovery.js'

const terminal = (id: string) => ({
  id,
  title: '终端',
  shell: { path: '/bin/zsh', args: ['-i'], name: 'zsh' },
  cwd: '/workspace',
  cols: 80,
  rows: 24,
  state: 'running',
  exitCode: null,
})

test('工作区终端在新会话的 Sidebar 缺少标签时只补一次并复用 Host 身份', async () => {
  const tabs = new Map<string, { id: string; kind: string }[]>()
  const opened: Array<{ sessionId: string; terminalId: string }> = []
  let recoverCalls = 0
  const sidebar = {
    tabsIn: (sessionId: string) => tabs.get(sessionId) ?? [],
    openTabIn: (sessionId: string, kind: string, options?: { params?: { terminalId?: string } }) => {
      assert.equal(kind, 'terminal')
      const tab = { id: `tab-${opened.length + 1}`, kind }
      tabs.set(sessionId, [...(tabs.get(sessionId) ?? []), tab])
      opened.push({ sessionId, terminalId: options?.params?.terminalId ?? '' })
    },
  }
  const recovery = createTerminalSessionRecovery({
    async recover() {
      recoverCalls += 1
      return [terminal('workspace-terminal')]
    },
  }, sidebar, 'terminal')

  await Promise.all([recovery.ensure('session-a'), recovery.ensure('session-a')])
  await recovery.ensure('session-b')

  assert.equal(recoverCalls, 2)
  assert.deepEqual(opened, [
    { sessionId: 'session-a', terminalId: 'workspace-terminal' },
    { sessionId: 'session-b', terminalId: 'workspace-terminal' },
  ])
})

test('已有带 terminalId 的 Sidebar 标签不会被恢复逻辑重复打开', async () => {
  let opened = 0
  const sidebar = {
    tabsIn: () => [{ id: 'tab-1', kind: 'terminal' }],
    tabDomain: {
      occurrence: () => ({ navigation: { getSnapshot: () => ({ params: { terminalId: 'workspace-terminal' } }) } }),
    },
    openTabIn: () => { opened += 1 },
  }
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('workspace-terminal')] },
  }, sidebar, 'terminal')

  await recovery.ensure('session-a')
  assert.equal(opened, 0)
})

test('旧版没有导航参数的终端标签仍按已有标签处理', async () => {
  let opened = 0
  const recovery = createTerminalSessionRecovery({
    async recover() { return [terminal('workspace-terminal')] },
  }, {
    tabsIn: () => [{ id: 'tab-1', kind: 'terminal' }],
    openTabIn: () => { opened += 1 },
  }, 'terminal')

  await recovery.ensure('session-a')
  assert.equal(opened, 0)
})
