import type { BookmarkTree, Category, CreatedFolder, PendingMove, Preview, RecoveryReport, RecoveryState, TreeChange, UndoRecord, UndoStatus } from './types'
import { flattenCategories } from './plan'
import { normalizeName } from './text'

/** 执行分类：按冻结树深度优先创建路径，再按书签原始遍历顺序移动。 */
export async function executePreview(
  preview: Preview,
  tree: BookmarkTree,
  onProgress?: (done: number, total: number) => void,
): Promise<
  | { ok: true, changes: TreeChange[], createdFolders: CreatedFolder[] }
  | { ok: false, error: string, createdFolders: CreatedFolder[], completed: PendingMove[], remaining: PendingMove[] }
  > {
  const changes: TreeChange[] = []
  const createdFolders: CreatedFolder[] = []
  const folderByCategory = new Map<string, string>()
  const categories = flattenCategories(preview.categories)
  const used = new Set(preview.rows.map(row => row.categoryId).filter((id): id is string => Boolean(id)))
  const categoryById = new Map(categories.map(category => [category.id, category]))
  for (const category of categories) {
    if (category.parentId && !categoryById.has(category.parentId))
      return { ok: false, error: `分类「${category.name}」的父分类缺失，未移动任何书签`, createdFolders: [], completed: [], remaining: [] }
  }

  const resolveFolder = async (category: Category): Promise<string> => {
    const existing = folderByCategory.get(category.id)
    if (existing)
      return existing
    const parentId = category.parentId ? await resolveFolder(categoryById.get(category.parentId)!) : preview.rootId
    const siblings = await tree.children(parentId)
    const match = siblings.find(node => node.url === undefined && normalizeName(node.title) === normalizeName(category.name))
    if (match) {
      folderByCategory.set(category.id, match.id)
      return match.id
    }
    const folder = await tree.createFolder(parentId, category.name.trim())
    createdFolders.push({ id: folder.id, name: folder.title })
    folderByCategory.set(category.id, folder.id)
    return folder.id
  }

  let current: Category | null = null
  try {
    for (const category of categories) {
      if (used.has(category.id)) {
        current = category
        await resolveFolder(category)
      }
    }
  }
  catch {
    await removeEmpty(tree, createdFolders)
    return { ok: false, error: `创建分类「${current?.name ?? ''}」的文件夹失败，未移动任何书签`, createdFolders: [], completed: [], remaining: [] }
  }

  for (const category of categories) {
    if (!used.has(category.id))
      continue
    const folderId = folderByCategory.get(category.id)!
    const node = await tree.get(folderId)
    const expectedParent = category.parentId ? folderByCategory.get(category.parentId) : preview.rootId
    if (!node || node.url !== undefined || node.parentId !== expectedParent) {
      await removeEmpty(tree, createdFolders)
      return { ok: false, error: `分类文件夹「${category.name}」校验失败，未移动任何书签`, createdFolders: [], completed: [], remaining: [] }
    }
  }

  const moveRows = preview.rows
    .filter(row => row.categoryId && folderByCategory.get(row.categoryId) !== originalParentOf(preview, row.bookmarkId))
    .map(row => ({ bookmarkId: row.bookmarkId, toParent: folderByCategory.get(row.categoryId!)!, fromParent: originalParentOf(preview, row.bookmarkId), fromIndex: indexOf(preview, row.bookmarkId) }))
  const completed: PendingMove[] = []
  for (const move of moveRows) {
    try {
      await tree.move(move.bookmarkId, move.toParent)
      completed.push(move)
      const landed = await tree.children(move.toParent)
      changes.push({ nodeId: move.bookmarkId, kind: 'moved', fromParent: move.fromParent, toParent: move.toParent, toIndex: landed.find(node => node.id === move.bookmarkId)?.index ?? landed.length - 1 })
      onProgress?.(completed.length, moveRows.length)
    }
    catch {
      return { ok: false, error: `移动「${preview.rows.find(row => row.bookmarkId === move.bookmarkId)?.title ?? move.bookmarkId}」失败，已停止后续移动`, createdFolders, completed, remaining: moveRows.slice(completed.length + 1) }
    }
  }
  return { ok: true, changes, createdFolders }
}

export function indexOf(preview: Preview, bookmarkId: string): number {
  return Number(preview.fingerprint.find(([id]) => id === bookmarkId)?.[4] ?? 0)
}

