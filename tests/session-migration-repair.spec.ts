import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import test from 'node:test'
import { repairLegacySessionLog, repairLegacySessionLogs } from '../data/build/dist/host/session-migration-repair.js'

test('自动修复裸 tool/call 并重映射后续引用', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-test-'))
  try {
    const path = join(root, 'session.v3.jsonl')
    const original = encodeNone(sampleEvents(false))
    await writeFile(path, original)

    assert.equal(await repairLegacySessionLog(path), true)
    const repaired = decodeNone(await readFile(path))
    assert.deepEqual(repaired.events.map((event) => [event.seq, event.type]), [
      [0, 'turn/start'],
      [1, 'step/start'],
      [2, 'assistant/message'],
      [3, 'tool/call'],
      [4, 'tool/result'],
    ])
    assert.deepEqual(repaired.events[4]?.sourceEventSeqs, [3])
    assert.equal((await stat(`${path}.codingns-repair-backup`)).isFile(), true)
    assert.equal((await repairLegacySessionLog(path)), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('zstd 历史日志支持多个裸调用，已有声明不会重复插入', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-zstd-'))
  try {
    const path = join(root, 'session.v3.jsonl.zstd')
    await writeFile(path, encodeZstd(sampleEvents(true)))
    assert.equal((await repairLegacySessionLogs({ root })).repaired, 1)
    const repaired = decodeZstd(await readFile(path))
    assert.deepEqual(repaired.events.filter((event) => event.type === 'assistant/message').length, 2)
    assert.deepEqual(repaired.events.filter((event) => event.type === 'tool/call').map((event) => event.seq), [3, 6])
    assert.deepEqual(repaired.events.filter((event) => event.type === 'tool/result').map((event) => event.sourceEventSeqs), [[3], [6]])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH 0.1.7 v4 日志中的裸调用也能在恢复前修复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-v4-'))
  try {
    const path = join(root, 'session.v4.jsonl.zstd')
    await writeFile(path, encodeZstd(sampleEvents(false)))
    assert.equal((await repairLegacySessionLogs({ root })).repaired, 1)
    const repaired = decodeZstd(await readFile(path))
    assert.deepEqual(repaired.events.map((event) => [event.seq, event.type]), [
      [0, 'turn/start'],
      [1, 'step/start'],
      [2, 'assistant/message'],
      [3, 'tool/call'],
      [4, 'tool/result'],
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('修复失败时保持原文件不变', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codingns-repair-failure-'))
  try {
    const path = join(root, 'session.v3.jsonl')
    const original = Buffer.from('{"type":"session"}\n{"type":"tool/call","seq":9}\n')
    await writeFile(path, original)
    await assert.rejects(() => repairLegacySessionLog(path))
    assert.deepEqual(await readFile(path), original)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

function sampleEvents(withExistingDeclaration: boolean): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [
    { type: 'session' },
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } },
    ...(withExistingDeclaration
      ? [{
          type: 'assistant/message',
          seq: 2,
          data: {
            turn: 1,
            step: 1,
            message: {
              id: 'declared-one',
              role: 'assistant',
              content: [{ type: 'tool-call', id: 'one', name: 'read', arguments: '{}' }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
            stream: [],
          },
          surfaceOp: 'append',
        }]
      : []),
    {
      type: 'tool/call',
      seq: withExistingDeclaration ? 3 : 2,
      data: { turn: 1, step: 1, callId: 'one', name: 'read', arguments: '{}' },
    },
    {
      type: 'tool/result',
      seq: withExistingDeclaration ? 4 : 3,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'one-result',
          role: 'user',
          toolCallId: 'one',
          content: [{ type: 'tool-result', toolCallId: 'one', content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId: 'one' },
        },
      },
      sourceEventSeqs: [withExistingDeclaration ? 3 : 2],
      surfaceOp: 'append',
    },
  ]
  if (!withExistingDeclaration) return events
  events.push(
    { type: 'tool/call', seq: 5, data: { turn: 1, step: 1, callId: 'two', name: 'write', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'two-result',
          role: 'user',
          toolCallId: 'two',
          content: [{ type: 'tool-result', toolCallId: 'two', content: [{ type: 'text', text: 'ok' }] }],
          source: { kind: 'tool', callId: 'two' },
        },
      },
      sourceEventSeqs: [5],
      surfaceOp: 'append',
    },
  )
  return events
}

function encodeNone(rows: readonly Record<string, unknown>[]): Buffer {
  return Buffer.from(`${rows.map((row) => `${JSON.stringify(row)}\n`).join('')}`)
}

function decodeNone(bytes: Buffer): { events: Array<Record<string, any>> } {
  const rows = bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { events: rows.slice(1) }
}

function encodeZstd(rows: readonly Record<string, unknown>[]): Buffer {
  const header = `${JSON.stringify(rows[0])}\n`
  const body = rows.slice(1).map((row) => `${JSON.stringify(row)}\n`).join('')
  return Buffer.concat([zstdCompressSync(Buffer.from(header)), zstdCompressSync(Buffer.from(body))])
}

function decodeZstd(bytes: Buffer): { events: Array<Record<string, any>> } {
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const chunks: Buffer[] = []
  let offset = 0
  while (offset < bytes.length) {
    const next = bytes.indexOf(magic, offset + 1)
    chunks.push(zstdDecompressSync(bytes.subarray(offset, next < 0 ? bytes.length : next)))
    offset = next < 0 ? bytes.length : next
  }
  const rows = Buffer.concat(chunks).toString('utf8').trim().split('\n').map((line) => JSON.parse(line))
  return { events: rows.slice(1) }
}
