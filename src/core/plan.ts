import type { Bookmarks } from 'webextension-polyfill'
import type { BookmarkView, Category, Decision, Preview, PreviewGroup, PreviewRow, ScopeSnapshot } from './types'
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

/** 按模型顺序深度优先展开分类树。 */
export function flattenCategories(categories: Category[]): Category[] {
  const out: Category[] = []
  const visit = (nodes: Category[]) => {
    for (const node of nodes) {
      out.push(node)
      visit(node.children)
    }
  }
  visit(categories)
  return out
}

export function cloneCategories(categories: Category[]): Category[] {
  return categories.map(category => ({ ...category, children: cloneCategories(category.children) }))
}

/** 筛选命中：空筛选命中全部。 */
function matchesFilter(row: PreviewRow, needle: string): boolean {
  return !needle || row.title.toLowerCase().includes(needle) || row.displayUrl.toLowerCase().includes(needle)
}

/** 构造预览：校验裁决完整性并计算统计。 */
export function buildPreview(input: {
  snapshot: ScopeSnapshot
  categories: Category[]
  decisions: Decision[]
}): { ok: true, preview: Preview } | { ok: false, error: string } {
  const { snapshot, categories, decisions } = input
  const flat = flattenCategories(categories)
  const validIds = new Set(flat.map(c => c.id))
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
    categories: cloneCategories(categories),
    rows: snapshot.bookmarks.map((bookmark) => {
      const decision = byId.get(bookmark.id)!
      return {
        bookmarkId: bookmark.id,
        title: bookmark.title,
        url: bookmark.url ?? '',
        displayUrl: sanitizeUrl(bookmark.url ?? '') ?? '',
        categoryId: decision.kind === 'assign' ? decision.categoryId : null,
      }
    }),
    fingerprint: fingerprintOf(snapshot),
    counts: { total: 0, moving: 0, unchanged: 0, pending: 0, unclassifiable: snapshot.unclassifiable.length, categories: flat.length },
    blocking: [],
  }
  recount(preview)
  return { ok: true, preview }
}

export function recount(preview: Preview): void {
  const categories = flattenCategories(preview.categories)
  const validIds = new Set(categories.map(c => c.id))
  const parentOf = new Map(preview.fingerprint.map(([id, parent]) => [id, parent]))
  const titleById = new Map(preview.fingerprint.map(([id, , title]) => [id, title]))
  const categoryById = new Map(categories.map(category => [category.id, category]))
  // 与执行一致：按从根开始的完整相对路径判定未移动，避免不同路径下的同名节点被当成不变。
  const pathOfBookmark = (bookmarkId: string): string[] => {
    const path: string[] = []
    let current = parentOf.get(bookmarkId) ?? ''
    while (current && current !== preview.rootId && titleById.has(current)) {
      path.unshift(normalizeName(titleById.get(current)!))
      current = parentOf.get(current) ?? ''
    }
    return path
  }
  const pathOfCategory = (categoryId: string): string[] => {
    const path: string[] = []
    let current = categoryById.get(categoryId)
    while (current) {
      path.unshift(normalizeName(current.name))
      current = current.parentId ? categoryById.get(current.parentId) : undefined
    }
    return path
  }
  const pending = preview.rows.filter(row => !row.categoryId || !validIds.has(row.categoryId)).length
  const unchanged = preview.rows.filter((row) => {
    if (!row.categoryId || !validIds.has(row.categoryId))
      return false
    const from = pathOfBookmark(row.bookmarkId)
    const to = pathOfCategory(row.categoryId)
    return to.length > 0 && from.length === to.length && from.every((segment, index) => segment === to[index])
  }).length
  preview.counts = {
    total: preview.rows.length,
    moving: preview.rows.length - pending - unchanged,
    unchanged,
    pending,
    unclassifiable: preview.counts.unclassifiable,
    categories: categories.length,
  }
}