export function originalParentOf(preview: Preview, bookmarkId: string): string {
  return preview.fingerprint.find(([id]) => id === bookmarkId)?.[1] ?? ''
}

async function removeEmpty(tree: BookmarkTree, folders: CreatedFolder[]): Promise<void> {
  for (const folder of [...folders].reverse()) {
    try {
      if ((await tree.children(folder.id)).length === 0)
        await tree.remove(folder.id)
    }
    catch {
      // 清理是尽力而为：失败时保留已建文件夹，由恢复或撤销流程继续处理。
    }
  }
}

/** 中断执行后的恢复：只放回仍停留在目标位置的书签，绝不覆盖外部修改。 */
export async function recover(state: RecoveryState, tree: BookmarkTree): Promise<RecoveryReport> {
  const report: RecoveryReport = { restored: 0, conflicts: [], removedFolders: [] }
  for (const move of state.completed) {
    const node = await tree.get(move.bookmarkId)
    if (!node || node.parentId !== move.toParent) {
      report.conflicts.push(`${move.bookmarkId}（已被外部改动）`)
      continue
    }
    try {
      await tree.move(move.bookmarkId, move.fromParent, move.fromIndex)
      report.restored++
    }
    catch {
      report.conflicts.push(move.bookmarkId)
    }
  }
  for (const folder of [...state.createdFolders].reverse()) {
    try {
      if (!(await tree.get(folder.id)))
        continue
      if ((await tree.children(folder.id)).length === 0) {
        await tree.remove(folder.id)
        report.removedFolders.push(folder.id)
      }
    }
    catch {
      report.conflicts.push(folder.id)
    }
  }
  return report
}

/** 撤销前置检查：任一相关节点变化即禁用整次撤销。 */
export async function checkUndo(record: UndoRecord | null, tree: BookmarkTree): Promise<UndoStatus> {
  if (!record)
    return { state: 'none' }
  const reasons: string[] = []
  for (const entry of record.entries) {
    const label = entry.title || entry.bookmarkId
    const node = await tree.get(entry.bookmarkId)
    if (!node) {
      reasons.push(`书签已被删除：${label}`)
      continue
    }
    if (node.parentId !== entry.toParent) {
      reasons.push(`书签已被移动：${label}`)
      continue
    }
    if (node.title !== entry.title)
      reasons.push(`书签标题已被修改：${label}`)
    if ((node.url ?? '') !== entry.url)
      reasons.push(`书签地址已被修改：${label}`)
    if (node.index !== entry.toIndex)
      reasons.push(`书签顺序已被调整：${label}`)
  }
  for (const created of record.createdFolders) {
    const folder = await tree.get(created.id)
    if (!folder)
      reasons.push(`分类文件夹已被删除：${created.name}`)
    else if (folder.url !== undefined)
      reasons.push(`分类文件夹已被替换：${created.name}`)
    else if (normalizeName(folder.title) !== normalizeName(created.name))
      reasons.push(`分类文件夹已被改名：${created.name} → ${folder.title}`)
  }
  return reasons.length ? { state: 'disabled', reasons } : { state: 'available' }
}

/** 撤销：先做完整前置检查，再按原索引升序恢复父节点与顺序。 */
export async function applyUndo(record: UndoRecord, tree: BookmarkTree): Promise<{ restored: number, removedFolders: string[], conflicts: string[] }> {
  const status = await checkUndo(record, tree)
  if (status.state !== 'available')
    return { restored: 0, removedFolders: [], conflicts: status.state === 'disabled' ? status.reasons : ['撤销记录已失效'] }
  const conflicts: string[] = []
  const removedFolders: string[] = []
  let restored = 0
  for (const entry of [...record.entries].sort((a, b) => a.fromIndex - b.fromIndex)) {
    try {
      await tree.move(entry.bookmarkId, entry.fromParent, entry.fromIndex)
      restored++
    }
    catch {
      conflicts.push(entry.bookmarkId)
    }
  }
  for (const folder of [...record.createdFolders].reverse()) {
    try {
      if (!(await tree.get(folder.id)))
        continue
      if ((await tree.children(folder.id)).length === 0) {
        await tree.remove(folder.id)
        removedFolders.push(folder.id)
      }
    }
    catch {
      conflicts.push(folder.id)
    }
  }
  return { restored, removedFolders, conflicts }
}
