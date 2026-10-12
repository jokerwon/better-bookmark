import { browserApi } from './browser-api'

/**
 * 模型请求由扩展页面发出：没有目标源的主机权限时，MV3 会把跨域响应按 CORS 拦截，
 * 于是连接测试与分类都会失败。这里按需向用户申请「仅该源」的主机权限，
 * 不使用 <all_urls>，安装时也不预设任何主机权限。
 */
export async function ensureHostPermission(origin: string): Promise<boolean> {
  const pattern = `${origin}/*`
  const permissions = (browserApi as unknown as {
    permissions?: {
      contains: (request: { origins: string[] }) => Promise<boolean>
      request: (request: { origins: string[] }) => Promise<boolean>
    }
  }).permissions
  if (!permissions)
    return true
  try {
    if (await permissions.contains({ origins: [pattern] }))
      return true
    return await permissions.request({ origins: [pattern] })
  }
  catch {
    return false
  }
}
