import { describe, expect, it } from 'vitest'
import { CONNECTION_TEST_MESSAGES, ModelError, createModelClient, extractJson } from '~/core/model'

describe('模型客户端', () => {
  it('连接测试消息不含任何书签数据', () => {
    const text = CONNECTION_TEST_MESSAGES.map(message => message.content).join(' ')
    expect(text).not.toMatch(/https?:/)
    expect(text.length).toBeLessThan(200)
  })

  it('hTTP 错误只上报状态码，不回显请求体与密钥', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => new Response('secret-key-echo', { status: 401 })) as typeof fetch
    try {
      const client = createModelClient({ apiKey: 'super-secret-key', baseUrl: 'https://api.example.com/v1', model: 'm', categoryLimit: 8 })
      let message = ''
      try {
        await client.complete([{ role: 'user', content: 'hi' }])
      }
      catch (reason) {
        expect(reason).toBeInstanceOf(ModelError)
        message = (reason as ModelError).message
      }
      expect(message).toContain('401')
      expect(message).not.toContain('super-secret-key')
      expect(message).not.toContain('secret-key-echo')
    }
    finally {
      globalThis.fetch = original
    }
  })

  it('解析带围栏的 JSON，无法解析时给出可读错误', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(() => extractJson('抱歉，我无法完成')).toThrow(ModelError)
  })
})
