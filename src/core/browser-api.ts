import type Browser from 'webextension-polyfill'

export type ExtensionApi = typeof Browser

/**
 * 扩展 API 引用：延迟到首次属性访问时才解析全局 browser，
 * 这样模块加载顺序与测试替身都不影响使用。
 */
export const browserApi = new Proxy({} as ExtensionApi, {
  get: (_target, property: string) => {
    const api = (globalThis as unknown as { browser?: ExtensionApi }).browser
    if (!api)
      throw new Error('扩展 API 不可用：缺少全局 browser')
    return (api as unknown as Record<string, unknown>)[property]
  },
})
