/** 分类名规范化：去空白 + NFKC + 大小写折叠；用于重名检测。 */
export function normalizeName(raw: string): string {
  return (raw ?? '').normalize('NFKC').trim().toLowerCase()
}

/** 分类名是否可作为文件夹名：非空、不过长、不含路径分隔符。 */
export function validateCategoryName(name: string, maxLength = 60): string | null {
  const trimmed = (name ?? '').trim()
  if (!trimmed)
    return '分类名称不能为空'
  if (trimmed.length > maxLength)
    return `分类名称不能超过 ${maxLength} 个字符`
  if (/[/\\]/.test(trimmed))
    return '分类名称不能包含 / 或 \\'
  return null
}

/** URL 脱敏：仅保留 HTTP(S) 的协议、主机与路径，去掉凭据、query 与 hash。 */
export function sanitizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return null
  if (!url.hostname)
    return null
  const path = url.pathname === '/' ? '' : url.pathname
  return `${url.protocol}//${url.host}${path}`
}

/** 是否为可发送给模型的 HTTP(S) 书签。 */
export function isClassifiable(url: string | undefined): boolean {
  return typeof url === 'string' && sanitizeUrl(url) !== null
}

const DESTRUCTIVE = /(删除|移除|清空|丢弃|delete|remove|erase|clear|drop|wipe|overwrite|replace\s+existing)/i

/** 用户需求中的破坏性指令；MVP 不支持，需明确告知用户已忽略。 */
export function findIgnoredRequirements(requirement: string): string[] {
  const found = requirement.match(DESTRUCTIVE)
  return found ? [found[0]] : []
}
