import type { CliSubscriptionUsage, ProviderBalanceUsage } from '../../shared/contracts/subscription.js'
import { identifyModelProvider, type ProviderDefinition } from './provider-registry.js'
import type { Sub2ApiSource } from './provider-subscription.js'

type FetchLike = typeof fetch

/**
 * 读取模型厂商自己的账户接口。
 *
 * 这里不把管理后台的 Cookie 或组织管理员令牌当成普通模型 API key；
 * 只有供应商文档明确允许 API key 调用的接口才在此登记。
 */
export interface OfficialProviderSubscriptionOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  /** GitHub Copilot 管理 API 所需的组织名；普通 Copilot 用户没有可查询的个人余额接口。 */
  readonly githubCopilotOrganization?: string
}

export class OfficialProviderSubscriptionService {
  private readonly request: FetchLike
  private readonly timeoutMs: number
  private readonly githubCopilotOrganization: string | undefined

  constructor(options: OfficialProviderSubscriptionOptions = {}) {
    this.request = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.githubCopilotOrganization = options.githubCopilotOrganization?.trim()
      || process.env.GITHUB_COPILOT_ORGANIZATION?.trim()
      || undefined
  }

  async read(providerId: string | undefined, source: Sub2ApiSource | null): Promise<CliSubscriptionUsage | null> {
    if (providerId === undefined || source === null || source.apiKey.trim() === '') return null
    const definition = identifyModelProvider({ name: providerId, baseUrl: source.baseUrl })
    if (definition === undefined) return null
    const usage = definition.id === 'openrouter'
      ? await this.readOpenRouter(source)
      : definition.id === 'minimax' || definition.id === 'minimax-cn'
        ? await this.readMiniMax(source)
      : definition.id === 'zai' || definition.id === 'zai-coding-cn'
          ? await this.readZai(source, definition.id)
          : definition.id === 'github-copilot'
            ? await this.readGithubCopilot(source)
          : null
    if (usage === null) return null
    const logoDataUrl = await readLogoDataUrl(definition.logoUrl, this.request, this.timeoutMs)
    return {
      authenticated: true,
      planType: usage.planName,
      primary: null,
      secondary: null,
      monthly: null,
      rateLimitReachedType: null,
      resetCredits: null,
      capturedAt: new Date().toISOString(),
      provider: {
        id: definition.id,
        displayName: definition.displayName,
        baseUrl: sanitizeUrl(source.baseUrl),
        capability: definition.capability,
        logoUrl: definition.logoUrl,
        ...(logoDataUrl === '' ? {} : { logoDataUrl }),
      },
      providerBalance: usage,
    }
  }

  private async readOpenRouter(source: Sub2ApiSource): Promise<ProviderBalanceUsage | null> {
    const root = openRouterRoot(source.baseUrl)
    if (root === '') return null
    const key = await this.getJson(`${root}/api/v1/key`, source, true)
    const credits = await this.getJson(`${root}/api/v1/credits`, source, true)
    if (key === null && credits === null) return null
    const keyData = recordValue(key?.data)
    const creditData = recordValue(credits?.data)
    const limit = numberValue(keyData?.limit)
    const keyUsage = numberValue(keyData?.usage)
    const keyRemaining = numberValue(keyData?.limit_remaining)
    const totalCredits = numberValue(creditData?.total_credits)
    const totalUsage = numberValue(creditData?.total_usage)
    const total = limit ?? totalCredits
    const used = keyUsage ?? totalUsage
    const remaining = keyRemaining ?? (total !== null && used !== null ? Math.max(0, total - used) : null)
    if (total === null && used === null && remaining === null) return null
    const details: { label: string; value: string | number }[] = []
    const label = textValue(keyData?.label)
    if (label !== null) details.push({ label: 'Key', value: label })
    if (keyData?.is_free_tier === true) details.push({ label: '免费层', value: '是' })
    return {
      upstreamUrl: sanitizeUrl(root),
      currency: 'USD',
      unit: 'USD',
      balance: remaining,
      remaining,
      used,
      total,
      requests: null,
      inputTokens: null,
      outputTokens: null,
      planName: keyData?.is_free_tier === true ? 'Free' : null,
      details,
    }
  }

  private async readMiniMax(source: Sub2ApiSource): Promise<ProviderBalanceUsage | null> {
    // Coding Plan 文档：/v1/coding_plan/remains；旧版国内文档曾使用
    // /v1/api/openplatform/coding_plan/remains，因此保留一次兼容回退。
    const root = miniMaxRoot(source.baseUrl)
    if (root === '') return null
    const paths = ['/v1/coding_plan/remains', '/v1/api/openplatform/coding_plan/remains']
    for (const path of paths) {
      const response = await this.getJson(`${root}${path}`, source, true)
      const usage = normalizeMiniMax(response, root)
      if (usage !== null) return usage
    }
    return null
  }

