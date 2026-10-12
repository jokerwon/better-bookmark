import { describe, expect, it } from 'vitest'
import { MemoryTree } from './memory-tree'
import { createOrchestrator } from '~/core/classifier'
import type { ChatMessage, ModelClient, UndoRecord } from '~/core/types'

/** 按分类名顺序给每批书签平均分配，用于覆盖多分类场景。 */
class PlanModel implements ModelClient {
  constructor(private names: string[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const prompt = messages[0].content
    if (prompt.includes('"summary"'))
      return JSON.stringify({ summary: '摘要' })
    if (prompt.includes('一级中文分类'))
      return JSON.stringify({ categories: this.names.map(name => ({ name })) })
    const batch = prompt.slice(prompt.indexOf('本批书签'))
    const ids = [...batch.matchAll(/"id":"([^"]+)"/g)].map(match => match[1])
    const idsByCategory = [...prompt.matchAll(/"id":"(c\d+)"/g)].map(match => match[1])
    return JSON.stringify({
      decisions: ids.map((id, i) => ({ bookmark_id: id, decision: 'assign', category_id: idsByCategory[i % idsByCategory.length] })),
    })
  }
}

function undoOf(record: UndoRecord, mutate: (entry: UndoRecord['entries'][number]) => void = () => {}): UndoRecord {
  const clone = structuredClone(record)
  clone.entries.forEach(mutate)
  return clone
}

describe('分类方案与撤销的边界', () => {
  it('模型给出的规范化重名或非法名称直接失败', async () => {
    for (const names of [['开发', '开发 '], ['开发/工具'], ['']]) {
      const memory = new MemoryTree()
      const root = memory.addFolder('root', '书签栏')
      memory.addBookmark(root, 'A', 'https://a.example.com/')
      memory.addBookmark(root, 'B', 'https://b.example.com/')
      const orchestrator = createOrchestrator(memory.createTree())
      await expect(orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, new PlanModel(names))).rejects.toThrow()
      expect(memory.titlesOf(root)).toEqual(['A', 'B'])
    }
  })

  it('没有书签落入的分类不会创建空文件夹', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    memory.addBookmark(root, 'A', 'https://a.example.com/')
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, new PlanModel(['开发', '生活']))
    // 删除其中一个分类，其书签回到待确认。
    const preview = { ...run.preview, categories: run.preview.categories.slice(0, 1), rows: run.preview.rows.map(row => ({ ...row, categoryId: row.categoryId === 'c2' ? null : row.categoryId })) }
    const result = await orchestrator.execute(preview)
    expect(result.moved).toBe(1)
    expect(memory.titlesOf(root).filter(title => title === '生活')).toEqual([])
  })

  it('书签顺序被调整后整次撤销被禁用', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    memory.addBookmark(root, 'A', 'https://a.example.com/')
    memory.addBookmark(root, 'B', 'https://b.example.com/')
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, new PlanModel(['开发']))
    const result = await orchestrator.execute(run.preview)
    const record = {
      createdAt: Date.now(),
      rootId: root,
      categories: run.preview.categories,
      entries: result.changes.map((change) => {
        const row = run.preview.fingerprint.find(([id]) => id === change.nodeId)!
        return {
          bookmarkId: change.nodeId,
          fromParent: row[1],
          toParent: change.toParent,
          fromIndex: Number(row[4]),
          toIndex: change.toIndex,
          title: row[2],
          url: row[3],
        }
      }),
      createdFolders: result.createdFolders,
      changes: result.changes,
    }
    expect(await orchestrator.checkUndo(record)).toEqual({ state: 'available' })

    const target = result.createdFolders[0].id
    const [first] = memory.idsOf(target)
    const tree = memory.createTree()
    await tree.move(first, target, 1)
    expect((await orchestrator.checkUndo(record)).state).toBe('disabled')
  })

  it('创建的分类文件夹被改名后整次撤销被禁用', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    memory.addBookmark(root, 'A', 'https://a.example.com/')
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, new PlanModel(['开发']))
    const result = await orchestrator.execute(run.preview)
    memory.external({ id: result.createdFolders[0].id, title: '被改名' })
    const record = {
      createdAt: Date.now(),
      rootId: root,
      categories: run.preview.categories,
      entries: result.changes.map((change) => {
        const row = run.preview.fingerprint.find(([id]) => id === change.nodeId)!
        return {
          bookmarkId: change.nodeId,
          fromParent: row[1],
          toParent: change.toParent,
          fromIndex: Number(row[4]),
          toIndex: change.toIndex,
          title: row[2],
          url: row[3],
        }
      }),
      createdFolders: result.createdFolders,
      changes: result.changes,
    }
    expect((await orchestrator.checkUndo(record)).state).toBe('disabled')
    // 撤销在存在冲突时不得做任何部分恢复：书签仍留在目标文件夹中。
    const report = await orchestrator.undo(undoOf(record))
    expect(report.restored).toBe(0)
    expect(memory.titlesOf(result.createdFolders[0].id)).toEqual(['A'])
  })

  it('部分分类复用既有文件夹时，撤销仍然可用且复原正确', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    // 既有同名文件夹会被复用，因此它不会出现在 createdFolders 里。
    const reused = memory.addFolder(root, '开发')
    memory.addBookmark(reused, '旧书签', 'https://old.example.com/')
    memory.addBookmark(root, 'A', 'https://a.example.com/')
    memory.addBookmark(root, 'B', 'https://b.example.com/')

    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, new PlanModel(['开发', '生活']))
    const result = await orchestrator.execute(run.preview)

    // 一个分类复用既有文件夹，另一个新建：只记录新建的那个。
    expect(result.createdFolders).toHaveLength(1)
    const created = result.createdFolders[0]
    expect(created.name).toBe('生活')
    expect(memory.nodes.get(created.id)!.title).toBe('生活')

    const record = {
      createdAt: Date.now(),
      rootId: root,
      categories: run.preview.categories,
      // 只有发生移动的书签进入撤销记录。
      entries: result.changes.map((change) => {
        const row = run.preview.fingerprint.find(([id]) => id === change.nodeId)!
        return {
          bookmarkId: change.nodeId,
          fromParent: row[1],
          toParent: change.toParent,
          fromIndex: Number(row[4]),
          toIndex: change.toIndex,
          title: row[2],
          url: row[3],
        }
      }),
      createdFolders: result.createdFolders,
      changes: result.changes,
    }
    expect(await orchestrator.checkUndo(record)).toEqual({ state: 'available' })
    const report = await orchestrator.undo(undoOf(record))
    expect(report.conflicts).toEqual([])
    expect(memory.titlesOf(root)).toEqual(['开发', 'A', 'B'])
    expect(memory.titlesOf(reused)).toEqual(['旧书签'])
  })
})
