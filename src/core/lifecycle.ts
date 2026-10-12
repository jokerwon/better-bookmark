import type { BookmarkTree, BookmarkView, CreatedFolder, PendingMove, Preview, RecoveryReport, RecoveryState, TreeChange, UndoRecord, UndoStatus } from './types'
import { normalizeName } from './text'

/** 执行分类：先创建并验证目标文件夹，再按书签原始遍历顺序移动。 */
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

  // 预览生成后重新读取分类范围，任何外部变化都不得沿用旧目标。
  const siblings = await tree.children(preview.rootId)

  // 只为真正有书签要落入的分类建目录，避免制造空文件夹。
  const used = new Set(preview.rows.map(row => row.categoryId).filter((id): id is string => Boolean(id)))
  const categories = preview.categories.filter(category => used.has(category.id))

  for (const category of categories) {
    const normalized = normalizeName(category.name)
    const match = siblings.find(node => node.url === undefined && normalizeName(node.title) === normalized)
    if (match) {
      folderByCategory.set(category.id, match.id)
      continue
    }
    let folder: BookmarkView
    try {
      folder = await tree.createFolder(preview.rootId, category.name.trim())
    }
    catch {
      await removeEmpty(tree, createdFolders)
      return { ok: false, error: `创建分类「${category.name}」失败，未移动任何书签`, createdFolders: [], completed: [], remaining: [] }
    }
    createdFolders.push({ id: folder.id, name: folder.title })
    folderByCategory.set(category.id, folder.id)
  }

  // 移动前再次确认目标文件夹仍是分类范围内的文件夹。
  for (const category of categories) {
    const folderId = folderByCategory.get(category.id)!
    const node = await tree.get(folderId)
    if (!node || node.url !== undefined || node.parentId !== preview.rootId) {
      await removeEmpty(tree, createdFolders)
      return { ok: false, error: `分类文件夹「${category.name}」校验失败，未移动任何书签`, createdFolders: [], completed: [], remaining: [] }
    }
  }

  // rows 已按原始遍历顺序排列；落地时追加在目标文件夹既有内容之后。
  const moveRows = preview.rows
    .filter(row => row.categoryId && folderByCategory.get(row.categoryId) !== originalParentOf(preview, row.bookmarkId))
    .map(row => ({
      bookmarkId: row.bookmarkId,
      toParent: folderByCategory.get(row.categoryId!)!,
      fromParent: originalParentOf(preview, row.bookmarkId),
      fromIndex: indexOf(preview, row.bookmarkId),
    }))

  const completed: PendingMove[] = []
  for (const move of moveRows) {
    try {
      await tree.move(move.bookmarkId, move.toParent)
      completed.push(move)
      const landed = await tree.children(move.toParent)
      changes.push({
        nodeId: move.bookmarkId,
        kind: 'moved',
        fromParent: move.fromParent,
        toParent: move.toParent,
        toIndex: landed.find(node => node.id === move.bookmarkId)?.index ?? landed.length - 1,
      })
      onProgress?.(completed.length, moveRows.length)
    }
    catch {
      return {
        ok: false,
        error: `移动「${preview.rows.find(row => row.bookmarkId === move.bookmarkId)?.title ?? move.bookmarkId}」失败，已停止后续移动`,
        createdFolders,
        completed,
        remaining: moveRows.slice(completed.length + 1),
      }
    }
  }

  return { ok: true, changes, createdFolders }
}

/** 书签在快照中的原索引；快照缺失时返回 0。 */
export function indexOf(preview: Preview, bookmarkId: string): number {
  return Number(preview.fingerprint.find(([id]) => id === bookmarkId)?.[4] ?? 0)
}

/** 书签在快照中的原父文件夹；快照缺失时返回空字符串。 */
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
      // 清理失败不掩盖原始错误。
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
    // 位置变化同样属于相关节点变化：撤销会按原索引插入，覆盖用户的后续排序。
    if (node.index !== entry.toIndex)
      reasons.push(`书签顺序已被调整：${label}`)
  }

  for (const created of record.createdFolders) {
    const folder = await tree.get(created.id)
    if (!folder) {
      reasons.push(`分类文件夹已被删除：${created.name}`)
      continue
    }
    if (folder.url !== undefined)
      reasons.push(`分类文件夹已被替换：${created.name}`)
    else if (normalizeName(folder.title) !== normalizeName(created.name))
      reasons.push(`分类文件夹已被改名：${created.name} → ${folder.title}`)
  }

  return reasons.length ? { state: 'disabled', reasons } : { state: 'available' }
}

/** 撤销：先做完整前置检查，再按原索引升序恢复父节点与顺序。 */
export async function applyUndo(
  record: UndoRecord,
  tree: BookmarkTree,
): Promise<{ restored: number, removedFolders: string[], conflicts: string[] }> {
  // 整次撤销的原子性：任一相关节点变化时不得做部分恢复。
  const status = await checkUndo(record, tree)
  if (status.state !== 'available')
    return { restored: 0, removedFolders: [], conflicts: status.state === 'disabled' ? status.reasons : ['撤销记录已失效'] }

  const conflicts: string[] = []
  const removedFolders: string[] = []
  let restored = 0

  for (const entry of [...record.entries].sort((a, b) => a.fromIndex - b.fromIndex)) {
    try {
      // 按原索引升序恢复：先恢复的条目已经占据各自的原始绝对位置，因此直接插入原索引。
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
