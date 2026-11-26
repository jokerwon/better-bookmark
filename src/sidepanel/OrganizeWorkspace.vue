<script setup lang="ts">
import { computed, h, nextTick, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import type { FunctionalComponent } from 'vue'
import { OperationError, StalePreviewError, createOrchestrator } from '~/core/classifier'
import { browserApi } from '~/core/browser-api'
import { createBrowserTree } from '~/core/browser-tree'
import { buildBackup, importBackup, parseBackup } from '~/core/backup'
import { resolveConfig } from '~/core/config'
import { CONNECTION_TEST_MESSAGES, ModelError, createModelClient } from '~/core/model'
import { ensureHostPermission } from '~/core/permissions'
import { deleteCategory, flattenCategories, groupRows, pendingRows, reassign, renameCategory } from '~/core/plan'
import { isClassifiable, normalizeName } from '~/core/text'
import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'
import type { BackupFile, BackupNode } from '~/core/backup'
import type { BookmarkView, OperationResult, Preview, PreviewRow, Progress, RecoveryState, UndoRecord, UndoStatus } from '~/core/types'

const props = withDefaults(defineProps<{ active: boolean }>(), { active: true })

const browserTree = createBrowserTree()

const state = reactive({
  roots: [] as BookmarkView[],
  rootId: '',
  /** 导入时备份根标题在当前浏览器找不到同名根，就落到这个文件夹。 */
  fallbackRootId: '',
  requirement: '',
  testing: false,
  testState: '' as '' | 'ok' | 'fail',
  testMessage: '',
  generating: false,
  progress: null as Progress | null,
  busy: false,
  message: '',
  warning: '',
  error: '',
  ignored: [] as string[],
  dropped: [] as BookmarkView[],
  filter: new URLSearchParams(location.search).get('filter') ?? '',
  result: null as OperationResult | null,
  undoStatus: { state: 'none' } as UndoStatus,
})

const config = useWebExtensionStorage('config', { apiKey: '', baseUrl: '', model: '', categoryLimit: 8 })
const consent = useWebExtensionStorage('consent', { originKey: '', acceptedAt: 0 })
const undoRecord = useWebExtensionStorage<UndoRecord | null>('undo', null)
const pendingRecovery = useWebExtensionStorage<RecoveryState | null>('recovery', null)
/** 待确认的备份文件；确认前不写入任何书签。 */
const pendingImport = ref<{ name: string, data: BackupFile, folders: number, bookmarks: number, other: number } | null>(null)

const orchestrator = createOrchestrator(browserTree, {
  onProgress: (progress) => { state.progress = progress },
})

const preview = shallowRef<Preview | null>(null)
const selected = ref<string[]>([])
const previewPanel = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)
const clearDialog = ref<HTMLDialogElement | null>(null)
/** 用户手动折叠/展开的分类；筛选变化时重置，确保命中路径可见。 */
const openOverrides = ref<Record<string, boolean>>({})

function syncFilterUrl() {
  const url = new URL(location.href)
  if (state.filter)
    url.searchParams.set('filter', state.filter)
  else
    url.searchParams.delete('filter')
  history.replaceState(history.state, '', url)
}

watch(() => state.filter, () => {
  openOverrides.value = {}
  syncFilterUrl()
})

const resolved = computed(() => resolveConfig(config.value))
/** 首次分类，以及 Base URL 或模型变化后，都需要重新确认隐私边界。 */
const consentNeeded = computed(() => resolved.value.ok && consent.value.originKey !== resolved.value.value.originKey)
const blocking = computed(() => (preview.value ? orchestrator.blockingOf(preview.value) : []))
/** 全部分类分组（不筛选）：批量改派下拉用它展示完整路径。 */
const allGroups = computed(() => preview.value ? groupRows(preview.value, '') : [])
const unmatchedRoots = computed(() => pendingImport.value
  ? pendingImport.value.data.roots.filter(root => !state.roots.some(live => live.title === root.title))
  : [])

interface BranchRow {
  row: PreviewRow
  status: 'moving' | 'unchanged'
  targetPath: string
  origin: string
}

interface PendingRow {
  row: PreviewRow
  origin: string
}

interface UnclassifiableRow {
  id: string
  title: string
  url: string
  origin: string
}

interface Branch {
  id: string
  name: string
  label: string
  rows: BranchRow[]
  children: Branch[]
  open: boolean
}

