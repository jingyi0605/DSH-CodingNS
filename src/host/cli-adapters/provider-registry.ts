/**
 * 模型提供商注册表。
 *
 * Agent 只是运行入口，订阅归属属于模型提供商。这里集中维护提供商名称、
 * 官方地址、余额能力和 Logo，调用方只传入 DSH 的 provider 名称与 baseURL。
 */
export type ProviderSubscriptionCapability =
  | 'official-balance'
  | 'official-usage'
  | 'subscription-window'
  | 'sub2api'
  | 'unsupported'

export type ProviderSubscriptionReader = 'deepseek-balance' | 'openrouter-balance' | 'minimax-usage' | 'zai-usage' | 'github-copilot-usage' | 'sub2api' | 'none'

export interface ProviderIdentity {
  readonly name?: string | undefined
  readonly baseUrl?: string | undefined
}

export interface ProviderDefinition {
  readonly id: string
  readonly displayName: string
  readonly aliases: readonly string[]
  readonly officialHosts: readonly string[]
  readonly capability: ProviderSubscriptionCapability
  readonly reader: ProviderSubscriptionReader
  /** 浏览器可直接加载的公开 Logo 地址；Host 会尽量内联为 data URL。 */
  readonly logoUrl: string
}

const simpleIcon = (slug: string): string => `https://cdn.simpleicons.org/${slug}`

/** DSH 内置模型提供商的统一订阅能力登记。 */
export const MODEL_PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  provider('amazon-bedrock', 'Amazon Bedrock', ['amazon-bedrock'], ['bedrock-runtime.us-east-1.amazonaws.com'], 'unsupported', 'amazonaws'),
  provider('ant-ling', 'Ant Ling', ['ant-ling'], [], 'sub2api', 'antdesign'),
  provider('anthropic', 'Anthropic', ['anthropic', 'claude'], ['api.anthropic.com'], 'official-usage', 'anthropic'),
  provider('azure-openai-responses', 'Azure OpenAI', ['azure-openai-responses', 'azure-openai'], [], 'unsupported', 'microsoftazure'),
  provider('baseten', 'Baseten', ['baseten'], ['inference.baseten.co'], 'official-usage', 'baseten'),
  provider('cerebras', 'Cerebras', ['cerebras'], ['api.cerebras.ai'], 'unsupported', 'cerebras'),
  provider('cloudflare-ai-gateway', 'Cloudflare AI Gateway', ['cloudflare-ai-gateway'], ['api.cloudflare.com'], 'official-usage', 'cloudflare'),
  provider('cloudflare-workers-ai', 'Cloudflare Workers AI', ['cloudflare-workers-ai'], ['api.cloudflare.com'], 'unsupported', 'cloudflare'),
  provider('deepseek', 'DeepSeek', ['deepseek', 'deepseek-official', 'official-deepseek'], ['api.deepseek.com', 'api.deepseek.com.cn'], 'official-balance', 'deepseek', 'deepseek-balance'),
  provider('fireworks', 'Fireworks AI', ['fireworks'], ['api.fireworks.ai'], 'official-usage', 'fireworks'),
  provider('github-copilot', 'GitHub Copilot', ['github-copilot'], ['api.githubcopilot.com', 'api.github.com'], 'subscription-window', 'github', 'github-copilot-usage'),
  provider('google', 'Google Gemini', ['google', 'gemini'], ['generativelanguage.googleapis.com'], 'unsupported', 'googlegemini'),
  provider('google-vertex', 'Google Vertex AI', ['google-vertex', 'vertex'], ['aiplatform.googleapis.com'], 'unsupported', 'googlecloud'),
  provider('groq', 'Groq', ['groq'], ['api.groq.com'], 'unsupported', 'groq'),
  provider('huggingface', 'Hugging Face', ['huggingface', 'hf'], ['api-inference.huggingface.co'], 'unsupported', 'huggingface'),
  provider('kimi-coding', 'Kimi Coding', ['kimi-coding'], ['api.kimi.com'], 'official-usage', 'moonshot'),
  provider('minimax', 'MiniMax', ['minimax'], ['api.minimax.io'], 'official-balance', 'minimax', 'minimax-usage'),
  provider('minimax-cn', 'MiniMax 中国', ['minimax-cn'], ['api.minimaxi.com'], 'official-balance', 'minimax', 'minimax-usage'),
  provider('mistral', 'Mistral AI', ['mistral'], ['api.mistral.ai'], 'official-usage', 'mistral'),
  provider('moonshotai', 'Moonshot AI', ['moonshotai', 'moonshot'], ['api.moonshot.ai'], 'official-balance', 'moonshot'),
  provider('moonshotai-cn', 'Moonshot AI 中国', ['moonshotai-cn'], ['api.moonshot.cn'], 'official-balance', 'moonshot'),
  provider('nvidia', 'NVIDIA NIM', ['nvidia'], ['integrate.api.nvidia.com'], 'unsupported', 'nvidia'),
  provider('openai', 'OpenAI', ['openai'], ['api.openai.com'], 'official-usage', 'openai'),
  provider('openai-codex', 'OpenAI Codex', ['openai-codex'], ['chatgpt.com', 'api.openai.com'], 'subscription-window', 'openai'),
  provider('opencode', 'OpenCode', ['opencode'], [], 'sub2api', 'opencode'),
  provider('opencode-go', 'OpenCode Go', ['opencode-go'], [], 'sub2api', 'opencode'),
  provider('openrouter', 'OpenRouter', ['openrouter'], ['openrouter.ai'], 'official-balance', 'openrouter', 'openrouter-balance'),
  provider('qwen-token-plan', 'Qwen Token Plan', ['qwen-token-plan', 'qwen-token-plan-individual'], ['dashscope.aliyuncs.com'], 'unsupported', 'alibabacloud'),
  provider('qwen-token-plan-cn', 'Qwen Token Plan 中国', ['qwen-token-plan-cn'], ['dashscope.aliyuncs.com.cn'], 'unsupported', 'alibabacloud'),
  provider('together', 'Together AI', ['together'], ['api.together.xyz'], 'unsupported', 'together'),
  provider('vercel-ai-gateway', 'Vercel AI Gateway', ['vercel-ai-gateway'], ['ai-gateway.vercel.sh'], 'official-usage', 'vercel'),
  provider('xai', 'xAI', ['xai', 'grok'], ['api.x.ai'], 'unsupported', 'x'),
  provider('xiaomi', 'Xiaomi MiMo', ['xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp'], ['api.xiaomimimo.com'], 'unsupported', 'xiaomi'),
  provider('zai', 'Z.ai', ['zai'], ['api.z.ai'], 'official-balance', 'zhipu', 'zai-usage'),
  provider('zai-coding-cn', 'Z.ai Coding 中国', ['zai-coding-cn'], ['open.bigmodel.cn'], 'official-balance', 'zhipu', 'zai-usage'),
]