/** 阻断确认的问题：非法或同级重复名称，以及没有任何需要移动的书签。 */
export function previewBlocking(preview: Preview): string[] {
  const blocking = [...preview.blocking]
  const visit = (categories: Category[]) => {
    const used = new Set<string>()
    for (const category of categories) {
      const invalid = validateCategoryName(category.name)
      if (invalid) {
        blocking.push(`分类「${category.name || '(空)'}」：${invalid}`)
      }
      else {
        const key = normalizeName(category.name)
        if (used.has(key))
          blocking.push(`同级分类名称重复：${category.name}`)
        used.add(key)
      }
      visit(category.children)
    }
  }
  visit(preview.categories)
  if (preview.counts.moving === 0)
    blocking.push('没有需要移动的书签')
  return [...new Set(blocking)]
}

/** 预览分组：按冻结树的深度优先顺序返回分类、缩进深度、完整路径标签与筛选后的书签。 */
export function groupRows(preview: Preview, filter: string): PreviewGroup[] {
  const needle = filter.trim().toLowerCase()
  const categories = flattenCategories(preview.categories)
  const parentById = new Map(categories.map(category => [category.id, category.parentId]))
  const matchedIds = new Set(preview.rows.filter(row => row.categoryId && matchesFilter(row, needle)).map(row => row.categoryId!))
  const expanded = new Set<string>()
  for (const id of matchedIds) {
    let current: string | null = id
    while (current && !expanded.has(current)) {
      expanded.add(current)
      current = parentById.get(current) ?? null
    }
  }
  const labelById = new Map<string, string>()
  const depthById = new Map<string, number>()
  return categories
    .map((category): PreviewGroup => {
      const parentLabel = category.parentId ? labelById.get(category.parentId) : undefined
      labelById.set(category.id, parentLabel ? `${parentLabel} / ${category.name}` : category.name)
      depthById.set(category.id, category.parentId ? (depthById.get(category.parentId) ?? 0) + 1 : 0)
      return {
        category,
        depth: depthById.get(category.id)!,
        label: labelById.get(category.id)!,
        rows: preview.rows.filter(row => row.categoryId === category.id && matchesFilter(row, needle)),
        expanded: expanded.has(category.id),
      }
    })
    .filter(group => !needle || group.rows.length > 0 || group.expanded)
}

/** 待确认书签：同样受筛选约束，供预览计数与列表共用。 */
export function pendingRows(preview: Preview, filter: string): PreviewRow[] {
  const needle = filter.trim().toLowerCase()
  return preview.rows.filter(row => !row.categoryId && matchesFilter(row, needle))
}

/** 预览中可选的重新指派目标：现有分类，或留空表示待确认。 */
export function reassign(preview: Preview, bookmarkIds: string[], categoryId: string | null): Preview {
  const next: Preview = {
    ...preview,
    categories: cloneCategories(preview.categories),
    rows: preview.rows.map(row => bookmarkIds.includes(row.bookmarkId) ? { ...row, categoryId } : { ...row }),
    blocking: [...preview.blocking],
  }
  recount(next)
  return next
}

/** 删除一个拟建分类及其子树：相关书签回到待确认，保留原位置。 */
export function deleteCategory(preview: Preview, categoryId: string): Preview {
  const removed = new Set<string>()
  const collect = (categories: Category[]): Category[] => categories.flatMap((category) => {
    if (category.id === categoryId) {
      flattenCategories([category]).forEach(node => removed.add(node.id))
      return []
    }
    return [{ ...category, children: collect(category.children) }]
  })
  const next: Preview = {
    ...preview,
    categories: collect(preview.categories),
    rows: preview.rows.map(row => removed.has(row.categoryId ?? '') ? { ...row, categoryId: null } : { ...row }),
    blocking: [...preview.blocking],
  }
  recount(next)
  return next
}

export function renameCategory(preview: Preview, categoryId: string, name: string): Preview {
  const rename = (categories: Category[]): Category[] => categories.map(category => ({
    ...category,
    name: category.id === categoryId ? name : category.name,
    children: rename(category.children),
  }))
  const next: Preview = { ...preview, categories: rename(preview.categories), rows: preview.rows.map(row => ({ ...row })), blocking: [...preview.blocking] }
  recount(next)
  return next
}

/** 预览与执行共用的指纹：成员身份、位置、标题与 URL。 */
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
