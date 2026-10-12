import type { Bookmarks } from 'webextension-polyfill'
import type { ExtensionApi } from './browser-api'
import { browserApi } from './browser-api'
import { fingerprintOf } from './plan'
import type { BookmarkTree, BookmarkView } from './types'

/** 将 webextension-polyfill 的书签树适配为与浏览器 API 解耦的最小接口。 */
export function createBrowserTree(api: ExtensionApi = browserApi): BookmarkTree {
  const toView = (node: Bookmarks.BookmarkTreeNode): BookmarkView => ({
    id: node.id,
    parentId: node.parentId ?? '',
    title: node.title ?? '',
    url: node.url ?? undefined,
    index: node.index ?? 0,
  })

  /** 读取失败（节点被外部删除等）视为空，由调用方按冲突处理。 */
  const childrenOf = async (parentId: string) => {
    try {
      return await api.bookmarks.getChildren(parentId)
    }
    catch {
      return []
    }
  }

  const collect = async (node: Bookmarks.BookmarkTreeNode, out: BookmarkView[]): Promise<void> => {
    out.push(toView(node))
    await Promise.all((node.children ?? []).map(child => collect(child, out)))
  }

  return {
    async roots() {
      const tree = await api.bookmarks.getTree()
      // 只支持桌面书签栏与其他书签，移动设备书签不参与整理。
      return (tree[0]?.children ?? []).filter((root: Bookmarks.BookmarkTreeNode) => !root.id.startsWith('mobile')).map(toView)
    },
    async children(parentId) {
      return (await childrenOf(parentId)).map(toView)
    },
    async get(id) {
      try {
        const [node] = await api.bookmarks.get(id)
        return node ? toView(node) : null
      }
      catch {
        return null
      }
    },
    async liveFingerprint(rootId) {
      const [root] = await api.bookmarks.getSubTree(rootId)
      const flat: Bookmarks.BookmarkTreeNode[] = []
      const walk = (node: Bookmarks.BookmarkTreeNode) => {
        flat.push(node)
        for (const child of node.children ?? [])
          walk(child)
      }
      for (const child of root?.children ?? [])
        walk(child)
      return fingerprintOf(flat)
    },
    async subtree(rootId) {
      const [root] = await api.bookmarks.getSubTree(rootId)
      const out: BookmarkView[] = []
      for (const child of root?.children ?? [])
        await collect(child, out)
      return out
    },
    async createFolder(parentId, title) {
      return toView(await api.bookmarks.create({ parentId, title }))
    },
    async move(id, parentId, index) {
      await api.bookmarks.move(id, typeof index === 'number' ? { parentId, index } : { parentId })
    },
    async renameFolder(id, title) {
      await api.bookmarks.update(id, { title })
    },
    async remove(id) {
      await api.bookmarks.remove(id)
    },
  }
}
