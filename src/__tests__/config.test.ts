import { describe, expect, it } from 'vitest'
import { clampCategoryLimit, resolveConfig } from '~/core/config'
import { findIgnoredRequirements, normalizeName, sanitizeUrl, validateCategoryName } from '~/core/text'

describe('aPI 配置', () => {
  it('拼接固定路径并拒绝非本机 HTTP', () => {
    const ok = resolveConfig({ apiKey: 'k', baseUrl: 'https://api.example.com/v1/', model: 'm', categoryLimit: 8 })
    expect(ok.ok && ok.value.endpoint).toBe('https://api.example.com/v1/chat/completions')

    const local = resolveConfig({ apiKey: 'k', baseUrl: 'http://127.0.0.1:11434', model: 'm', categoryLimit: 8 })
    expect(local.ok && local.value.endpoint).toBe('http://127.0.0.1:11434/chat/completions')

    const insecure = resolveConfig({ apiKey: 'k', baseUrl: 'http://api.example.com', model: 'm', categoryLimit: 8 })
    expect(insecure.ok).toBe(false)

    const doubling = resolveConfig({ apiKey: 'k', baseUrl: 'https://api.example.com/v1/chat/completions', model: 'm', categoryLimit: 8 })
    expect(doubling.ok).toBe(false)
  })

  it('分类上限钳制在 3–15', () => {
    expect(clampCategoryLimit(1)).toBe(3)
    expect(clampCategoryLimit(99)).toBe(15)
    expect(clampCategoryLimit(Number.NaN)).toBe(8)
  })
})

describe('uRL 脱敏与名称规范化', () => {
  it('移除凭据、query 与 fragment，非 HTTP(S) 不可分类', () => {
    expect(sanitizeUrl('https://user:pass@example.com/a/b?q=1#h')).toBe('https://example.com/a/b')
    expect(sanitizeUrl('https://example.com')).toBe('https://example.com')
    expect(sanitizeUrl('chrome://bookmarks')).toBeNull()
    expect(sanitizeUrl('not a url')).toBeNull()
  })

  it('重名判定与去重', () => {
    expect(normalizeName(' 开发工具 ')).toBe(normalizeName('开发工具'))
    expect(validateCategoryName('')).toBeTruthy()
    expect(validateCategoryName('a/b')).toBeTruthy()
    expect(validateCategoryName('开发')).toBeNull()
  })

  it('识别并忽略破坏性要求', () => {
    expect(findIgnoredRequirements('先删除所有旧文件夹')).toContain('删除')
    expect(findIgnoredRequirements('按用途分组')).toEqual([])
  })
})
