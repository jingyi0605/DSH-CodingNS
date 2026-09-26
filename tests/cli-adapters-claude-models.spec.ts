import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ClaudeCodeDriver } from '../data/build/dist/host/cli-adapters/claude-driver.js'

function fakeClaudeProcess(output: string, code = 0): unknown {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    stdin: { end(value: string): void }
    kill(): boolean
  }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdin = { end() {
    queueMicrotask(() => {
      if (output) child.stdout.write(output)
      child.stdout.end()
      child.stderr.end()
      child.emit('close', code)
    })
  } }
  child.kill = () => true
  return child
}

test('Claude Code 通过 initialize、网关和 settings.json 合并真实模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-models-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://gateway.example/v1',
    ANTHROPIC_AUTH_TOKEN: 'secret-token',
    ANTHROPIC_MODEL: 'deepseek/deepseek-chat',
  } }), 'utf8')
  const initialize = JSON.stringify({ type: 'control_response', response: {
    subtype: 'success', request_id: 'codingns-model-discovery', response: { models: [
      { value: 'default', displayName: 'Default' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', supportedEffortLevels: ['high'] },
    ] },
  } }) + '\n'
  const calls: string[] = []
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: ((command: string, args: string[]) => { calls.push(`${command} ${args.join(' ')}`); return fakeClaudeProcess(initialize) }) as never,
      fetch: (async (url: string, init?: RequestInit) => {
        assert.equal(url, 'https://gateway.example/v1/models')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-token')
        assert.equal(new Headers(init?.headers).get('x-api-key'), 'secret-token')
        return new Response(JSON.stringify({ data: [{ id: 'gateway-sonnet', display_name: 'Gateway Sonnet' }] }), { status: 200 })
      }) as typeof fetch,
    })
    const catalog = await driver.listModels()
    const models = catalog.groups[0]?.models ?? []
    assert.deepEqual(models.map((model) => model.id), ['provider-default', 'sonnet', 'opus', 'haiku', 'claude-opus-4-8', 'gateway-sonnet', 'deepseek/deepseek-chat'])
    assert.equal(models.find((model) => model.id === 'claude-opus-4-8')?.efforts.join(','), 'high')
    assert.doesNotMatch(JSON.stringify(catalog), /secret-token/u)
    assert.equal(calls.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 动态发现失败时回退静态别名并保留配置模型', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codingns-claude-models-fallback-'))
  const configDir = join(root, '.claude')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek/deepseek-reasoner', ANTHROPIC_BASE_URL: 'https://gateway.example' } }), 'utf8')
  try {
    const driver = new ClaudeCodeDriver({
      binaries: ['fake-claude'],
      claudeConfigDir: configDir,
      spawnSync: ((command: string, args: string[]) => args[0] === '--version'
        ? { status: 0, stdout: 'claude 1.0.0', stderr: '' }
        : { status: 1, stdout: '', stderr: '' }) as never,
      spawn: (() => fakeClaudeProcess('', 1)) as never,
      fetch: (async () => { throw new Error('gateway unavailable') }) as typeof fetch,
    })
    const ids = (await driver.listModels()).groups[0]?.models.map((model) => model.id) ?? []
    assert.deepEqual(ids, ['provider-default', 'sonnet', 'opus', 'haiku', 'deepseek/deepseek-reasoner'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Claude Code 未安装时不伪造模型目录', async () => {
  const driver = new ClaudeCodeDriver({
    binaries: ['missing-claude'],
    spawnSync: (() => { throw new Error('missing') }) as never,
  })
  assert.deepEqual(await driver.listModels(), { groups: [], currentModel: null, currentEffort: null })
})
