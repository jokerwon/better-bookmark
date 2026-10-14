import type { BookmarkTree, BookmarkView, Category, CreatedFolder, Decision, OperationResult, Preview, Progress, RecoveryState, ScopeSnapshot, UndoRecord, UndoStatus } from './types'
import type { ModelClient } from './model'
import { extractJson, withRetries } from './model'
import { BATCH_SIZE, type RawCategory, SUMMARY_BATCH_SIZE, chunk, classifyPrompt, parseDecisions, parsePlan, parseSummary, planPrompt, summarizePrompt, validateBatch } from './prompt'
import { buildPreview, buildSnapshot, cloneCategories, fingerprintOf, flattenCategories, previewBlocking, recount, sameFingerprint } from './plan'
import { applyUndo, checkUndo, executePreview, indexOf, recover } from './lifecycle'
import { findIgnoredRequirements, normalizeName, sanitizeUrl, validateCategoryName } from './text'

export class OperationError extends Error {
  blocked: boolean

  constructor(message: string, blocked: boolean) {
    super(message)
    this.name = 'OperationError'
    this.blocked = blocked
  }
}

export interface RunParams {
  rootId: string
  categoryLimit: number
  requirement: string
}

export interface OrchestratorHooks {
  onProgress?: (progress: Progress) => void
  concurrency?: number
}

export interface Classification {
  preview: Preview
  ignoredRequirements: string[]
  skipped: boolean
}

export interface Orchestrator {
  classify: (params: RunParams, model: ModelClient) => Promise<Classification>
  execute: (preview: Preview) => Promise<OperationResult>
  refresh: (preview: Preview) => Preview
  blockingOf: (preview: Preview) => string[]
  checkUndo: (record: UndoRecord | null) => Promise<UndoStatus>
  undo: (record: UndoRecord) => Promise<{ restored: number, removedFolders: string[], conflicts: string[] }>
  recover: (state: RecoveryState) => Promise<{ restored: number, conflicts: string[], removedFolders: string[] }>
  cancel: () => void
}

/** 分类流程：局部主题摘要 → 全局分类树方案 → 按冻结方案分批裁决 → 预览。 */
export function createOrchestrator(tree: BookmarkTree, hooks: OrchestratorHooks = {}): Orchestrator {
  let abort: AbortController | null = null

  async function classify(params: RunParams, model: ModelClient): Promise<Classification> {
    const ignoredRequirements = findIgnoredRequirements(params.requirement)
    abort = new AbortController()
    const signal = abort.signal
    try {
      const root = await tree.get(params.rootId)
      if (!root || root.url !== undefined)
        throw new OperationError('请选择一个有效的书签文件夹', true)

      const snapshot = buildSnapshot({
        rootId: params.rootId,
        rootTitle: root.title,
        nodes: await tree.subtree(params.rootId),
        categoryLimit: params.categoryLimit,
      })
      if (snapshot.bookmarks.length === 0)
        return { preview: emptyPreview(snapshot), ignoredRequirements, skipped: true }

      const ask = async (prompt: string, stage: Progress['stage'], done: number, total: number) => {
        const content = await withRetries(
          () => model.complete([{ role: 'user', content: prompt }]),
          () => hooks.onProgress?.({ stage, done, total, retries: 1, message: '重试中' }),
        )
        ensureNotAborted(signal)
        hooks.onProgress?.({ stage, done, total, retries: 0, message: '' })
        return content
      }

      const summaries = await mapWithConcurrency(
        chunk(snapshot.bookmarks, SUMMARY_BATCH_SIZE),
        hooks.concurrency ?? 2,
        async (batch, index, count) => parseSummary(extractJson(await ask(
          summarizePrompt(snapshot.effectiveLimit, rowsOf(snapshot, batch), params.requirement),
          'summarize',
          index + 1,
          count,
        ))),
      )
      const planned = await ask(planPrompt(snapshot.effectiveLimit, summaries, params.requirement), 'plan', 1, 1)
      const categories = toCategories(parsePlan(extractJson(planned)), snapshot.effectiveLimit)
      const categoryOptions = flattenCategories(categories).map(category => ({ id: category.id, name: category.name, parent_id: category.parentId }))

      const batches = chunk(snapshot.bookmarks, BATCH_SIZE)
      const decisions: Decision[] = []
      await mapWithConcurrency(batches, hooks.concurrency ?? 2, async (batch, index) => {
        const prompted = rowsOf(snapshot, batch)
        const raw = await ask(classifyPrompt(categoryOptions, prompted, params.requirement), 'classify', index + 1, batches.length)
        decisions.push(...validateBatch(prompted, parseDecisions(extractJson(raw))))
      })

      const built = buildPreview({ snapshot, categories, decisions })
      if (!built.ok)
        throw new OperationError(built.error, true)
      return { preview: built.preview, ignoredRequirements, skipped: false }
    }
    finally {
      abort = null
    }
  }

  function refresh(preview: Preview): Preview {
    const next: Preview = {
      ...preview,
      categories: cloneCategories(preview.categories),
      rows: preview.rows.map(row => ({ ...row })),
    }
    recount(next)
    return next
  }

  async function execute(preview: Preview): Promise<OperationResult> {
    if (!sameFingerprint(preview.fingerprint, await tree.liveFingerprint(preview.rootId)))
      throw new OperationError('书签在预览后发生了变化，请重新生成预览', true)

    const base = {
      unchanged: preview.counts.unchanged,
      pending: preview.counts.pending,
      unclassifiable: preview.counts.unclassifiable,
      targets: flattenCategories(preview.categories).map(c => c.name),
    }
    const result = await executePreview(preview, tree)
    if (!result.ok) {
      return {
        ...base,
        moved: result.completed.length,
        createdFolders: result.createdFolders,
        undo: { state: 'none' },
        changes: [],
        recovery: result.completed.length || result.createdFolders.length
          ? { rootId: preview.rootId, createdAt: Date.now(), createdFolders: result.createdFolders, completed: result.completed, remaining: result.remaining }
          : null,
        error: result.error,
      }
    }

    const toIndexByNode = new Map<string, number>()
    for (const parentId of new Set(result.changes.map(change => change.toParent))) {
      for (const child of await tree.children(parentId))
        toIndexByNode.set(child.id, child.index)
    }
    const record = makeUndoRecord(preview, result.changes, result.createdFolders, toIndexByNode)
    return {
      ...base,
      moved: result.changes.length,
      createdFolders: result.createdFolders,
      undo: record ? { state: 'available' } : { state: 'none' },
      changes: result.changes,
      recovery: null,
      error: null,
    }
  }

  function makeUndoRecord(preview: Preview, changes: OperationResult['changes'], createdFolders: CreatedFolder[], toIndexByNode = new Map<string, number>()): UndoRecord | null {
    const entries: UndoRecord['entries'] = []
    for (const change of changes) {
      const record = preview.fingerprint.find(([id]) => id === change.nodeId)
      if (!record)
        continue
      entries.push({
        bookmarkId: change.nodeId,
        fromParent: record[1],
        toParent: change.toParent,
        fromIndex: indexOf(preview, change.nodeId),
        toIndex: toIndexByNode.get(change.nodeId) ?? 0,
        title: record[2],
        url: record[3],
      })
    }
    if (!entries.length)
      return null
    return {
      createdAt: Date.now(),
      rootId: preview.rootId,
      categories: cloneCategories(preview.categories),
      entries,
      createdFolders: createdFolders.map(folder => ({ ...folder })),
      changes,
    }
  }

  return {
    classify,
    execute,
    refresh,
    blockingOf: previewBlocking,
    checkUndo: record => checkUndo(record, tree),
    undo: record => applyUndo(record, tree),
    recover: state => recover(state, tree),
    cancel: () => abort?.abort(),
  }
}

