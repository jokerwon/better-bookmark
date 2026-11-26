/** 浏览器书签树的最小输入结构；与 webextension-polyfill 的节点结构兼容。 */
export interface RawBookmarkNode {
  id: string
  title?: string
  url?: string
  children?: RawBookmarkNode[]
  dateAdded?: number
}

/** 书架上的一个真实文件夹；count 包含全部后代书签。 */
export interface ShelfFolder {
  id: string
  title: string
  depth: number
  isRoot: boolean
  pathLabel: string
  count: number
  /** 树中的遍历顺序，用于稳定排序。 */
  order: number
}

export interface ShelfBookmark {
  id: string
  title: string
  url?: string
  href?: string
  domain: string
  /** 从根到所在文件夹的 ID；主题范围按祖先判断是否命中。 */
  folderIds: string[]
  pathLabel: string
  searchText: string
  dateAdded?: number
  order: number
}

export interface ShelfCatalog {
  total: number
  folders: ShelfFolder[]
  bookmarks: ShelfBookmark[]
  /** 首页最多三个真实非空文件夹；没有实际子文件夹时用非空根目录补足。 */
  covers: ShelfFolder[]
}

/** 只将可导航的 HTTP(S) 地址渲染为链接。原始 URL 留在详情。 */
function parseAddress(url: string): URL | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      return parsed
  }
  catch {
    // 导入或同步的书签可能不是可导航的网站。
  }
}

/** 全部结果都有真实添加时间时才允许按时间排序；否则保持浏览器树顺序。 */
export function hasReliableDates(bookmarks: ShelfBookmark[]): boolean {
  return bookmarks.length > 0 && bookmarks.every(bookmark => bookmark.dateAdded !== undefined)
}

/** 读取全部浏览根（书签栏、其他书签及浏览器给出的其他根）并统计后代书签数。 */
export function buildShelfCatalog(tree: RawBookmarkNode[]): ShelfCatalog {
  const folders: ShelfFolder[] = []
  const roots: ShelfFolder[] = []
  const bookmarks: ShelfBookmark[] = []
  let order = 0

  const visit = (node: RawBookmarkNode, depth: number, pathIds: string[], parentPath: string): number => {
    const title = (node.title ?? '').trim()
    if (node.url !== undefined) {
      const address = parseAddress(node.url)
      const domain = address?.hostname.replace(/^www\./, '') ?? ''
      const dateAdded = typeof node.dateAdded === 'number' && node.dateAdded > 0 && node.dateAdded <= 8.64e15 ? node.dateAdded : undefined
      bookmarks.push({
        id: node.id,
        title,
        url: node.url,
        href: address?.href,
        domain,
        folderIds: pathIds,
        pathLabel: parentPath,
        searchText: `${title} ${domain} ${parentPath}`.toLocaleLowerCase(),
        dateAdded,
        order: order++,
      })
      return 1
    }

    const folderTitle = title || '未命名文件夹'
    const folderIds = [...pathIds, node.id]
    const pathLabel = parentPath ? `${parentPath} / ${folderTitle}` : folderTitle
    const isRoot = pathIds.length === 0
    const folder: ShelfFolder = {
      id: node.id,
      title: folderTitle,
      depth,
      isRoot,
      pathLabel,
      count: 0,
      order: order++,
    }
    folders.push(folder)
    if (isRoot)
      roots.push(folder)

    let count = 0
    for (const child of node.children ?? [])
      count += visit(child, depth + 1, folderIds, pathLabel)
    folder.count = count
    return count
  }

  for (const root of tree[0]?.children ?? [])
    visit(root, 0, [], '')

  const total = roots.reduce((sum, root) => sum + root.count, 0)
  const covers = folders.filter(folder => !folder.isRoot && folder.count > 0)
    .sort((a, b) => b.count - a.count || a.depth - b.depth || a.order - b.order)
    .slice(0, 3)
  for (const root of roots) {
    if (covers.length === 3)
      break
    if (root.count > 0)
      covers.push(root)
  }

  return { total, folders, bookmarks, covers }
}
