import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { registerCodingNsLocale } from '../data/build/dist/client/locale.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('Codingns4DSH 注册完整中英文词典并交给 DSH locale 服务管理', () => {
  let namespace = ''
  let dictionaries: Record<string, Record<string, string>> | undefined
  let disposed = false
  const dispose = registerCodingNsLocale({
    locale: {
      register: (nextNamespace: string, nextDictionaries: Record<string, Record<string, string>>) => {
        namespace = nextNamespace
        dictionaries = nextDictionaries
        return () => { disposed = true }
      },
    },
  } as never)

  assert.equal(namespace, 'codingns')
  assert.equal(dictionaries?.en['settings.title'], 'Codingns4DSH features')
  assert.equal(dictionaries?.zh['settings.title'], 'Codingns4DSH 功能模块')
  dispose()
  assert.equal(disposed, true)
})

test('Client bundle 同时包含英文默认文案和中文词典文案', async () => {
  const bundle = await readFile(join(root, 'data/build/dist/client/bundle.js'), 'utf8')
  assert.match(bundle, /Codingns4DSH features/u)
  assert.match(bundle, /Codingns4DSH 功能模块/u)
  assert.match(bundle, /codingns/u)
})
