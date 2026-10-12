import type { Bookmarks } from 'webextension-polyfill'
import type { BookmarkView, Category, Decision, Preview, PreviewRow, ScopeSnapshot } from './types'
import { isClassifiable, normalizeName, sanitizeUrl, validateCategoryName } from './text'

/** 把书签树展平为分类范围快照：可分类书签、无法分类书签、有效分类上限。 */
export function buildSnapshot(input: {
  rootId: string
  rootTitle: string
  nodes: BookmarkView[]
  categoryLimit: number
}): ScopeSnapshot {
  const bookmarks = input.nodes.filter(node => node.url !== undefined && isClassifiable(node.url))
  return {
    rootId: input.rootId,
    rootTitle: input.rootTitle,
    nodes: input.nodes,
    bookmarks,
    unclassifiable: input.nodes.filter(node => node.url !== undefined && !isClassifiable(node.url)),
    effectiveLimit: Math.min(input.categoryLimit, bookmarks.length),
  }
}

export type Fingerprint = Array<[string, string, string, string, string]>

/** 构造预览：校验裁决完整性并计算统计。 */
export function buildPreview(input: {
  snapshot: ScopeSnapshot
  categories: Category[]
  decisions: Decision[]
}): { ok: true, preview: Preview } | { ok: false, error: string } {
  const { snapshot, categories, decisions } = input
  const validIds = new Set(categories.map(c => c.id))
  const byId = new Map<string, Decision>()

  for (const decision of decisions) {
    if (!snapshot.bookmarks.some(b => b.id === decision.bookmarkId))
      return { ok: false, error: `模型返回了未知书签 ID：${decision.bookmarkId}` }
    if (byId.has(decision.bookmarkId))
      return { ok: false, error: `模型重复裁决了书签：${decision.bookmarkId}` }
    if (decision.kind === 'assign' && !validIds.has(decision.categoryId))
      return { ok: false, error: `模型引用了未知分类：${decision.categoryId}` }
    byId.set(decision.bookmarkId, decision)
  }
  for (const bookmark of snapshot.bookmarks) {
    if (!byId.has(bookmark.id))
      return { ok: false, error: `模型漏掉了书签：${bookmark.title || bookmark.url}` }
  }

  const preview: Preview = {
    rootId: snapshot.rootId,
    categories: categories.map(category => ({ ...category })),
    rows: snapshot.bookmarks.map((bookmark) => {
      const decision = byId.get(bookmark.id)!
      return {
        bookmarkId: bookmark.id,
        title: bookmark.title,
        // 界面只展示脱敏 URL；原始 URL 保留在 row.url 供撤销校验使用。
        url: bookmark.url ?? '',
        displayUrl: sanitizeUrl(bookmark.url ?? '') ?? '',
        categoryId: decision.kind === 'assign' ? decision.categoryId : null,
      }
    }),
    fingerprint: fingerprintOf(snapshot),
    counts: { total: 0, moving: 0, unchanged: 0, pending: 0, unclassifiable: snapshot.unclassifiable.length, categories: categories.length },
    blocking: [],
  }
  recount(preview)
  return { ok: true, preview }
}

export function recount(preview: Preview): void {
  const validIds = new Set(preview.categories.map(c => c.id))
  // 指纹里包含范围内的全部节点（含文件夹），可用父节点 ID 反查其标题。
  const parentOf = new Map(preview.fingerprint.map(([id, parent]) => [id, parent]))
  const titleById = new Map(preview.fingerprint.map(([id, , title]) => [id, title]))
  const pending = preview.rows.filter(row => !row.categoryId || !validIds.has(row.categoryId)).length
  // “不变”= 书签已被归到与其原父文件夹同名的分类，执行时不会移动。
  const unchanged = preview.rows.filter((row) => {
    const category = preview.categories.find(c => c.id === row.categoryId)
    if (!category)
      return false
    const parentTitle = titleById.get(parentOf.get(row.bookmarkId) ?? '') ?? ''
    return Boolean(parentTitle) && normalizeName(category.name) === normalizeName(parentTitle)
  }).length
  preview.counts = {
    total: preview.rows.length,
    moving: preview.rows.length - pending - unchanged,
    unchanged,
    pending,
    unclassifiable: preview.counts.unclassifiable,
    categories: new Set(preview.rows.map(row => row.categoryId).filter((id): id is string => Boolean(id && validIds.has(id)))).size,
  }
}