/** 预览树：真实嵌套，筛选只保留命中节点及其祖先。 */
const tree = computed(() => {
  const current = preview.value
  if (!current)
    return { branches: [] as Branch[], pending: [] as PendingRow[], unclassifiable: [] as UnclassifiableRow[] }

  const needle = state.filter.trim().toLowerCase()
  const parentById = new Map(current.fingerprint.map(([id, parentId]) => [id, parentId]))
  const titleById = new Map(current.fingerprint.map(([id, , title]) => [id, title]))
  const indexById = new Map(current.fingerprint.map(([id, , , , index]) => [id, index]))
  const rootLabel = state.roots.find(root => root.id === current.rootId)?.title || ''

  const originalFoldersOf = (bookmarkId: string): string[] => {
    const folders: string[] = []
    let cursor = parentById.get(bookmarkId) ?? ''
    while (cursor && cursor !== current.rootId && titleById.has(cursor)) {
      folders.unshift(titleById.get(cursor)!)
      cursor = parentById.get(cursor) ?? ''
    }
    return folders
  }
  const originOf = (bookmarkId: string): string => {
    const path = [rootLabel, ...originalFoldersOf(bookmarkId)].filter(Boolean)
    const index = Number(indexById.get(bookmarkId) ?? 0) + 1
    return `${path.join(' / ') || '未知位置'} · 第 ${index} 项`
  }

  const categoryById = new Map(flattenCategories(current.categories).map(category => [category.id, category]))
  const normalizedCategoryPath = (categoryId: string): string[] => {
    const names: string[] = []
    let category = categoryById.get(categoryId)
    while (category) {
      names.unshift(normalizeName(category.name))
      category = category.parentId ? categoryById.get(category.parentId) : undefined
    }
    return names
  }

  const branchRow = (row: PreviewRow, label: string): BranchRow => {
    // 与 core recount 的完整相对路径判定保持一致；原位置来自冻结指纹。
    const target = normalizedCategoryPath(row.categoryId!)
    const origin = originalFoldersOf(row.bookmarkId).map(normalizeName)
    const unchanged = target.length > 0 && target.length === origin.length && target.every((segment, index) => segment === origin[index])
    return {
      row,
      status: unchanged ? 'unchanged' : 'moving',
      targetPath: rootLabel ? `${rootLabel} / ${label}` : label,
      origin: originOf(row.bookmarkId),
    }
  }

  const branchesById = new Map<string, Branch>()
  const branches: Branch[] = []
  for (const group of groupRows(current, state.filter)) {
    const branch: Branch = {
      id: group.category.id,
      name: group.category.name,
      label: group.label,
      rows: group.rows.map(row => branchRow(row, group.label)),
      children: [],
      open: !needle || group.expanded,
    }
    branchesById.set(branch.id, branch)
    const parent = group.category.parentId ? branchesById.get(group.category.parentId) : undefined
    if (parent)
      parent.children.push(branch)
    else
      branches.push(branch)
  }

  const pending = pendingRows(current, state.filter).map(row => ({ row, origin: originOf(row.bookmarkId) }))
  // 无法分类直接从冻结快照指纹判定，不再依赖字符串错误或额外读取书签树。
  const unclassifiable = current.fingerprint
    .filter(([, , , url]) => url !== '' && !isClassifiable(url))
    .filter(([, , title, url]) => !needle || title.toLowerCase().includes(needle) || url.toLowerCase().includes(needle))
    .map(([id, , title, url]) => ({ id, title: title || url, url, origin: originOf(id) }))

  return { branches, pending, unclassifiable }
})

const emptyFilter = computed(() => !tree.value.branches.length && !tree.value.pending.length && !tree.value.unclassifiable.length)

let initialized = false

watch(() => props.active, async (active) => {
  if (!active)
    return
  try {
    if (!initialized) {
      state.roots = await browserTree.roots()
      state.rootId = state.roots.find(root => root.id.startsWith('1'))?.id ?? state.roots[0]?.id ?? ''
      state.fallbackRootId = state.rootId
      initialized = true
    }
    syncFilterUrl()
    await refreshUndo()
  }
  catch (error) {
    state.error = describe(error)
  }
}, { immediate: true })

onUnmounted(() => orchestrator.cancel())

async function refreshUndo() {
  state.undoStatus = await orchestrator.checkUndo(undoRecord.value)
}

function describe(error: unknown): string {
  if (error instanceof OperationError || error instanceof ModelError)
    return error.message
  return '操作失败，请检查配置后重试'
}

function openOptions() {
  browserApi.runtime.openOptionsPage()
}

function resetNotices() {
  state.error = ''
  state.message = ''
  state.warning = ''
}

async function testConnection() {
  if (state.testing || state.busy)
    return
  // 在等待权限前冻结配置；选项页并发修改不能把测试请求发到未确认的源。
  const currentConfig = { ...config.value }
  const currentResolved = resolveConfig(currentConfig)
  state.testing = true
  state.testState = ''
  state.testMessage = ''
  try {
    if (!currentResolved.ok)
      throw new OperationError(currentResolved.error, true)
    if (!(await ensureHostPermission(currentResolved.value.origin)))
      throw new OperationError('未授予该模型源的访问权限', true)
    // 固定测试消息，不含任何书签数据。
    await createModelClient(currentConfig).complete([...CONNECTION_TEST_MESSAGES])
    state.testState = 'ok'
    state.testMessage = '连接成功'
  }
  catch (error) {
    state.testState = 'fail'
    state.testMessage = describe(error)
  }
  finally {
    state.testing = false
  }
}

