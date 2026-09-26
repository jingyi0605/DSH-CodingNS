import assert from 'node:assert/strict'
import test from 'node:test'
import { OfficialProviderSubscriptionService } from '../data/build/dist/host/cli-adapters/official-provider-subscription.js'

test('OpenRouter 官方读取器合并 credits 与 key 响应', async () => {
  const service = new OfficialProviderSubscriptionService({
    fetch: (async (url: string, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer openrouter-secret')
      if (url.endsWith('/api/v1/key')) return new Response(JSON.stringify({ data: { label: 'coding', limit: 20, usage: 3.5, limit_remaining: 16.5 } }), { status: 200 })
      assert.equal(url, 'https://openrouter.ai/api/v1/credits')
      return new Response(JSON.stringify({ data: { total_credits: 20, total_usage: 3.5 } }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('openrouter', { baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'openrouter-secret' })
  assert.equal(result?.providerBalance?.remaining, 16.5)
  assert.equal(result?.providerBalance?.used, 3.5)
  assert.equal(result?.providerBalance?.total, 20)
  assert.equal(result?.provider?.id, 'openrouter')
  assert.doesNotMatch(JSON.stringify(result), /openrouter-secret/u)
})

test('MiniMax Coding Plan 读取器解析 general 滚动和周配额', async () => {
  const calls: string[] = []
  const service = new OfficialProviderSubscriptionService({
    fetch: (async (url: string) => {
      calls.push(url)
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 },
        model_remains: [{ model_name: 'general', current_interval_remaining_percent: 61, current_weekly_remaining_percent: 80, current_weekly_status: 1, end_time: 1_800_000_000_000, weekly_end_time: 1_801_000_000_000 }],
      }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('minimax-cn', { baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'minimax-secret' })
  assert.equal(calls[0], 'https://api.minimaxi.com/v1/coding_plan/remains')
  assert.equal(result?.providerBalance?.remaining, 61)
  assert.equal(result?.providerBalance?.details[1]?.value, '80%')
})

test('Z.ai 读取器使用原始 API key 并解析 limits', async () => {
  const service = new OfficialProviderSubscriptionService({
    fetch: (async (url: string, init?: RequestInit) => {
      assert.equal(url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit')
      assert.equal(new Headers(init?.headers).get('authorization'), 'zai-secret')
      return new Response(JSON.stringify({ data: { level: 'GLM Coding', limits: [{ type: 'TOKENS_LIMIT', percentage: 72, nextResetTime: 1_800_000_000 }] } }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('zai-coding-cn', { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'zai-secret' })
  assert.equal(result?.providerBalance?.remaining, 72)
  assert.equal(result?.providerBalance?.planName, 'GLM Coding')
  assert.doesNotMatch(JSON.stringify(result), /zai-secret/u)
})

test('Z.ai 通用账户余额使用官方 balance 接口', async () => {
  const service = new OfficialProviderSubscriptionService({
    fetch: (async (url: string, init?: RequestInit) => {
      assert.equal(url, 'https://api.z.ai/api/paas/v4/balance')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer zai-secret')
      return new Response(JSON.stringify({ data: { balance: '12.50', rechargeAmount: '20', totalSpendAmount: '7.5' } }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('zai', { baseUrl: 'https://api.z.ai/v1', apiKey: 'zai-secret' })
  assert.equal(result?.providerBalance?.remaining, 12.5)
  assert.equal(result?.providerBalance?.currency, 'CNY')
})

test('Z.ai 通用提供商在官方 balance 不可用时读取账户余额报告', async () => {
  const urls: string[] = []
  const service = new OfficialProviderSubscriptionService({
    fetch: (async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://api.z.ai') || url.startsWith('https://open.bigmodel.cn')) urls.push(url)
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer zai-secret')
      if (url.endsWith('/balance')) return new Response('{}', { status: 404 })
      return new Response(JSON.stringify({ success: true, data: { availableBalance: '12.5', rechargeAmount: '20', totalSpendAmount: '7.5', frozenBalance: '0' } }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('zai', { baseUrl: 'https://api.z.ai/api/paas/v4', apiKey: 'zai-secret' })
  assert.deepEqual(urls, [
    'https://api.z.ai/api/paas/v4/balance',
    'https://open.bigmodel.cn/api/biz/account/query-customer-account-report',
  ])
  assert.equal(result?.providerBalance?.remaining, 12.5)
  assert.equal(result?.providerBalance?.currency, 'CNY')
})

test('GitHub Copilot 组织适配器读取席位信息，未配置组织时不伪造个人余额', async () => {
  const unavailable = new OfficialProviderSubscriptionService().read('github-copilot', { baseUrl: 'https://api.githubcopilot.com', apiKey: 'copilot-secret' })
  assert.equal((await unavailable)?.providerBalance, undefined)
  const service = new OfficialProviderSubscriptionService({
    githubCopilotOrganization: 'example-org',
    fetch: (async (url: string, init?: RequestInit) => {
      assert.equal(url, 'https://api.github.com/orgs/example-org/copilot/billing')
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer copilot-secret')
      return new Response(JSON.stringify({ seat_management_setting: { total_seats: 10, occupied_seats: 4 }, plan_type: 'business' }), { status: 200 })
    }) as typeof fetch,
  })
  const result = await service.read('github-copilot', { baseUrl: 'https://api.githubcopilot.com', apiKey: 'copilot-secret' })
  assert.equal(result?.providerBalance?.remaining, 6)
  assert.equal(result?.providerBalance?.planName, 'business')
  assert.doesNotMatch(JSON.stringify(result), /copilot-secret/u)
})