  private async readZai(source: Sub2ApiSource, providerId: string): Promise<ProviderBalanceUsage | null> {
    const root = zaiRoot(source.baseUrl)
    if (root === '') return null
    // Coding Plan 使用额度窗口接口；通用 Z.ai 使用官方账户余额接口。
    if (providerId === 'zai-coding-cn') {
      const value = await this.getJson(`${root}/api/monitor/usage/quota/limit`, source, false)
      const quota = normalizeZai(value, root)
      if (quota !== null) return quota
    } else {
      const value = await this.getJson(`${root}/api/paas/v4/balance`, source, true)
      const balance = normalizeZaiAccount(value, root)
      if (balance !== null) return balance
    }
    // 通用 Zhipu 账户余额接口来自社区对官方控制台请求的逆向记录；
    // 仅在 Coding Plan quota 不可用时尝试，接口变化时安全返回 null。
    const accountRoot = root.includes('bigmodel.cn') ? root : 'https://open.bigmodel.cn'
    const account = await this.getJson(`${accountRoot}/api/biz/account/query-customer-account-report`, source, true)
    return normalizeZaiAccount(account, accountRoot)
  }

  private async readGithubCopilot(source: Sub2ApiSource): Promise<ProviderBalanceUsage | null> {
    const organization = this.githubCopilotOrganization
    if (organization === undefined) return null
    const value = await this.getJson(`https://api.github.com/orgs/${encodeURIComponent(organization)}/copilot/billing`, source, true)
    const seats = numberValue(value?.seat_management_setting?.total_seats)
      ?? numberValue(value?.total_seats)
      ?? numberValue(value?.totalSeats)
    const occupied = numberValue(value?.seat_management_setting?.occupied_seats)
      ?? numberValue(value?.occupied_seats)
      ?? numberValue(value?.occupiedSeats)
    if (seats === null && occupied === null) return null
    return {
      upstreamUrl: 'https://api.github.com',
      currency: null,
      unit: 'seats',
      balance: seats !== null && occupied !== null ? Math.max(0, seats - occupied) : null,
      remaining: seats !== null && occupied !== null ? Math.max(0, seats - occupied) : null,
      used: occupied,
      total: seats,
      requests: null,
      inputTokens: null,
      outputTokens: null,
      planName: textValue(value?.plan_type ?? value?.planType),
      details: [
        ...(seats === null ? [] : [{ label: '总席位', value: seats }]),
        ...(occupied === null ? [] : [{ label: '已分配席位', value: occupied }]),
      ],
    }
  }