function acceptConsent() {
  if (!resolved.value.ok) {
    state.error = resolved.value.error
    return
  }
  consent.value = { originKey: resolved.value.value.originKey, acceptedAt: Date.now() }
  state.error = ''
}

async function classify() {
  if (state.busy || state.testing)
    return
  state.busy = true
  resetNotices()
  state.result = null
  state.ignored = []
  state.dropped = []
  // 权限提示/模型请求前冻结输入，避免选项页配置变化绕过隐私确认。
  const currentConfig = { ...config.value }
  const currentResolved = resolveConfig(currentConfig)
  const rootId = state.rootId
  const categoryLimit = currentConfig.categoryLimit
  const requirement = state.requirement
  try {
    if (!currentResolved.ok)
      throw new OperationError(currentResolved.error, true)
    if (consent.value.originKey !== currentResolved.value.originKey)
      throw new OperationError('请先确认隐私说明', true)
    if (!rootId)
      throw new OperationError('请选择要整理的文件夹', true)
    if (!(await ensureHostPermission(currentResolved.value.origin)))
      throw new OperationError('未授予该模型源的访问权限', true)

    state.generating = true
    const run = await orchestrator.classify(
      { rootId, categoryLimit, requirement },
      createModelClient(currentConfig),
    )
    preview.value = run.preview
    openOverrides.value = {}
    selected.value = []
    if (run.skipped) {
      preview.value = null
      state.message = '该文件夹内没有可分类的书签，未调用模型'
      state.dropped = (await browserTree.subtree(rootId)).filter(node => node.url !== undefined && !isClassifiable(node.url))
    }
    else {
      await nextTick()
      if (props.active)
        previewPanel.value?.focus()
    }
    state.ignored = run.ignoredRequirements
  }
  catch (error) {
    state.error = describe(error)
  }
  finally {
    state.busy = false
    state.generating = false
    state.progress = null
  }
}

function rename(categoryId: string, name: string) {
  if (!state.busy && preview.value)
    preview.value = renameCategory(preview.value, categoryId, name)
}

function drop(categoryId: string) {
  if (!state.busy && preview.value)
    preview.value = deleteCategory(preview.value, categoryId)
}

function toggleSelect(bookmarkId: string) {
  if (state.busy)
    return
  selected.value = selected.value.includes(bookmarkId)
    ? selected.value.filter(id => id !== bookmarkId)
    : [...selected.value, bookmarkId]
}

function batchAssign(categoryId: string | null) {
  if (!preview.value || !selected.value.length || state.busy)
    return
  preview.value = reassign(preview.value, selected.value, categoryId)
  selected.value = []
}

async function clearFilter() {
  state.filter = ''
  await nextTick()
  if (props.active)
    searchInput.value?.focus()
}

function invalidatePreview(message: string) {
  preview.value = null
  selected.value = []
  state.result = null
  state.warning = ''
  state.error = message
}

async function confirmExecute() {
  const current = preview.value
  if (!current || state.busy || pendingRecovery.value)
    return
  resetNotices()
  state.busy = true
  try {
    const result = await orchestrator.execute(current)
    state.result = result
    if (result.error) {
      state.error = result.recovery
        ? `${result.error}；已移动 ${result.recovery.completed.length} 个，未执行 ${result.recovery.remaining.length} 个`
        : result.error
      if (result.recovery)
        pendingRecovery.value = result.recovery
      return
    }
    preview.value = null
    // 只有发生移动才替换上一次的撤销记录；空操作保留旧记录。
    if (result.moved) {
      undoRecord.value = {
        createdAt: Date.now(),
        rootId: current.rootId,
        categories: current.categories.map(category => ({ ...category })),
        entries: current.fingerprint
          .filter(([id]) => result.changes.some(change => change.nodeId === id))
          .map(([id, parentId, title, url, index]) => ({
            bookmarkId: id,
            fromParent: parentId,
            toParent: result.changes.find(change => change.nodeId === id)!.toParent,
            fromIndex: Number(index),
            toIndex: result.changes.find(change => change.nodeId === id)!.toIndex,
            title,
            // 撤销校验需要与浏览器中的原始 URL 比对。
            url,
          })),
        createdFolders: result.createdFolders,
        changes: result.changes,
      }
    }
    state.message = `已移动 ${result.moved} 个书签`
    await refreshUndo()
  }
  catch (error) {
    // core 在执行前用实时指纹判定过期；这里只处理明确的过期类型。
    if (error instanceof StalePreviewError)
      invalidatePreview(error.message)
    else
      state.error = describe(error)
  }
  finally {
    state.busy = false
  }
}

