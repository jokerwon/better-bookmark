import type { BookmarkTree, BookmarkView } from './types'

/** 备份文件标识；导入时据此拒绝无关 JSON。 */
export const BACKUP_FORMAT = 'better-bookmark-backup'
export const BACKUP_VERSION = 1

/** 备份文件中的一个节点：文件夹带 children，书签带 url。 */
export interface BackupNode {
  title: string
  url?: string
  children?: BackupNode[]
}

/** 备份文件内容；浏览器节点 ID 不进文件，导入时由浏览器重新分配。 */
export interface BackupFile {
  format: typeof BACKUP_FORMAT
  version: number
  exportedAt: string
  roots: BackupNode[]
}

export interface ImportReport {
  /** 实际写入的根文件夹标题。 */
  roots: string[]
  folders: number
  bookmarks: number
  /** 未写入的节点数：失败节点本身，及其因父节点失败而无法落地的后代。 */
  skipped: number
  /** 单个节点写入失败的原因；失败不中断其余节点。 */
  conflicts: string[]
}

/** 上限只用于挡住畸形文件：节点数远高于 5000 书签的规模目标，层级深于任何真实书签树。 */
const MAX_NODES = 50_000
const MAX_DEPTH = 1000
const MAX_TEXT = 16 * 1024 * 1024
const MAX_TITLE = 4096
const MAX_URL = 32_768

/** 导出全部受支持的根文件夹（书签栏、其他书签）及其后代。 */
export async function buildBackup(tree: BookmarkTree): Promise<BackupFile> {
  const roots = await tree.roots()
  const exported: BackupNode[] = []
  for (const root of roots) {
    // 整棵子树一次读出：读取失败会抛出而不是退化成空目录，避免导出看似完整的残缺备份。
    const nodes = await tree.subtree(root.id)
    exported.push({ title: root.title, children: childrenOf(root.id, nodes) })
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), roots: exported }
}

/** 按父节点还原层级；subtree 已按遍历顺序返回，分组不会打乱顺序。 */
function childrenOf(parentId: string, nodes: BookmarkView[]): BackupNode[] {
  const byParent = new Map<string, BookmarkView[]>()
  for (const node of nodes) {
    const siblings = byParent.get(node.parentId)
    if (siblings)
      siblings.push(node)
    else
      byParent.set(node.parentId, [node])
  }
  const walk = (id: string): BackupNode[] => (byParent.get(id) ?? []).map(node => node.url !== undefined
    ? { title: node.title, url: node.url }
    : { title: node.title, children: walk(node.id) })
  return walk(parentId)
}

/** 解析并校验备份文件：只接受结构完整的文件，任何问题都返回错误而不抛异常。 */
export function parseBackup(text: string): { ok: true, value: BackupFile } | { ok: false, error: string } {
  if (text.length > MAX_TEXT)
    return { ok: false, error: '备份文件超过 16 MB' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    return { ok: false, error: '备份文件不是合法的 JSON' }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, error: '这不是本扩展导出的备份文件' }

  let count = 0
  /** 返回规范化节点，或一句结构错误；不返回半成品。 */
  const readNode = (value: unknown, depth: number): BackupNode | string => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return '节点不是对象'
    const node = value as { title?: unknown, url?: unknown, children?: unknown }
    if (typeof node.title !== 'string' || node.title.length > MAX_TITLE)
      return '节点标题缺失或过长'
    if (++count > MAX_NODES)
      return `节点数超过 ${MAX_NODES}`
    if (depth > MAX_DEPTH)
      return `层级超过 ${MAX_DEPTH} 层`

    if (node.url !== undefined) {
      // URL 原样保留：备份要能还原用户自己的全部书签，协议是否可分类与导入无关。
      if (typeof node.url !== 'string' || !node.url || node.url.length > MAX_URL)
        return '书签 URL 缺失或过长'
      if (node.children !== undefined)
        return '书签不能包含子节点'
      return { title: node.title, url: node.url }
    }

    if (!Array.isArray(node.children))
      return '文件夹缺少 children'
    const children: BackupNode[] = []
    for (const child of node.children) {
      const read = readNode(child, depth + 1)
      if (typeof read === 'string')
        return read
      children.push(read)
    }
    return { title: node.title, children }
  }

  const file = raw as { format?: unknown, version?: unknown, exportedAt?: unknown, roots?: unknown }
  if (file.format !== BACKUP_FORMAT)
    return { ok: false, error: '这不是本扩展导出的备份文件' }
  if (file.version !== BACKUP_VERSION)
    return { ok: false, error: `备份文件版本 ${String(file.version)} 不受支持` }
  if (!Array.isArray(file.roots) || file.roots.length === 0)
    return { ok: false, error: '备份文件缺少根目录' }

  const roots: BackupNode[] = []
  for (const root of file.roots) {
    const node = readNode(root, 1)
    if (typeof node === 'string')
      return { ok: false, error: `备份文件结构不正确：${node}` }
    if (node.url !== undefined)
      return { ok: false, error: '备份文件的根目录必须是文件夹' }
    roots.push(node)
  }

  return {
    ok: true,
    value: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: typeof file.exportedAt === 'string' ? file.exportedAt : '',
      roots,
    },
  }
}

/**
 * 导入备份：按根标题写回同名根文件夹，追加在其现有内容之后。
 * 只创建节点，绝不删除或覆盖任何现有书签。
 */
export async function importBackup(data: BackupFile, tree: BookmarkTree, fallbackRootId: string): Promise<ImportReport> {
  const live = await tree.roots()
  const fallback = live.find(node => node.id === fallbackRootId)?.title ?? fallbackRootId
  const report: ImportReport = { roots: [], folders: 0, bookmarks: 0, skipped: 0, conflicts: [] }
  for (const root of data.roots) {
    const matched = live.find(node => node.title === root.title)
    // 报告实际落地的文件夹，避免同名根缺失时误报。
    report.roots.push(matched?.title ?? fallback)
    await writeNodes(tree, matched?.id ?? fallbackRootId, root.children ?? [], report)
  }
  return report
}

async function writeNodes(tree: BookmarkTree, parentId: string, nodes: BackupNode[], report: ImportReport): Promise<void> {
  for (const node of nodes) {
    try {
      if (node.url !== undefined) {
        await tree.createBookmark(parentId, node.title, node.url)
        report.bookmarks += 1
        continue
      }
      const folder = await tree.createFolder(parentId, node.title)
      report.folders += 1
      await writeNodes(tree, folder.id, node.children ?? [], report)
    }
    catch (error) {
      // 父文件夹写不进去时它的后代无处可放：计入未写入数量，不假装导入成功。
      const dropped = 1 + countDescendants(node)
      report.skipped += dropped
      report.conflicts.push(`${node.title || node.url || '未命名节点'}：${error instanceof Error ? error.message : '写入失败'}${dropped > 1 ? `（另有 ${dropped - 1} 个后代未导入）` : ''}`)
    }
  }
}

function countDescendants(node: BackupNode): number {
  return (node.children ?? []).reduce((sum, child) => sum + 1 + countDescendants(child), 0)
}