/** 阻断确认的问题：非法或重复名称，以及没有任何需要移动的书签。 */
export function previewBlocking(preview: Preview): string[] {
  const blocking = [...preview.blocking]
  const used = new Set<string>()
  for (const category of preview.categories) {
    const invalid = validateCategoryName(category.name)
    if (invalid) {
      blocking.push(`分类「${category.name || '(空)'}」：${invalid}`)
      continue
    }
    const key = normalizeName(category.name)
    if (used.has(key)) {
      blocking.push(`分类名称重复：${category.name}`)
      continue
    }
    used.add(key)
  }
  if (preview.counts.moving === 0)
    blocking.push('没有需要移动的书签')
  return [...new Set(blocking)]
}

/** 预览分组：各分类下的书签，以及仍未定归属的“待确认”。 */
export function rowsByCategory(preview: Preview): Array<{ category: Category, rows: PreviewRow[] }> {
  const groups = preview.categories.map(category => ({
    category,
    rows: preview.rows.filter(row => row.categoryId === category.id),
  }))
  const pendingRows = preview.rows.filter(row => !row.categoryId)
  if (pendingRows.length)
    groups.push({ category: { id: '__pending__', name: '待确认' }, rows: pendingRows })
  return groups
}

/** 预览中可选的重新指派目标：现有分类，或留空表示待确认。 */
export function reassign(preview: Preview, bookmarkIds: string[], categoryId: string | null): Preview {
  const next: Preview = {
    ...preview,
    categories: preview.categories.map(category => ({ ...category })),
    rows: preview.rows.map(row => bookmarkIds.includes(row.bookmarkId) ? { ...row, categoryId } : { ...row }),
    blocking: [...preview.blocking],
  }
  recount(next)
  return next
}

/** 删除一个拟建分类：其书签回到待确认，保留原位置。 */
export function deleteCategory(preview: Preview, categoryId: string): Preview {
  const next: Preview = {
    ...preview,
    categories: preview.categories.filter(category => category.id !== categoryId).map(category => ({ ...category })),
    rows: preview.rows.map(row => row.categoryId === categoryId ? { ...row, categoryId: null } : { ...row }),
    blocking: [...preview.blocking],
  }
  recount(next)
  return next
}

export function renameCategory(preview: Preview, categoryId: string, name: string): Preview {
  const next: Preview = {
    ...preview,
    categories: preview.categories.map(category => category.id === categoryId ? { ...category, name } : { ...category }),
    rows: preview.rows.map(row => ({ ...row })),
    blocking: [...preview.blocking],
  }
  recount(next)
  return next
}
/**
 * 预览与执行共用的指纹：成员身份、位置、标题与 URL。
 * 快照与浏览器实时读取是同一算法，只是 URL 字段的类型不同。
 */
export function fingerprintOf(snapshot: ScopeSnapshot): Array<[string, string, string, string, string]>
export function fingerprintOf(nodes: Bookmarks.BookmarkTreeNode[]): Array<[string, string, string, string, string]>
export function fingerprintOf(source: ScopeSnapshot | Bookmarks.BookmarkTreeNode[]): Array<[string, string, string, string, string]> {
  const nodes = Array.isArray(source) ? source : source.nodes
  return nodes
    .map(node => [node.id, node.parentId ?? '', node.title ?? '', node.url ?? '', String(node.index ?? 0)] as [string, string, string, string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.length === b.length && a.every((row, index) => row.every((field, i) => field === b[index][i]))
}
