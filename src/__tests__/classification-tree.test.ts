import { describe, expect, it } from 'vitest'
import { MemoryTree } from './memory-tree'
import { createOrchestrator } from '~/core/classifier'
import { recover } from '~/core/lifecycle'
import { buildPreview, deleteCategory, flattenCategories, renameCategory } from '~/core/plan'
import { parsePlan } from '~/core/prompt'
import type { BookmarkTree, ChatMessage, Decision, ModelClient, OperationResult, Preview, ScopeSnapshot } from '~/core/types'

/** 确定性模型：方案阶段返回给定嵌套树，裁决阶段把书签分配到指定节点。 */
class NestedModel implements ModelClient {
  constructor(private categories: unknown, private assignTo = 'c1') {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const prompt = messages[0].content
    if (prompt.includes('"summary"'))
      return JSON.stringify({ summary: '摘要' })
    if (prompt.includes('归并主题'))
      return JSON.stringify({ categories: this.categories })
    const batch = prompt.slice(prompt.indexOf('本批书签'))
    const ids = [...batch.matchAll(/"id":"([^"]+)"/g)].map(match => match[1])
    return JSON.stringify({ decisions: ids.map(bookmarkId => ({ bookmark_id: bookmarkId, decision: 'assign', category_id: this.assignTo })) })
  }
}

function nestedFixture() {
  const memory = new MemoryTree()
  const root = memory.addFolder('root', '书签栏')
  memory.addBookmark(root, 'A', 'https://a.example.com/')
  memory.addBookmark(root, 'B', 'https://b.example.com/')
  memory.addBookmark(root, 'C', 'https://c.example.com/')
  return { memory, root }
}

