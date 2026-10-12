import { describe, expect, it } from 'vitest'
import { MemoryTree } from './memory-tree'
import { createOrchestrator } from '~/core/classifier'
import { sanitizeUrl } from '~/core/text'
import type { ChatMessage, ModelClient, OperationResult, Preview } from '~/core/types'

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
    if (prompt.includes('一级中文分类'))
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
