import { describe, expect, it } from 'vitest'
import { MemoryTree } from './memory-tree'
import { createOrchestrator } from '~/core/classifier'
import { buildPreview, deleteCategory, flattenCategories } from '~/core/plan'
import { parsePlan } from '~/core/prompt'
import type { ChatMessage, Decision, ModelClient, ScopeSnapshot } from '~/core/types'

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
})