/** 与 Sidepanel 一致地构建撤销记录。 */
function recordOf(preview: Preview, rootId: string, result: OperationResult) {
  return {
    createdAt: Date.now(),
    rootId,
    categories: preview.categories,
    entries: preview.fingerprint
      .filter(([id]) => result.changes.some(change => change.nodeId === id))
      .map(([id, parentId, title, url, index]) => ({
        bookmarkId: id,
        fromParent: parentId,
        toParent: result.changes.find(change => change.nodeId === id)!.toParent,
        fromIndex: Number(index),
        toIndex: result.changes.find(change => change.nodeId === id)!.toIndex,
        title,
        url,
      })),
    createdFolders: result.createdFolders,
    changes: result.changes,
  }
}
describe('分类树协议', () => {
  it('解析嵌套节点并保留深度优先顺序', () => {
    const tree = parsePlan({ categories: [
      { name: '工作', children: [{ name: '开发' }, { name: '设计' }] },
      { name: '生活' },
    ] })
    expect(tree).toEqual([
      { name: '工作', children: [{ name: '开发', children: [] }, { name: '设计', children: [] }] },
      { name: '生活', children: [] },
    ])
  })

  it('分类统计包含没有书签直接归属的中间节点', () => {
    const snapshot: ScopeSnapshot = {
      rootId: 'root',
      rootTitle: '书签栏',
      nodes: [{ id: 'b1', parentId: 'root', title: 'A', url: 'https://a.example.com', index: 0 }],
      bookmarks: [{ id: 'b1', parentId: 'root', title: 'A', url: 'https://a.example.com', index: 0 }],
      unclassifiable: [],
      effectiveLimit: 3,
    }
    const categories = [{ id: 'c1', name: '工作', parentId: null, children: [{ id: 'c2', name: '开发', parentId: 'c1', children: [] }] }]
    const result = buildPreview({ snapshot, categories, decisions: [{ bookmarkId: 'b1', kind: 'assign', categoryId: 'c2' }] as Decision[] })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.preview.counts.categories).toBe(2)
      expect(flattenCategories(result.preview.categories).map(category => category.id)).toEqual(['c1', 'c2'])
    }
  })

  it('解析器保留需由后续方案校验的嵌套结构', () => {
    const cases = [
      { categories: [{ name: '一', children: [{ name: '二', children: [{ name: '三', children: [{ name: '四' }] }] }] }] },
      { categories: [{ name: '一' }, { name: '二' }, { name: '三' }, { name: '四' }] },
      { categories: [{ name: '一' }, { name: ' 一 ' }] },
    ]
    for (const value of cases)
      expect(() => parsePlan(value)).not.toThrow()
  })

  it('端到端冻结三层方案并按完整路径创建文件夹', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    memory.addBookmark(root, 'A', 'https://a.example.com')
    memory.addBookmark(root, 'B', 'https://b.example.com')
    const model: ModelClient = {
      async complete(messages: ChatMessage[]) {
        const prompt = messages[0].content
        if (prompt.includes('summary'))
          return JSON.stringify({ summary: '摘要' })
        if (prompt.includes('嵌套分类树'))
          return JSON.stringify({ categories: [{ name: '工作', children: [{ name: '开发', children: [{ name: '前端' }] }] }] })
        const ids = [...prompt.matchAll(/"id":"(b\d+)"/g)].map(match => match[1])
        return JSON.stringify({ decisions: ids.map(bookmarkId => ({ bookmark_id: bookmarkId, decision: 'assign', category_id: 'c3' })) })
      },
    }
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, model)
    expect(run.preview.counts.categories).toBe(3)
    const result = await orchestrator.execute(run.preview)
    expect(result.error).toBeNull()
    const work = memory.nodes.get(result.createdFolders[0].id)!
    const development = [...memory.nodes.values()].find(node => node.parentId === work.id)!
    const frontend = [...memory.nodes.values()].find(node => node.parentId === development.id)!
    expect(work.title).toBe('工作')
    expect(development.title).toBe('开发')
    expect(memory.titlesOf(frontend.id)).toEqual(['A', 'B'])
  })

  it('删除中间节点会连同子树并将书签置为待确认', () => {
    const result = buildPreview({
      snapshot: {
        rootId: 'root',
        rootTitle: '书签栏',
        nodes: [{ id: 'b1', parentId: 'root', title: 'A', url: 'https://a.example.com', index: 0 }],
        bookmarks: [{ id: 'b1', parentId: 'root', title: 'A', url: 'https://a.example.com', index: 0 }],
        unclassifiable: [],
        effectiveLimit: 3,
      },
      categories: [{ id: 'c1', name: '工作', parentId: null, children: [{ id: 'c2', name: '开发', parentId: 'c1', children: [{ id: 'c3', name: '前端', parentId: 'c2', children: [] }] }] }],
      decisions: [{ bookmarkId: 'b1', kind: 'assign', categoryId: 'c3' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      const next = deleteCategory(result.preview, 'c2')
      expect(next.categories).toHaveLength(1)
      expect(next.categories[0].children).toHaveLength(0)
      expect(next.rows[0].categoryId).toBeNull()
      expect(next.counts.categories).toBe(1)
    }
  })

  it('超深、超限与同级重名的嵌套方案被拒绝且不改动书签', async () => {
    const cases: Array<[unknown, string]> = [
      [[{ name: '一', children: [{ name: '二', children: [{ name: '三', children: [{ name: '四' }] }] }] }], '超过三层'],
      [[{ name: '一' }, { name: '二' }, { name: '三' }, { name: '四' }], '第 1 层分类超过上限 3'],
      [[{ name: '一', children: [{ name: '二' }, { name: '三' }, { name: '四' }, { name: '五' }] }], '第 2 层分类超过上限 3'],
      [[{ name: '一', children: [{ name: '二' }, { name: ' 二 ' }] }], '同级分类名称重复'],
      [[{ name: '一', children: [{ name: '二/三' }] }], '分类名称不可用'],
      [[{ name: '一', children: [{ name: '二' }, { name: '三' }] }, { name: '四', children: [{ name: '五' }, { name: '六' }] }], '第 2 层分类超过上限 3'],
    ]
    for (const [categories, message] of cases) {
      const { memory, root } = nestedFixture()
      const orchestrator = createOrchestrator(memory.createTree())
      await expect(orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, new NestedModel(categories))).rejects.toThrow(message)
      expect(memory.titlesOf(root)).toEqual(['A', 'B', 'C'])
    }
  })

  it('上限按层累计，而不是整棵树的总量', async () => {
    const { memory, root } = nestedFixture()
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, new NestedModel([
      { name: '一', children: [{ name: '甲' }] },
      { name: '二', children: [{ name: '乙' }] },
      { name: '三', children: [{ name: '丙' }] },
    ]))
    expect(run.preview.counts.categories).toBe(6)
  })

  it('嵌套节点重命名到同级同名会被阻断，跨层级同名允许', async () => {
    const { memory, root } = nestedFixture()
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, new NestedModel([{ name: '工作', children: [{ name: '开发' }, { name: '设计' }] }]))
    expect(flattenCategories(run.preview.categories).map(category => category.id)).toEqual(['c1', 'c2', 'c3'])
    expect(orchestrator.blockingOf(run.preview)).toEqual([])
    expect(orchestrator.blockingOf(renameCategory(run.preview, 'c2', '设计'))).toContain('同级分类名称重复：设计')
    expect(orchestrator.blockingOf(renameCategory(run.preview, 'c2', '工作'))).toEqual([])
  })

  it('嵌套路径下移动失败后按原位置恢复并清理空文件夹', async () => {
    const { memory, root } = nestedFixture()
    const tree = memory.createTree()
    let moves = 0
    const failing: BookmarkTree = {
      ...tree,
      move: async (id, parentId, index) => {
        moves++
        if (moves > 1)
          throw new Error('模拟移动失败')
        return tree.move(id, parentId, index)
      },
    }
    const orchestrator = createOrchestrator(failing)
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, new NestedModel([{ name: '工作', children: [{ name: '开发', children: [{ name: '前端' }] }] }], 'c3'))
    const result = await orchestrator.execute(run.preview)
    expect(result.error).toContain('失败')
    expect(result.moved).toBe(1)
    const report = await recover(result.recovery!, memory.createTree())
    expect(report.restored).toBe(1)
    expect(report.conflicts).toEqual([])
    expect(report.removedFolders).toHaveLength(3)
    expect(memory.titlesOf(root)).toEqual(['A', 'B', 'C'])
  })

  it('嵌套文件夹的整次撤销可用，相关节点变化后禁用', async () => {
    const { memory, root } = nestedFixture()
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, new NestedModel([{ name: '工作', children: [{ name: '开发', children: [{ name: '前端' }] }] }], 'c3'))
    const result = await orchestrator.execute(run.preview)
    const record = recordOf(run.preview, root, result)
    expect(await orchestrator.checkUndo(record)).toEqual({ state: 'available' })
    const report = await orchestrator.undo(record)
    expect(report.conflicts).toEqual([])
    expect(report.restored).toBe(3)
    expect(report.removedFolders).toHaveLength(3)
    expect(memory.titlesOf(root)).toEqual(['A', 'B', 'C'])

    const again = await orchestrator.execute(run.preview)
    await memory.createTree().renameFolder(again.createdFolders[1].id, '开发改名')
    const status = await orchestrator.checkUndo(recordOf(run.preview, root, again))
    expect(status.state).toBe('disabled')
    expect(status.state === 'disabled' && status.reasons.some(reason => reason.includes('已被改名'))).toBe(true)
  })

  it('完整路径相同才算未移动，同名不同路径仍会移动', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    const flat = memory.addFolder(root, '开发')
    memory.addBookmark(flat, 'A', 'https://a.example.com/')
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 3, requirement: '' }, new NestedModel([{ name: '工作', children: [{ name: '开发' }] }], 'c2'))
    expect(run.preview.counts).toMatchObject({ unchanged: 0, moving: 1, pending: 0 })
    expect(orchestrator.blockingOf(run.preview)).toEqual([])
    const result = await orchestrator.execute(run.preview)
    expect(result.error).toBeNull()
    expect(result.createdFolders.map(folder => folder.name)).toEqual(['工作', '开发'])
    const work = memory.nodes.get(result.createdFolders[0].id)!
    const nested = [...memory.nodes.values()].find(node => node.parentId === work.id)!
    expect(memory.titlesOf(nested.id)).toEqual(['A'])
    expect(memory.titlesOf(flat)).toEqual([])

    const samePath = new MemoryTree()
    const sameRoot = samePath.addFolder('root', '书签栏')
    const workFolder = samePath.addFolder(sameRoot, '工作')
    const devFolder = samePath.addFolder(workFolder, '开发')
    samePath.addBookmark(devFolder, 'A', 'https://a.example.com/')
    const sameOrchestrator = createOrchestrator(samePath.createTree())
    const sameRun = await sameOrchestrator.classify({ rootId: sameRoot, categoryLimit: 3, requirement: '' }, new NestedModel([{ name: '工作', children: [{ name: '开发' }] }], 'c2'))
    expect(sameRun.preview.counts).toMatchObject({ unchanged: 1, moving: 0 })
    expect(sameOrchestrator.blockingOf(sameRun.preview)).toContain('没有需要移动的书签')
  })
})