async function runUndo() {
  if (!undoRecord.value || state.busy)
    return
  state.busy = true
  resetNotices()
  try {
    const report = await orchestrator.undo(undoRecord.value)
    if (report.conflicts.length) {
      state.warning = `已恢复 ${report.restored} 个书签；${report.conflicts.length} 个因冲突未恢复`
    }
    else {
      state.message = `已恢复 ${report.restored} 个书签`
      undoRecord.value = null
    }
    await refreshUndo()
  }
  catch (error) {
    state.error = describe(error)
  }
  finally {
    state.busy = false
  }
}

async function runRecovery() {
  if (!pendingRecovery.value || state.busy)
    return
  state.busy = true
  resetNotices()
  try {
    const report = await orchestrator.recover(pendingRecovery.value)
    if (report.conflicts.length) {
      state.warning = `已恢复 ${report.restored} 个书签；仍有 ${report.conflicts.length} 个冲突未恢复`
    }
    else {
      state.message = `已恢复 ${report.restored} 个书签`
    }
    // 仍有冲突时保留现场，便于用户查看原因后重试或自行处理。
    if (!report.conflicts.length)
      pendingRecovery.value = null
    await refreshUndo()
  }
  catch (error) {
    state.error = describe(error)
  }
  finally {
    state.busy = false
  }
}

function clearLocalData() {
  clearDialog.value?.close()
  // 只清除扩展本地数据，绝不删除浏览器书签。
  config.value = { apiKey: '', baseUrl: '', model: '', categoryLimit: 8 }
  consent.value = { originKey: '', acceptedAt: 0 }
  undoRecord.value = null
  pendingRecovery.value = null
  preview.value = null
  state.result = null
  state.ignored = []
  state.dropped = []
  resetNotices()
  state.message = '已清除本地配置、隐私确认、撤销记录与未完成恢复；浏览器书签未被改动'
  void refreshUndo()
}

/** 导出书签栏与其他书签的完整结构；文件里不含浏览器节点 ID。 */
async function exportBackup() {
  resetNotices()
  state.busy = true
  try {
    const data = await buildBackup(browserTree)
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `better-bookmark-backup-${data.exportedAt.slice(0, 10)}.json`
    link.click()
    // 等下载开始后再释放，避免下载被取消。
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    // 页面无法读取下载结果：只报告已触发的下载，不声称文件已落盘。
    state.message = `已开始下载 ${data.roots.length} 个根目录的备份文件`
  }
  catch (error) {
    state.error = describe(error)
  }
  finally {
    state.busy = false
  }
}

