import type { ApiConfig, ChatMessage, ModelClient } from './types'
import { resolveConfig } from './config'

export type { ChatMessage, ModelClient } from './types'

/** 连接测试使用的固定消息：不包含任何书签数据。 */
export const CONNECTION_TEST_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a connectivity probe. Reply with the single word: ok' },
  { role: 'user', content: 'ping' },
]

/** 默认临时故障重试次数（网络错误与限流）。 */
export const RETRIES = 2

export class ModelError extends Error {
  retryable: boolean

  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'ModelError'
    this.retryable = retryable
  }
}

export function createModelClient(config: ApiConfig): ModelClient {
  const resolved = resolveConfig(config)
  if (!resolved.ok)
    throw new ModelError(resolved.error, false)

  const { endpoint, apiKey, model } = resolved.value

  return {
    async complete(messages: ChatMessage[]) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages,
        }),
      })

      if (!response.ok) {
        // 只上报状态码与状态文本，绝不回显请求头、请求体或响应体。
        throw new ModelError(
          `模型服务返回 HTTP ${response.status}${retryableStatus(response.status) ? '（可重试）' : ''}`,
          retryableStatus(response.status),
        )
      }

      let payload: unknown
      try {
        payload = await response.json()
      }
      catch {
        throw new ModelError('模型返回的不是合法 JSON', false)
      }

      const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices
      const content = choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content.trim())
        throw new ModelError('模型返回内容为空', false)
      return content
    },
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/** 从模型输出中提取 JSON 对象；容忍常见的 ```json 围栏。 */
export function extractJson(raw: string): unknown {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start)
    throw new ModelError('模型返回内容中找不到 JSON 对象', false)
  try {
    return JSON.parse(text.slice(start, end + 1))
  }
  catch {
    throw new ModelError('模型返回的 JSON 无法解析', false)
  }
}

/** 网络与限流类故障重试两次，其余错误直接失败。 */
export async function withRetries<T>(run: () => Promise<T>, onRetry?: () => void): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await run()
    }
    catch (error) {
      lastError = error
      const retryable = error instanceof ModelError
        ? error.retryable
        : error instanceof TypeError
      if (!retryable || attempt === RETRIES)
        break
      onRetry?.()
    }
  }
  throw lastError
}
