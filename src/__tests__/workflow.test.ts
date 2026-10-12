import { describe, expect, it } from 'vitest'
import { recover } from '../core/lifecycle'
import type { ChatMessage, ModelClient } from '../core/types'
import { MemoryTree } from './memory-tree'
import { createOrchestrator } from '~/core/classifier'

/** 确定性模型客户端：按提示内容分派固定答案，并记录收到的请求。 */
class ScriptedModel implements ModelClient {
  requests: ChatMessage[][] = []
  summaries: string[]
  categories: string[]
  decisionsPerBatch: Array<(ids: string[], categories: Array<{ id: string, name: string }>) => unknown>
  batch = 0

  constructor(options: { summaries?: string[], categories?: string[], decisionsPerBatch?: ScriptedModel['decisionsPerBatch'] } = {}) {
    this.summaries = options.summaries ?? ['主题：开发工具与文档']
    this.categories = options.categories ?? ['开发工具', '生活']
    this.decisionsPerBatch = options.decisionsPerBatch ?? []
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    this.requests.push(messages)
    const prompt = messages[0].content
    if (prompt.includes('"summary"'))
      return JSON.stringify({ summary: this.summaries[Math.floor(Math.random() * 0)] })
    if (prompt.includes('一级中文分类'))
      return JSON.stringify({ categories: this.categories.map(name => ({ name })) })
    const batch = prompt.slice(prompt.indexOf('本批书签'))
    const ids = [...batch.matchAll(/"id":"([^"]+)"/g)].map(match => match[1])
    const categories = [...prompt.matchAll(/"id":"(c\d+)","name":"([^"]+)"/g)].map(match => ({ id: match[1], name: match[2] }))
    const handler = this.decisionsPerBatch[Math.min(this.batch, this.decisionsPerBatch.length - 1)]
    this.batch++
    if (handler)
      return JSON.stringify({ decisions: handler(ids, categories) })
    return JSON.stringify({ decisions: ids.map(id => ({ bookmark_id: id, decision: 'assign', category_id: categories[0].id })) })
  }
}

function fixture() {
  const memory = new MemoryTree()
  const root = memory.addFolder('root', '书签栏')
  memory.addBookmark(root, 'MDN', 'https://developer.mozilla.org/docs?q=hidden#hash')
  memory.addBookmark(root, 'GitHub', 'https://github.com/user/repo')
  const nested = memory.addFolder(root, '工作')
  memory.addBookmark(nested, 'Jira', 'https://jira.example.com/browse/PROJ-1')
  return { memory, root, tree: memory.createTree() }
}

async function classifyWith(model: ModelClient, memory: MemoryTree, root: string, requirement = '') {
  const orchestrator = createOrchestrator(memory.createTree())
  return await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement }, model)
}

