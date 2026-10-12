import type { ApiConfig } from './types'

export const CATEGORY_LIMIT_MIN = 3
export const CATEGORY_LIMIT_MAX = 15
export const CATEGORY_LIMIT_DEFAULT = 8

export function clampCategoryLimit(value: number): number {
  if (!Number.isFinite(value))
    return CATEGORY_LIMIT_DEFAULT
  return Math.min(CATEGORY_LIMIT_MAX, Math.max(CATEGORY_LIMIT_MIN, Math.trunc(value)))
}

export interface ResolvedConfig {
  endpoint: string
  apiKey: string
  model: string
  /** 需要向用户申请主机权限的源。 */
  origin: string
  /** 隐私确认绑定的目标（baseUrl + model 变化后需重新确认）。 */
  originKey: string
}

/** 合并固定路径并校验协议；HTTPS 或本机/局域网的 HTTP 才被接受。 */
export function resolveConfig(config: ApiConfig): { ok: true, value: ResolvedConfig } | { ok: false, error: string } {
  const apiKey = (config.apiKey ?? '').trim()
  const model = (config.model ?? '').trim()
  const rawBase = (config.baseUrl ?? '').trim()

  if (!apiKey)
    return { ok: false, error: '请填写 API Key' }
  if (!model)
    return { ok: false, error: '请填写模型名称' }
  if (!rawBase)
    return { ok: false, error: '请填写 Base URL' }

  let url: URL
  try {
    url = new URL(rawBase)
  }
  catch {
    return { ok: false, error: 'Base URL 不是合法地址' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ok: false, error: 'Base URL 只支持 http 或 https' }

  // 凭据不应出现在 Base URL 中；也避免校验的主机与最终请求的主机不一致。
  if (url.username || url.password)
    return { ok: false, error: 'Base URL 不能包含用户名或密码' }

  const basePath = url.pathname.replace(/\/+$/, '')
  if (basePath.endsWith('/chat/completions'))
    return { ok: false, error: 'Base URL 不应包含 /chat/completions' }

  if (url.protocol === 'http:' && !isLocalHost(url.hostname))
    return { ok: false, error: '非本机地址必须使用 HTTPS' }

  const endpoint = `${url.origin}${basePath}/chat/completions`
  return {
    ok: true,
    value: {
      endpoint,
      apiKey,
      model,
      origin: url.origin,
      originKey: `${url.origin}${basePath}::${model}`,
    },
  }
}

function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost'))
    return true
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4)
    return /^[0-9a-f:]+$/.test(host) && host.includes(':')
  const parts = ipv4.slice(1).map(Number)
  if (parts.some(p => p > 255))
    return false
  return parts[0] === 10
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
}
