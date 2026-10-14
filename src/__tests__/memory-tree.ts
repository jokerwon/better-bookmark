import type { BookmarkTree, BookmarkView } from '~/core/types'
import { fingerprintOf } from '~/core/plan'

/** 内存书签树：与浏览器书签 API 语义对齐的确定性适配器。 */
export class MemoryTree {
  nodes = new Map<string, BookmarkView>()
  #seq = 0
  /** 记录每次移动，便于断言外部行为。 */
  moves: Array<{ id: string, parentId: string, index?: number }> = []

  constructor() {
    this.nodes.set('root', { id: 'root', parentId: '', title: '', index: 0 })
  }

  addFolder(parentId: string, title: string): string {
    const id = `f${++this.#seq}`
    this.nodes.set(id, { id, parentId, title, index: this.childrenOf(parentId).length })
    return id
  }

  addBookmark(parentId: string, title: string, url: string): string {
    const id = `b${++this.#seq}`
    this.nodes.set(id, { id, parentId, title, url, index: this.childrenOf(parentId).length })
    return id
  }

  /** 模拟用户在扩展之外修改书签。 */
  external(patch: Partial<BookmarkView> & { id: string }): void {
    const node = this.nodes.get(patch.id)
    if (node)
      this.nodes.set(patch.id, { ...node, ...patch })
  }

  titlesOf(parentId: string): string[] {
    return this.childrenOf(parentId).map(node => node.title)
  }

  idsOf(parentId: string): string[] {
    return this.childrenOf(parentId).map(node => node.id)
  }

  urlsOf(parentId: string): string[] {
    return this.childrenOf(parentId).map(node => node.url ?? '')
  }

  createTree(): BookmarkTree {
    return {
      roots: async () => this.childrenOf('root'),
      children: async parentId => this.childrenOf(parentId),
      get: async (id) => {
        const node = this.nodes.get(id)
        return node ? { ...node } : null
      },
      liveFingerprint: async rootId => fingerprintOf(this.flatten(rootId)),
      subtree: async rootId => this.flatten(rootId),
      createFolder: async (parentId, title) => {
        const id = this.addFolder(parentId, title)
        return { ...this.nodes.get(id)! }
      },
      createBookmark: async (parentId, title, url) => {
        const id = this.addBookmark(parentId, title, url)
        return { ...this.nodes.get(id)! }
      },
      move: async (id, parentId, index) => {
        const node = this.nodes.get(id)
        if (!node)
          throw new Error(`节点不存在：${id}`)
        const target = this.nodes.get(parentId)
        if (!target || target.url !== undefined)
          throw new Error(`目标不是文件夹：${parentId}`)
        this.moves.push({ id, parentId, index })
        const siblings = this.childrenOf(parentId).filter(child => child.id !== id)
        const at = typeof index === 'number' ? Math.max(0, Math.min(index, siblings.length)) : siblings.length
        siblings.splice(at, 0, { ...node, parentId })
        this.renumber(siblings, parentId)
        this.detach(id, parentId)
      },
      renameFolder: async (id, title) => {
        const node = this.nodes.get(id)
        if (node)
          this.nodes.set(id, { ...node, title })
      },
      remove: async (id) => {
        const descendants = this.flatten(id).map(node => node.id)
        this.detach(id)
        for (const descendant of descendants)
          this.nodes.delete(descendant)
        this.nodes.delete(id)
      },
    }
  }

  private renumber(nodes: BookmarkView[], parentId: string): void {
    nodes.forEach((node, i) => this.nodes.set(node.id, { ...this.nodes.get(node.id)!, parentId, index: i }))
  }

  /** 把节点从其原父文件夹移除并重新编号。 */
  private detach(id: string, keepParent?: string): void {
    const node = this.nodes.get(id)
    if (!node || !node.parentId || node.parentId === keepParent)
      return
    this.renumber(this.childrenOf(node.parentId).filter(child => child.id !== id), node.parentId)
  }

  private flatten(rootId: string): BookmarkView[] {
    const out: BookmarkView[] = []
    const walk = (id: string) => {
      for (const child of this.childrenOf(id)) {
        out.push(child)
        walk(child.id)
      }
    }
    walk(rootId)
    return out
  }

  private childrenOf(parentId: string): BookmarkView[] {
    return [...this.nodes.values()]
      .filter(node => node.parentId === parentId)
      .sort((a, b) => a.index - b.index)
      .map(node => ({ ...node }))
  }
}