/** 统计将要创建的节点与协议外书签：根目录按标题匹配现有根，不会新建。 */
function countNodes(nodes: BackupNode[], counts = { folders: 0, bookmarks: 0, other: 0 }): { folders: number, bookmarks: number, other: number } {
  for (const node of nodes) {
    if (node.url !== undefined) {
      counts.bookmarks += 1
      if (!/^https?:\/\//i.test(node.url))
        counts.other += 1
    }
    else {
      counts.folders += 1
      countNodes(node.children ?? [], counts)
    }
  }
  return counts
}

/** 备份根标题 → 预计落地文件夹标题；同名根缺失时落到导入目标。 */
function importTargets(roots: BackupNode[]): string {
  return roots
    .map((root) => {
      const target = state.roots.find(live => live.title === root.title) ?? state.roots.find(live => live.id === state.fallbackRootId)
      return `${root.title}→${target?.title ?? '未选择文件夹'}`
    })
    .join('、')
}

/** 选择备份文件只做校验与统计，确认后才写入。 */
async function pickBackup(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 允许再次选择同一个文件。
  input.value = ''
  if (state.busy || !file)
    return
  resetNotices()
  pendingImport.value = null
  // 每次选文件都回到当前整理范围，用户仍可在摘要里改。
  state.fallbackRootId = state.rootId
  // 先按体积挡掉畸形文件，避免整份读进侧边栏内存；结构校验交给 parseBackup。
  if (file.size > 16 * 1024 * 1024) {
    state.error = '备份文件超过 16 MB，无法导入'
    return
  }
  try {
    const parsed = parseBackup(await file.text())
    if (!parsed.ok) {
      state.error = parsed.error
      return
    }
    pendingImport.value = { name: file.name, data: parsed.value, ...countNodes(parsed.value.roots.flatMap(root => root.children ?? [])) }
  }
  catch (error) {
    state.error = describe(error)
  }
}

async function confirmImport() {
  if (!pendingImport.value || state.busy)
    return
  state.busy = true
  resetNotices()
  try {
    const report = await importBackup(pendingImport.value.data, browserTree, state.fallbackRootId)
    const summary = `已导入 ${report.folders} 个文件夹、${report.bookmarks} 个书签到 ${report.roots.join('、')}`
    if (report.skipped || report.conflicts.length) {
      const skipped = report.skipped ? `；${report.skipped} 个节点未写入` : ''
      const conflicts = report.conflicts.length ? `；${report.conflicts.length} 个冲突` : ''
      state.warning = `${summary}${skipped}${conflicts}`
    }
    else {
      state.message = summary
    }
    pendingImport.value = null
    await refreshUndo()
  }
  catch (error) {
    state.error = describe(error)
  }
  finally {
    state.busy = false
  }
}

interface BranchProps {
  branch: Branch
  busy: boolean
  selected: string[]
  onSelectBookmark?: (bookmarkId: string) => void
  onRenameCategory?: (categoryId: string, name: string) => void
  onRemoveCategory?: (categoryId: string) => void
}

/** 递归渲染真实嵌套分类；父节点折叠即隐藏整棵子树。 */
const renderBranch: FunctionalComponent<BranchProps> = (branchProps) => {
  const branch = branchProps.branch
  const statusLabel = (status: BranchRow['status']) => status === 'unchanged' ? '保持不变' : '将移动'

  const rows = h('ul', { class: 'bookmark-list' }, branch.rows.map(view => h('li', { class: 'bookmark-row', key: view.row.bookmarkId }, [
    h('label', { class: 'bookmark-title' }, [
      h('input', {
        type: 'checkbox',
        checked: branchProps.selected.includes(view.row.bookmarkId),
        disabled: branchProps.busy,
        onChange: () => branchProps.onSelectBookmark?.(view.row.bookmarkId),
      }),
      h('span', view.row.title || view.row.displayUrl),
    ]),
    h('p', { class: 'bookmark-url', title: view.row.displayUrl }, view.row.displayUrl),
    h('p', { class: 'bookmark-meta' }, [
      h('span', { class: ['bookmark-status', `is-${view.status}`] }, statusLabel(view.status)),
      h('span', { class: 'bookmark-target' }, `目标：${view.targetPath}`),
    ]),
    h('p', { class: 'bookmark-origin' }, `原位：${view.origin}`),
  ])))

  const children = branch.children.map(child => h(renderBranch, {
    key: child.id,
    branch: child,
    busy: branchProps.busy,
    selected: branchProps.selected,
    onSelectBookmark: branchProps.onSelectBookmark,
    onRenameCategory: branchProps.onRenameCategory,
    onRemoveCategory: branchProps.onRemoveCategory,
  }))

  const open = openOverrides.value[branch.id] ?? branch.open
  return h('details', {
    class: 'category-group',
    open,
    onToggle: (event: Event) => {
      if (event.target !== event.currentTarget)
        return
      const element = event.currentTarget as HTMLDetailsElement
      openOverrides.value = { ...openOverrides.value, [branch.id]: element.open }
    },
  }, [
    h('summary', { class: 'category-summary-row' }, [
      h('span', { class: 'category-summary' }, [
        h('span', { class: 'category-marker' }),
        h('span', { class: 'category-name-block' }, [
          h('input', {
            'class': 'category-name',
            'value': branch.name,
            'disabled': branchProps.busy,
            'aria-label': `分类名称：${branch.name}`,
            'onClick': (event: Event) => event.stopPropagation(),
            'onChange': (event: Event) => branchProps.onRenameCategory?.(branch.id, (event.target as HTMLInputElement).value),
          }),
          h('span', { class: 'category-path' }, branch.label),
        ]),
      ]),
      h('span', { class: 'category-count' }, String(branch.rows.length)),
    ]),
    h('div', { class: 'category-children' }, [
      h('details', { class: 'category-tools' }, [
        h('summary', '分类操作'),
        h('button', {
          class: 'delete-action',
          type: 'button',
          disabled: branchProps.busy,
          onClick: () => branchProps.onRemoveCategory?.(branch.id),
        }, '移除分类及子树，书签改为待确认'),
      ]),
      rows,
      ...children,
    ]),
  ])
}
</script>

<template>
  <div class="organize-workspace" :aria-busy="state.busy">
    <div class="workspace-intro">
      <h1>{{ preview ? '审阅分类' : state.result && !state.result.error ? '整理完成' : '智能分类' }}</h1>
      <p>{{ preview ? '检查每个去处，再确认移动。' : '先生成分类预览。书签由你确认后移动。' }}</p>
    </div>

    <ol class="workflow" aria-label="整理流程">
      <li :class="{ 'is-active': !preview && !(state.result && !state.result.error) }" :aria-current="!preview && !(state.result && !state.result.error) ? 'step' : undefined">
        选择范围
      </li>
      <li :class="{ 'is-active': !!preview }" :aria-current="preview ? 'step' : undefined">
        检查预览
      </li>
      <li :class="{ 'is-active': !preview && state.result && !state.result.error }" :aria-current="!preview && state.result && !state.result.error ? 'step' : undefined">
        完成移动
      </li>
    </ol>

    <section class="status-strip" :class="resolved.ok ? 'is-ready' : 'is-warning'" aria-live="polite">
      <span class="status-dot" aria-hidden="true" />
      <div class="status-copy">
        <strong>{{ resolved.ok ? '模型已配置' : '连接你的模型' }}</strong>
        <p v-if="resolved.ok">
          {{ config.model }} · {{ resolved.value.origin }}
        </p>
        <p v-else>
          {{ resolved.error }}，完成设置后即可开始。
        </p>
      </div>
      <button v-if="!resolved.ok" class="button-ghost-sm status-action" type="button" @click="openOptions">
        去设置
      </button>
      <button v-else class="button-ghost-sm status-action" type="button" :disabled="state.busy || state.testing" @click="testConnection">
        {{ state.testing ? '测试中…' : '测试连接' }}
      </button>
    </section>

    <details class="setup-panel" :open="!preview">
      <summary class="panel-heading setup-heading">
        <h2 id="setup-title">
          {{ preview ? '调整整理要求' : '分类范围与要求' }}
        </h2>
        <span class="disclosure-symbol" aria-hidden="true" />
      </summary>

      <label class="field-row">
        <span class="field-label">分类范围</span>
        <select v-model="state.rootId" class="text-control" :disabled="state.busy">
          <option v-for="root in state.roots" :key="root.id" :value="root.id">{{ root.title || root.id }}</option>
        </select>
        <span class="field-help">包含所选文件夹下的全部书签。</span>
      </label>

      <label class="field-row">
        <span class="field-label">整理要求 <small>可选</small></span>
        <textarea v-model="state.requirement" class="text-control text-area" :disabled="state.busy" rows="2" placeholder="例如：按工作与生活分类，保留英文名称" />
      </label>

      <div class="field-row limit-row">
        <div>
          <span class="field-label">分类数量上限</span>
          <p class="field-help">
            每层 3–15 个，最多三层。
          </p>
        </div>
        <input v-model.number="config.categoryLimit" class="number-control" type="number" min="3" max="15" :disabled="state.busy" aria-label="分类数量上限">
      </div>

      <div v-if="consentNeeded" class="privacy-note">
        <span class="privacy-icon" aria-hidden="true">◇</span>
        <div>
          <strong>发送前，由你授权</strong>
          <p>仅向你配置的模型发送书签标题、脱敏 URL 与相对路径。不抓取网页正文；query、凭据和 fragment 不会离开浏览器。</p>
          <button class="text-action" type="button" @click="acceptConsent">
            同意向此模型发送必要信息
          </button>
        </div>
      </div>

      <div class="primary-actions">
        <button class="button-primary" type="button" :disabled="state.busy || state.testing || consentNeeded || !resolved.ok || !state.rootId" @click="classify">
          <span>{{ state.busy ? '正在处理' : '生成分类预览' }}</span><span aria-hidden="true">→</span>
        </button>
        <button v-if="state.generating" class="button-secondary" type="button" @click="orchestrator.cancel()">
          取消
        </button>
      </div>
      <p v-if="!resolved.ok" class="field-help">
        请先在模型设置中填写连接信息。
      </p>
      <p v-else-if="consentNeeded" class="field-help">
        确认上方隐私说明后，即可生成预览。
      </p>

      <div v-if="state.progress" class="progress-block" aria-live="polite">
        <div class="progress-meta">
          <span>{{ { summarize: '读取书签信息', plan: '生成分类方案', classify: '逐项分类' }[state.progress.stage] }}</span><strong>{{ state.progress.done }}/{{ state.progress.total }}</strong>
        </div>
        <progress class="progress-track" :value="state.progress.done" :max="state.progress.total || 1" aria-label="分类进度" />
        <p v-if="state.progress.message">
          {{ state.progress.message }}
        </p>
      </div>
    </details>

    <p v-if="state.testMessage" class="notice" :class="state.testState === 'ok' ? 'notice-success' : 'notice-error'" role="status">
      {{ state.testMessage }}
    </p>
    <p v-if="state.error" class="notice notice-error" role="alert">
      {{ state.error }}
    </p>
    <p v-if="state.warning" class="notice notice-warning" role="status">
      {{ state.warning }}
    </p>
    <p v-if="state.message" class="notice notice-success" role="status">
      {{ state.message }}
    </p>
    <ul v-if="state.ignored.length" class="notice notice-muted">
      <li v-for="item in state.ignored" :key="item">
        已忽略不支持的要求：{{ item }}
      </li>
    </ul>

    <section v-if="preview" ref="previewPanel" class="preview-panel" aria-labelledby="preview-title" tabindex="-1">
      <div class="panel-heading preview-heading">
        <h2 id="preview-title">
          分类预览
        </h2>
        <span class="preview-total">{{ preview.counts.total + preview.counts.unclassifiable }} 个书签</span>
      </div>

      <div class="metric-grid">
        <div><strong>{{ preview.counts.moving }}</strong><span>待移动</span></div>
        <div><strong>{{ preview.counts.unchanged }}</strong><span>不变</span></div>
        <div><strong>{{ preview.counts.pending }}</strong><span>待确认</span></div>
        <div><strong>{{ preview.counts.unclassifiable }}</strong><span>无法分类</span></div>
      </div>
      <input ref="searchInput" v-model="state.filter" class="text-control search-control" placeholder="筛选标题或 URL" aria-label="筛选标题或 URL">
      <p class="field-help filter-hint">
        筛选只改变预览中的可见范围，不会改变确认执行的书签数量。命中节点会保留祖先路径。
      </p>

      <div v-if="selected.length" class="selection-bar">
        <span>已选 {{ selected.length }} 条</span>
        <select class="mini-control" :disabled="state.busy" aria-label="批量改派分类" value="__choose__" @change="batchAssign(($event.target as HTMLSelectElement).value || null)">
          <option value="__choose__" disabled>
            选择目标分类
          </option>
          <option value="">
            改为待确认
          </option>
          <option v-for="option in allGroups" :key="option.category.id" :value="option.category.id">
            {{ option.label }}
          </option>
        </select>
      </div>

      <div class="category-list">
        <component
          :is="renderBranch"
          v-for="branch in tree.branches"
          :key="branch.id"
          :branch="branch"
          :busy="state.busy"
          :selected="selected"
          @select-bookmark="toggleSelect"
          @rename-category="rename"
          @remove-category="drop"
        />

        <details v-if="tree.pending.length" open class="category-group is-pending">
          <summary class="category-summary-row">
            <span class="category-summary">
              <span class="category-marker is-pending" />
              <span class="category-name-block">
                <span class="category-name">待确认</span>
                <span class="category-path">保持原位置，不移动</span>
              </span>
            </span>
            <span class="category-count">{{ tree.pending.length }}</span>
          </summary>
          <div class="category-children">
            <ul class="bookmark-list">
              <li v-for="view in tree.pending" :key="view.row.bookmarkId" class="bookmark-row">
                <label class="bookmark-title">
                  <input type="checkbox" :checked="selected.includes(view.row.bookmarkId)" :disabled="state.busy" @change="toggleSelect(view.row.bookmarkId)">
                  <span>{{ view.row.title || view.row.displayUrl }}</span>
                </label>
                <p class="bookmark-url" :title="view.row.displayUrl">
                  {{ view.row.displayUrl }}
                </p>
                <p class="bookmark-meta">
                  <span class="bookmark-status is-pending">待确认</span>
                  <span class="bookmark-target">目标：保持原位</span>
                </p>
                <p class="bookmark-origin">
                  原位：{{ view.origin }}
                </p>
              </li>
            </ul>
          </div>
        </details>

        <details v-if="tree.unclassifiable.length" open class="category-group is-unclassifiable">
          <summary class="category-summary-row">
            <span class="category-summary">
              <span class="category-marker is-unclassifiable" />
              <span class="category-name-block">
                <span class="category-name">无法分类</span>
                <span class="category-path">只读；保留原位置</span>
              </span>
            </span>
            <span class="category-count">{{ tree.unclassifiable.length }}</span>
          </summary>
          <div class="category-children">
            <ul class="bookmark-list unclassifiable-list">
              <li v-for="item in tree.unclassifiable" :key="item.id" class="bookmark-row">
                <p class="bookmark-title">
                  <span>{{ item.title }}</span>
                </p>
                <p class="bookmark-url" :title="item.url">
                  {{ item.url }}
                </p>
                <p class="bookmark-meta">
                  <span class="bookmark-status is-unclassifiable">无法分类</span>
                  <span class="bookmark-target">目标：保持原位</span>
                </p>
                <p class="bookmark-origin">
                  原位：{{ item.origin }}
                </p>
              </li>
            </ul>
          </div>
        </details>
      </div>

      <div v-if="emptyFilter" class="empty-filter">
        <p>没有符合筛选条件的书签。</p><button v-if="state.filter" class="text-action" type="button" @click="clearFilter">
          清除筛选
        </button>
      </div>
      <div v-if="blocking.length" class="notice notice-error blocking-notice">
        <p v-for="item in blocking" :key="item">
          {{ item }}
        </p>
      </div>
      <p class="field-help preview-hint">
        可改名、勾选改派，或删除分类节点。待确认与无法分类的书签都保留原位置。
      </p>
      <p v-if="pendingRecovery" class="field-help">
        请先恢复未完成的移动，再执行新的预览。
      </p>
      <button class="button-primary execute-button" type="button" :disabled="state.busy || blocking.length > 0 || !!pendingRecovery" @click="confirmExecute">
        <span>{{ state.busy ? '正在移动…' : `确认移动 ${preview.counts.moving} 个书签` }}</span><span aria-hidden="true">→</span>
      </button>
    </section>

    <section v-if="state.dropped.length" class="notice notice-muted">
      <strong>无法分类</strong><ul>
        <li v-for="item in state.dropped" :key="item.id">
          {{ item.title || item.url }}
        </li>
      </ul>
    </section>

    <section v-if="state.undoStatus.state !== 'none' || pendingRecovery" class="recovery-panel" aria-labelledby="recovery-title">
      <div class="recovery-copy">
        <h2 id="recovery-title">
          最近一次整理
        </h2><p>{{ state.undoStatus.state === 'available' ? '可撤销最近一次移动，恢复原位置。' : state.undoStatus.state === 'disabled' ? '书签已发生变化，暂不能安全撤销。' : '整理完成后，可在这里撤销移动。' }}</p>
      </div>
      <button class="button-secondary" type="button" :disabled="state.undoStatus.state !== 'available' || state.busy" @click="runUndo">
        撤销
      </button>
      <ul v-if="state.undoStatus.state === 'disabled'" class="recovery-reasons">
        <li v-for="reason in state.undoStatus.reasons" :key="reason">
          {{ reason }}
        </li>
      </ul>
      <button v-if="pendingRecovery" class="recovery-link" type="button" :disabled="state.busy" @click="runRecovery">
        恢复未完成的移动（{{ pendingRecovery.completed.length }} 个）
      </button>
    </section>

    <details class="backup-panel" :open="!!pendingImport">
      <summary class="panel-heading">
        <h2 id="backup-title">
          备份与导入
        </h2>
        <span class="disclosure-symbol" aria-hidden="true" />
      </summary>
      <p class="field-help">
        备份「书签栏」与「其他书签」的完整结构。导入只追加节点，不删除、不覆盖现有书签。
      </p>
      <div class="backup-actions">
        <button class="button-secondary" type="button" :disabled="state.busy" @click="exportBackup">
          导出备份 <span aria-hidden="true">↓</span>
        </button>
        <label class="button-secondary file-label" :class="{ 'is-disabled': state.busy }">
          选择备份文件 <span aria-hidden="true">↑</span>
          <input type="file" accept=".json,application/json" aria-label="选择备份文件" :disabled="state.busy" @change="pickBackup">
        </label>
      </div>
      <div v-if="pendingImport" class="import-summary">
        <p><strong>{{ pendingImport.name }}</strong>：{{ pendingImport.folders }} 个文件夹、{{ pendingImport.bookmarks }} 个书签</p>
        <p v-if="pendingImport.other" class="field-help">
          其中 {{ pendingImport.other }} 个书签不是 HTTP(S)（例如书签小工具），会原样导入。
        </p>
        <p class="field-help">
          将写入：{{ importTargets(pendingImport.data.roots) }}
        </p>
        <label v-if="unmatchedRoots.length" class="field-row">
          <span class="field-label">备份中的「{{ unmatchedRoots.map(root => root.title).join('」「') }}」在当前浏览器不存在，改为写入</span>
          <select v-model="state.fallbackRootId" class="text-control">
            <option v-for="root in state.roots" :key="root.id" :value="root.id">{{ root.title || root.id }}</option>
          </select>
        </label>
        <div class="backup-actions">
          <button class="button-secondary" type="button" :disabled="state.busy" @click="confirmImport">
            确认导入
          </button>
          <button class="text-action" type="button" :disabled="state.busy" @click="pendingImport = null">
            取消
          </button>
        </div>
      </div>
    </details>
    <footer class="workspace-footer">
      <p><span class="footer-dot" aria-hidden="true" /> 本机存储 · 由你决定何时发送</p>
      <details class="local-data">
        <summary>本地数据管理</summary>
        <p>仅清除配置、隐私确认、撤销记录与未完成的恢复现场，不改动浏览器书签。</p>
        <button class="delete-action" type="button" :disabled="state.busy" @click="clearDialog?.showModal()">
          清除本地配置与撤销记录
        </button>
      </details>
    </footer>
    <dialog ref="clearDialog" class="clear-dialog" aria-labelledby="clear-title">
      <h2 id="clear-title">
        清除本地配置？
      </h2>
      <p>将删除 API Key、隐私确认、撤销记录与未完成的恢复现场，无法撤销。浏览器书签不会被删除。</p>
      <div class="dialog-actions">
        <button class="button-secondary" type="button" autofocus @click="clearDialog?.close()">
          保留配置
        </button><button class="button-secondary danger-button" type="button" @click="clearLocalData">
          清除配置与记录
        </button>
      </div>
    </dialog>
  </div>
</template>