  private async getJson(url: string, source: Sub2ApiSource, bearer: boolean): Promise<Record<string, any> | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const key = source.apiKey.trim()
      const response = await this.request(url, {
        headers: {
          Authorization: bearer ? (key.startsWith('Bearer ') ? key : `Bearer ${key}`) : key,
          Accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (!response.ok) return null
      return recordValue(await response.json())
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

function normalizeMiniMax(value: Record<string, any> | null, baseUrl: string): ProviderBalanceUsage | null {
  if (value === null || numberValue(recordValue(value.base_resp)?.status_code) === -1) return null
  const models = Array.isArray(value.model_remains) ? value.model_remains : []
  const model = models.map(recordValue).find((item) => textValue(item?.model_name) === 'general') ?? models.map(recordValue).find(Boolean)
  if (model === undefined || model === null) return null
  const remaining = numberValue(model.current_interval_remaining_percent)
    ?? numberValue(model.remaining_percent)
  if (remaining === null) return null
  const details: { label: string; value: string | number }[] = [{ label: '滚动窗口剩余', value: `${remaining}%` }]
  const weekly = numberValue(model.current_weekly_remaining_percent)
  const weeklyEnabled = numberValue(model.current_weekly_status) === 1
  if (weekly !== null && weeklyEnabled) details.push({ label: '周窗口剩余', value: `${weekly}%` })
  const intervalReset = numberValue(model.end_time) ?? numberValue(model.remains_time)
  if (intervalReset !== null) details.push({ label: '滚动窗口重置', value: timestampFromMillis(intervalReset) ?? intervalReset })
  const weeklyReset = numberValue(model.weekly_end_time) ?? numberValue(model.weekly_remains_time)
  if (weeklyReset !== null && weeklyEnabled) details.push({ label: '周窗口重置', value: timestampFromMillis(weeklyReset) ?? weeklyReset })
  return {
    upstreamUrl: sanitizeUrl(baseUrl),
    currency: null,
    unit: '%',
    balance: remaining,
    remaining,
    used: 100 - remaining,
    total: 100,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName: textValue(model.plan_name),
    details,
  }
}

function normalizeZai(value: Record<string, any> | null, baseUrl: string): ProviderBalanceUsage | null {
  const data = recordValue(value?.data)
  const limits = Array.isArray(data?.limits) ? data.limits : []
  const usable = limits.map(recordValue).filter((item): item is Record<string, any> => item !== null && ['TOKENS_LIMIT', 'CREDIT_LIMIT'].includes(String(item.type ?? '').toUpperCase()))
  if (usable.length === 0) return null
  const details = usable.map((item) => ({
    label: String(item.type ?? '额度'),
    value: `${numberValue(item.percentage) ?? 0}%${timestampValue(item.nextResetTime) === null ? '' : `，重置于 ${timestampValue(item.nextResetTime)}`}`,
  }))
  const remaining = Math.max(...usable.map((item) => numberValue(item.percentage) ?? 0))
  return {
    upstreamUrl: sanitizeUrl(baseUrl),
    currency: null,
    unit: '%',
    balance: remaining,
    remaining,
    used: 100 - remaining,
    total: 100,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName: textValue(data?.level),
    details,
  }
}

function normalizeZaiAccount(value: Record<string, any> | null, baseUrl: string): ProviderBalanceUsage | null {
  const data = recordValue(value?.data)
  const available = numberValue(data?.availableBalance ?? data?.balance ?? data?.remainBalance)
  if (available === null) return null
  const recharge = numberValue(data?.rechargeAmount)
  const spent = numberValue(data?.totalSpendAmount)
  const frozen = numberValue(data?.frozenBalance)
  return {
    upstreamUrl: sanitizeUrl(baseUrl),
    currency: 'CNY',
    unit: 'CNY',
    balance: available,
    remaining: available,
    used: spent,
    total: recharge,
    requests: null,
    inputTokens: null,
    outputTokens: null,
    planName: null,
    details: [
      ...(recharge === null ? [] : [{ label: '累计充值', value: recharge }]),
      ...(spent === null ? [] : [{ label: '累计消费', value: spent }]),
      ...(frozen === null ? [] : [{ label: '冻结余额', value: frozen }]),
    ],
  }
}

function openRouterRoot(value: string): string { return rootForHost(value, 'openrouter.ai') }
function miniMaxRoot(value: string): string {
  let international = false
  try { international = new URL(value).hostname.includes('minimax.io') } catch { /* 使用国内默认地址 */ }
  return rootForHost(value, international ? 'api.minimax.io' : 'api.minimaxi.com')
}
function zaiRoot(value: string): string {
  let mainland = false
  try { mainland = new URL(value).hostname.includes('bigmodel.cn') } catch { /* 使用国际默认地址 */ }
  return rootForHost(value, mainland ? 'open.bigmodel.cn' : 'api.z.ai')
}
function rootForHost(value: string, fallbackHost: string): string {
  try {
    const url = new URL(value)
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/u, '')
  } catch {
    return `https://${fallbackHost}`
  }
}
function recordValue(value: unknown): Record<string, any> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, any> : null }
function numberValue(value: unknown): number | null { const result = typeof value === 'number' ? value : Number(value); return Number.isFinite(result) ? result : null }
function textValue(value: unknown): string | null { return typeof value === 'string' && value.trim() !== '' ? value.trim() : null }
function timestampValue(value: unknown): number | null { const n = numberValue(value); return n === null ? null : Math.round(n > 10_000_000_000 ? n / 1000 : n) }
function timestampFromMillis(value: number): number | null {
  if (value <= 0) return null
  // MiniMax 新接口返回 Unix 毫秒；旧接口的 remains_time 是剩余毫秒，兼容两种格式。
  return value >= 100_000_000_000 ? Math.round(value / 1000) : Math.round(Date.now() / 1000 + value / 1000)
}
function sanitizeUrl(value: string): string { try { const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString().replace(/\/$/u, '') } catch { return '' } }

/** 获取官方提供商 Logo 并内联，避免远程 Web 页面被 CSP 拦截。 */
async function readLogoDataUrl(url: string, request: FetchLike, timeoutMs: number): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  } catch {
    return ''
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3_000))
  try {
    const response = await request(parsed.toString(), { headers: { Accept: 'image/*' }, signal: controller.signal })
    if (!response.ok) return ''
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
    if (!['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(contentType)) return ''
    if (response.url !== '' && new URL(response.url).origin !== parsed.origin) return ''
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > 64 * 1024) return ''
    if (contentType === 'image/svg+xml' && !/<svg[\s>]/iu.test(new TextDecoder().decode(bytes))) return ''
    return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`
  } catch {
    return ''
  } finally {
    clearTimeout(timer)
  }
}
