import { describe, expect, it } from 'vitest'
import { MemoryTree } from './memory-tree'
import { createOrchestrator } from '~/core/classifier'
import { buildPreview, groupRows, pendingRows } from '~/core/plan'
import { sanitizeUrl } from '~/core/text'
import type { ChatMessage, ModelClient, OperationResult, Preview, ScopeSnapshot } from '~/core/types'

/** 与 Sidepanel 一致地构建撤销记录（原始 URL 用于校验，脱敏 URL 用于展示）。 */
function makeRecord(preview: Preview, rootId: string, result: OperationResult) {
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

class AssignAll implements ModelClient {
  async complete(messages: ChatMessage[]): Promise<string> {
    const prompt = messages[0].content
    if (prompt.includes('"summary"'))
      return JSON.stringify({ summary: '摘要' })
    if (prompt.includes('归并主题'))
      return JSON.stringify({ categories: [{ name: '工作' }] })
    const batch = prompt.slice(prompt.indexOf('本批书签'))
    const ids = [...batch.matchAll(/"id":"([^"]+)"/g)].map(match => match[1])
    return JSON.stringify({ decisions: ids.map(id => ({ bookmark_id: id, decision: 'assign', category_id: 'c1' })) })
  }
}

describe('预览与撤销的 URL 处理', () => {
  it('预览只暴露脱敏 URL，撤销记录保留原始 URL 且立即可用', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    memory.addBookmark(root, '带参数', 'https://example.com/doc?token=secret#part')
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, new AssignAll())

    expect(run.preview.rows[0].displayUrl).toBe(sanitizeUrl('https://example.com/doc?token=secret#part'))
    expect(run.preview.rows[0].displayUrl).not.toContain('secret')

    const result = await orchestrator.execute(run.preview)
    expect(await orchestrator.checkUndo(makeRecord(run.preview, root, result))).toEqual({ state: 'available' })
  })
})

/** 三层分类树加一个待确认书签：覆盖筛选、缩进与同名不同路径。 */
function treePreview() {
  const snapshot: ScopeSnapshot = {
    rootId: 'root',
    rootTitle: '书签栏',
    nodes: [
      { id: 'b1', parentId: 'root', title: 'A1', url: 'https://a1.example.com/', index: 0 },
      { id: 'b2', parentId: 'root', title: 'B2', url: 'https://b2.example.com/', index: 1 },
      { id: 'b3', parentId: 'root', title: 'C3', url: 'https://c3.example.com/', index: 2 },
    ],
    bookmarks: [
      { id: 'b1', parentId: 'root', title: 'A1', url: 'https://a1.example.com/', index: 0 },
      { id: 'b2', parentId: 'root', title: 'B2', url: 'https://b2.example.com/', index: 1 },
      { id: 'b3', parentId: 'root', title: 'C3', url: 'https://c3.example.com/', index: 2 },
    ],
    unclassifiable: [],
    effectiveLimit: 3,
  }
  const categories = [
    { id: 'c1', name: '工作', parentId: null, children: [{ id: 'c2', name: '开发', parentId: 'c1', children: [{ id: 'c3', name: '前端', parentId: 'c2', children: [] }] }] },
    { id: 'c4', name: '生活', parentId: null, children: [{ id: 'c5', name: '开发', parentId: 'c4', children: [] }] },
  ]
  const built = buildPreview({
    snapshot,
    categories,
    decisions: [
      { bookmarkId: 'b1', kind: 'assign', categoryId: 'c1' },
      { bookmarkId: 'b2', kind: 'assign', categoryId: 'c5' },
      { bookmarkId: 'b3', kind: 'pending' },
    ],
  })
  if (!built.ok)
    throw new Error(built.error)
  return built.preview
}

describe('预览分组与筛选', () => {
  it('按深度优先顺序给出缩进深度与完整路径标签', () => {
    const groups = groupRows(treePreview(), '')
    expect(groups.map(group => [group.category.id, group.depth, group.label])).toEqual([
      ['c1', 0, '工作'],
      ['c2', 1, '工作 / 开发'],
      ['c3', 2, '工作 / 开发 / 前端'],
      ['c4', 0, '生活'],
      ['c5', 1, '生活 / 开发'],
    ])
  })

  it('筛选保留命中节点及其祖先，并展开命中节点自身', () => {
    const own = groupRows(treePreview(), 'A1')
    expect(own.map(group => [group.category.id, group.expanded])).toEqual([['c1', true]])
    expect(own[0].rows.map(row => row.bookmarkId)).toEqual(['b1'])

    const nested = groupRows(treePreview(), 'B2')
    expect(nested.map(group => [group.category.id, group.expanded])).toEqual([['c4', true], ['c5', true]])
    expect(groupRows(treePreview(), '没有命中')).toEqual([])
  })

  it('待确认计数与列表使用同一份筛选结果', () => {
    const preview = treePreview()
    expect(pendingRows(preview, '').map(row => row.bookmarkId)).toEqual(['b3'])
    expect(pendingRows(preview, 'C3').map(row => row.bookmarkId)).toEqual(['b3'])
    expect(pendingRows(preview, 'A1')).toEqual([])
  })
})