describe('端到端分类工作流', () => {
  it('空范围不调用模型', async () => {
    const memory = new MemoryTree()
    const empty = memory.addFolder('root', '空文件夹')
    const model = new ScriptedModel()
    const run = await classifyWith(model, memory, empty)
    expect(model.requests).toHaveLength(0)
    expect(run.skipped).toBe(true)
  })

  it('只有标题、脱敏 URL 与相对路径进入请求', async () => {
    const { memory, root } = fixture()
    const model = new ScriptedModel()
    await classifyWith(model, memory, root)
    const text = model.requests.map(request => request[0].content).join('\n')
    expect(text).toContain('https://developer.mozilla.org/docs')
    expect(text).not.toContain('?q=hidden')
    expect(text).not.toContain('#hash')
    expect(text).toContain('"path":"工作"')
  })

  it('未知、重复、缺失或非法分类的裁决都会失败且不移动书签', async () => {
    const cases: Array<(ids: string[]) => unknown> = [
      () => [{ bookmark_id: 'nope', decision: 'pending' }],
      ids => [...ids.map(id => ({ bookmark_id: id, decision: 'pending' })), { bookmark_id: ids[0], decision: 'pending' }],
      ids => ids.slice(1).map(id => ({ bookmark_id: id, decision: 'pending' })),
      ids => [{ bookmark_id: ids[0], decision: 'assign', category_id: 'c99' }],
      ids => [{ bookmark_id: ids[0], decision: 'maybe' }],
    ]
    for (const handler of cases) {
      const { memory, root } = fixture()
      const before = memory.titlesOf(root)
      const run = classifyWith(new ScriptedModel({ decisionsPerBatch: [handler] }), memory, root)
      await expect(run).rejects.toThrow()
      expect(memory.titlesOf(root)).toEqual(before)
    }
  })

  it('执行后书签落到目标文件夹，且新增在既有内容之后', async () => {
    const { memory, root } = fixture()
    const existing = memory.addBookmark(root, '旧书签', 'https://old.example.com/')
    const model = new ScriptedModel({ categories: ['开发工具', '生活'] })
    const run = await classifyWith(model, memory, root)
    const orchestrator = createOrchestrator(memory.createTree())
    const preview = run.preview
    expect(preview.counts.moving).toBe(4)
    const result = await orchestrator.execute(preview)
    expect(result.error).toBeNull()
    expect(result.moved).toBe(4)
    const target = memory.nodes.get(result.createdFolders[0].id)!
    expect(target.title).toBe('开发工具')
    expect(preview.categories.find(c => c.id === 'c2')!.name).toBe('生活')
    expect(memory.titlesOf(target.id)).toEqual(['MDN', 'GitHub', 'Jira', '旧书签'])
    void existing
  })

  it('同名分类文件夹被复用且内容不被改动', async () => {
    const { memory, root } = fixture()
    const reuse = memory.addFolder(root, '开发工具')
    memory.addBookmark(reuse, '既有', 'https://existing.example.com/')
    const model = new ScriptedModel({ decisionsPerBatch: [ids => ids.map(id => ({ bookmark_id: id, decision: 'assign', category_id: 'c1' }))], categories: ['开发工具'] })
    const run = await classifyWith(model, memory, root)
    const orchestrator = createOrchestrator(memory.createTree())
    const result = await orchestrator.execute(run.preview)
    expect(result.createdFolders).toEqual([])
    expect(memory.titlesOf(reuse)).toEqual(['既有', 'MDN', 'GitHub', 'Jira'])
  })

  it('预览后书签被外部改动时拒绝执行', async () => {
    const { memory, root } = fixture()
    const model = new ScriptedModel()
    const run = await classifyWith(model, memory, root)
    memory.external({ id: 'b2', title: '改名了' })
    const orchestrator = createOrchestrator(memory.createTree())
    await expect(orchestrator.execute(run.preview)).rejects.toThrow('书签在预览后发生了变化')
  })

  it('移动失败时停止后续移动并可恢复', async () => {
    const { memory, root } = fixture()
    const tree = memory.createTree()
    let moves = 0
    const failing = {
      ...tree,
      move: async (id: string, parentId: string, index?: number) => {
        moves++
        if (moves > 1)
          throw new Error('模拟移动失败')
        return tree.move(id, parentId, index)
      },
    }
    const model = new ScriptedModel({ decisionsPerBatch: [ids => ids.map(id => ({ bookmark_id: id, decision: 'assign', category_id: 'c1' }))], categories: ['开发工具'] })
    const orchestrator = createOrchestrator(failing)
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, model)
    const result = await orchestrator.execute(run.preview)
    expect(result.error).toContain('失败')
    expect(result.moved).toBe(1)
    expect(result.recovery?.completed).toHaveLength(1)
    const report = await recover(result.recovery!, memory.createTree())
    expect(report.restored).toBe(1)
    expect(memory.titlesOf(root)).toContain('MDN')
  })

  it('撤销按原顺序恢复并禁用条件正确', async () => {
    const { memory, root } = fixture()
    const model = new ScriptedModel({ decisionsPerBatch: [ids => ids.map(id => ({ bookmark_id: id, decision: 'assign', category_id: 'c1' }))], categories: ['开发工具'] })
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, model)
    const preview = run.preview
    const result = await orchestrator.execute(preview)
    const record = {
      createdAt: Date.now(),
      rootId: root,
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
    expect(await orchestrator.checkUndo(record)).toEqual({ state: 'available' })
    const report = await orchestrator.undo(record)
    expect(report.restored).toBe(3)
    expect(memory.titlesOf(root)).toEqual(['MDN', 'GitHub', '工作'])
    expect(memory.nodes.has(record.createdFolders[0].id)).toBe(false)

    const second = await orchestrator.execute(run.preview)
    expect(second.moved).toBeGreaterThan(0)
  })

  it('相关节点变化后整次撤销被禁用', async () => {
    const { memory, root } = fixture()
    const model = new ScriptedModel({ decisionsPerBatch: [ids => ids.map(id => ({ bookmark_id: id, decision: 'assign', category_id: 'c1' }))], categories: ['开发工具'] })
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 5, requirement: '' }, model)
    const result = await orchestrator.execute(run.preview)
    memory.external({ id: result.changes[0].nodeId, title: '被改名' })
    const status = await orchestrator.checkUndo({
      createdAt: Date.now(),
      rootId: root,
      categories: run.preview.categories,
      entries: run.preview.fingerprint.filter(([id]) => result.changes.some(change => change.nodeId === id)).map(([id, parentId, title, url, index]) => ({ bookmarkId: id, fromParent: parentId, toParent: result.changes.find(change => change.nodeId === id)!.toParent, fromIndex: Number(index), toIndex: result.changes.find(change => change.nodeId === id)!.toIndex, title, url })),
      createdFolders: result.createdFolders,
      changes: result.changes,
    })
    expect(status.state).toBe('disabled')
  })

  it('5000 书签通过有界批次处理', async () => {
    const memory = new MemoryTree()
    const root = memory.addFolder('root', '书签栏')
    const folder = memory.addFolder(root, '收藏')
    for (let i = 0; i < 5000; i++)
      memory.addBookmark(i % 2 ? folder : root, `书签 ${i}`, `https://site${i}.example.com/a?i=${i}`)
    const model = new ScriptedModel({ decisionsPerBatch: [ids => ids.map(id => ({ bookmark_id: id, decision: 'pending' }))] })
    let maxInflight = 0
    let inflight = 0
    const instrumented: ModelClient = {
      async complete(messages) {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        const response = await model.complete(messages)
        inflight--
        return response
      },
    }
    const orchestrator = createOrchestrator(memory.createTree())
    const run = await orchestrator.classify({ rootId: root, categoryLimit: 8, requirement: '' }, instrumented)
    expect(run.preview.counts.total).toBe(5000)
    expect(run.preview.counts.pending).toBe(5000)
    expect(maxInflight).toBeLessThanOrEqual(2)
    expect(model.requests.length).toBeGreaterThan(120)
  })
})