function ensureNotAborted(signal: AbortSignal): void {
  if (signal.aborted)
    throw new OperationError('操作已取消', false)
}

function rowsOf(snapshot: ScopeSnapshot, batch: BookmarkView[]): Array<{ id: string, title: string, url: string, path: string }> {
  const byId = new Map(snapshot.nodes.map(node => [node.id, node]))
  const pathOf = (node: BookmarkView) => {
    const parts: string[] = []
    let cursor = node.parentId
    while (cursor && cursor !== snapshot.rootId) {
      const parent = byId.get(cursor)
      if (!parent)
        break
      parts.unshift(parent.title)
      cursor = parent.parentId
    }
    return parts.join('/')
  }
  return batch.map(node => ({ id: node.id, title: node.title, url: sanitizeUrl(node.url ?? '') ?? '', path: pathOf(node) }))
}

function emptyPreview(snapshot: ScopeSnapshot): Preview {
  return {
    rootId: snapshot.rootId,
    categories: [],
    rows: [],
    fingerprint: fingerprintOf(snapshot),
    counts: { total: 0, moving: 0, unchanged: 0, pending: 0, unclassifiable: snapshot.unclassifiable.length, categories: 0 },
    blocking: ['没有可分类的书签'],
  }
}

/** 模型嵌套方案 → 扩展自有稳定分类 ID；不截断、不合并、不放宽限制。 */
function toCategories(rawCategories: RawCategory[], limit: number): Category[] {
  if (!rawCategories.length)
    throw new OperationError('模型没有给出可用的分类名称', true)
  let nextId = 1
  const visit = (items: RawCategory[], parentId: string | null, depth: number): Category[] => {
    if (depth > 3 && items.length)
      throw new OperationError('模型生成的分类树超过三层', true)
    if (items.length > limit)
      throw new OperationError(`模型生成的第 ${depth} 层分类超过上限 ${limit}`, true)
    const used = new Set<string>()
    return items.map((raw) => {
      const name = String(raw.name).trim()
      const invalid = validateCategoryName(name)
      if (invalid)
        throw new OperationError(`模型给出的分类名称不可用（${invalid}）`, true)
      const key = normalizeName(name)
      if (used.has(key))
        throw new OperationError(`模型给出的同级分类名称重复：${name}`, true)
      used.add(key)
      const id = `c${nextId++}`
      return { id, name, parentId, children: visit(raw.children ?? [], id, depth + 1) }
    })
  }
  return visit(rawCategories, null, 1)
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, run: (item: T, index: number, count: number) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await run(items[index], index, items.length)
    }
  })
  await Promise.all(workers)
  return results
}