function provider(
  id: string,
  displayName: string,
  aliases: readonly string[],
  officialHosts: readonly string[],
  capability: ProviderSubscriptionCapability,
  logoSlug: string,
  reader: ProviderSubscriptionReader = capability === 'sub2api' ? 'sub2api' : 'none',
): ProviderDefinition {
  return { id, displayName, aliases, officialHosts, capability, reader, logoUrl: simpleIcon(logoSlug) }
}

/** 规范化名称，避免大小写、下划线和连字符造成重复提供商。 */
export function normalizeProviderName(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[_\s]+/gu, '-')
}

/** 去掉 path、查询参数和凭据，只保留可用于身份判断的 origin。 */
export function normalizeProviderBaseUrl(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return ''
  try {
    const url = new URL(value.trim())
    return url.origin.toLowerCase()
  } catch {
    return ''
  }
}

function providerMatches(definition: ProviderDefinition, identity: ProviderIdentity): boolean {
  const name = normalizeProviderName(identity.name)
  const nameMatches = name !== '' && definition.aliases.some((alias) => normalizeProviderName(alias) === name)
  const host = normalizeProviderBaseUrl(identity.baseUrl)
  const hostMatches = host !== '' && definition.officialHosts.some((officialHost) => normalizeProviderBaseUrl(`https://${officialHost}`) === host)
  return nameMatches && (host === '' || hostMatches)
}

/** 按名称和 baseURL 联合识别；同名第三方代理不会冒充官方提供商。 */
export function identifyModelProvider(identity: ProviderIdentity): ProviderDefinition | undefined {
  return MODEL_PROVIDER_DEFINITIONS.find((definition) => providerMatches(definition, identity))
}

/** 返回一个不依赖名称的第三方上游定义，供 Sub2API 统计使用。 */
export function thirdPartyProvider(identity: ProviderIdentity): ProviderDefinition {
  const name = identity.name?.trim()
  return {
    id: name === undefined || name === '' ? 'custom' : normalizeProviderName(name),
    displayName: name === undefined || name === '' ? '自定义提供商' : name,
    aliases: [],
    officialHosts: [],
    capability: 'sub2api',
    reader: 'sub2api',
    logoUrl: '',
  }
}
