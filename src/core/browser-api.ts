import type Browser from 'webextension-polyfill'

export type ExtensionApi = typeof Browser

/** Chrome/Edge MV3 提供 Promise API；按需访问以便领域模块在非扩展环境中导入。 */
export const browserApi = new Proxy({} as ExtensionApi, {
  get: (_target, property: keyof ExtensionApi) => {
    const { browser, chrome } = globalThis as unknown as { browser?: ExtensionApi, chrome?: ExtensionApi }
    const api = chrome ?? browser
    if (!api)
      throw new Error('当前页面无法访问浏览器扩展 API')
    return api[property]
  },
})
