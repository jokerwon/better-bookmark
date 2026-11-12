<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { OperationError, createOrchestrator } from '~/core/classifier'
import { browserApi } from '~/core/browser-api'
import { createBrowserTree } from '~/core/browser-tree'
import { buildBackup, importBackup, parseBackup } from '~/core/backup'
import { resolveConfig } from '~/core/config'
import { CONNECTION_TEST_MESSAGES, ModelError, createModelClient } from '~/core/model'
import { ensureHostPermission } from '~/core/permissions'
import { deleteCategory, groupRows, pendingRows, reassign, renameCategory } from '~/core/plan'
import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'
import type { BackupFile, BackupNode } from '~/core/backup'
import type { BookmarkView, OperationResult, Preview, Progress, RecoveryState, UndoRecord, UndoStatus } from '~/core/types'

const browserTree = createBrowserTree()

const state = reactive({
  roots: [] as BookmarkView[],
  rootId: '',
  /** 导入时备份根标题在当前浏览器找不到同名根，就落到这个文件夹。 */
  fallbackRootId: '',
  requirement: '',
  showingKey: false,
  testState: '' as '' | 'ok' | 'fail',
  testMessage: '',
  progress: null as Progress | null,
  busy: false,
  message: '',
  error: '',
  ignored: [] as string[],
  dropped: [] as BookmarkView[],
  filter: '',
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

const resolved = computed(() => resolveConfig(config.value))
/** 首次分类，以及 Base URL 或模型变化后，都需要重新确认隐私边界。 */
const consentNeeded = computed(() => resolved.value.ok && consent.value.originKey !== resolved.value.value.originKey)
const blocking = computed(() => (preview.value ? orchestrator.blockingOf(preview.value) : []))
/** 全部分类分组（不筛选）：批量改派下拉用它展示完整路径。 */
const allGroups = computed(() => preview.value ? groupRows(preview.value, '') : [])
/** 展示用分组：按筛选保留命中书签的节点及其祖先，并保持命中结果展开。 */
const groups = computed(() => preview.value ? groupRows(preview.value, state.filter) : [])
const pendingGroup = computed(() => preview.value ? pendingRows(preview.value, state.filter) : [])
/** 备份里有当前浏览器不存在的根标题时，需要用户指定落到哪个文件夹。 */
const unmatchedRoots = computed(() => pendingImport.value
  ? pendingImport.value.data.roots.filter(root => !state.roots.some(live => live.title === root.title))
  : [])

onMounted(async () => {
  state.roots = await browserTree.roots()
  state.rootId = state.roots.find(root => root.id.startsWith('1'))?.id ?? state.roots[0]?.id ?? ''
  state.fallbackRootId = state.rootId
  await refreshUndo()
})

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

async function testConnection() {
  state.testState = ''
  state.testMessage = ''
  try {
    if (!resolved.value.ok)
      throw new OperationError(resolved.value.error, true)
    if (!(await ensureHostPermission(resolved.value.value.origin)))
      throw new OperationError('未授予该模型源的访问权限', true)
    // 固定测试消息，不含任何书签数据。
    await createModelClient({ ...config.value }).complete([...CONNECTION_TEST_MESSAGES])
    state.testState = 'ok'
    state.testMessage = '连接成功'
  }
  catch (error) {
    state.testState = 'fail'
    state.testMessage = describe(error)
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
  state.error = ''
  state.message = ''
  state.result = null
  state.ignored = []
  state.dropped = []
  try {
    if (!resolved.value.ok)
      throw new OperationError(resolved.value.error, true)
    if (consentNeeded.value)
      throw new OperationError('请先确认隐私说明', true)
    if (!state.rootId)
      throw new OperationError('请选择要整理的文件夹', true)
    if (!(await ensureHostPermission(resolved.value.value.origin)))
      throw new OperationError('未授予该模型源的访问权限', true)

    state.busy = true
    const run = await orchestrator.classify(
      { rootId: state.rootId, categoryLimit: config.value.categoryLimit, requirement: state.requirement },
      createModelClient({ ...config.value }),
    )
    preview.value = run.preview
    selected.value = []
    state.ignored = run.ignoredRequirements
    if (run.skipped) {
      state.message = '该文件夹内没有可分类的书签，未调用模型'
      state.dropped = (await browserTree.subtree(state.rootId)).filter(node => node.url !== undefined && !/^https?:\/\//i.test(node.url))
    }
  }
  catch (error) {
    state.error = describe(error)
  }
  finally {
    state.busy = false
    state.progress = null
  }
}

function rename(categoryId: string, name: string) {
  if (preview.value)
    preview.value = renameCategory(preview.value, categoryId, name)
}

function drop(categoryId: string) {
  if (preview.value)
    preview.value = deleteCategory(preview.value, categoryId)
}

function toggleSelect(bookmarkId: string) {
  selected.value = selected.value.includes(bookmarkId)
    ? selected.value.filter(id => id !== bookmarkId)
    : [...selected.value, bookmarkId]
}

function batchAssign(categoryId: string | null) {
  if (!preview.value || !selected.value.length)
    return
  preview.value = reassign(preview.value, selected.value, categoryId)
  selected.value = []
}

async function confirmExecute() {
  if (!preview.value)
    return
  state.error = ''
  state.message = ''
  state.busy = true
  const current = preview.value
  try {
    const result = await orchestrator.execute(current)
    state.result = result
    if (result.error) {
      state.error = result.error
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
    state.error = describe(error)
  }
  finally {
    state.busy = false
  }
}

async function runUndo() {
  if (!undoRecord.value)
    return
  state.busy = true
  state.error = ''
  try {
    const report = await orchestrator.undo(undoRecord.value)
    state.message = `已恢复 ${report.restored} 个书签${report.conflicts.length ? `；${report.conflicts.length} 个因冲突未恢复` : ''}`
    if (!report.conflicts.length)
      undoRecord.value = null
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
  if (!pendingRecovery.value)
    return
  state.busy = true
  state.error = ''
  try {
    const report = await orchestrator.recover(pendingRecovery.value)
    state.message = `已恢复 ${report.restored} 个书签；冲突 ${report.conflicts.length} 个`
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
  // 只清除扩展本地数据，绝不删除浏览器书签。
  config.value = { apiKey: '', baseUrl: '', model: '', categoryLimit: 8 }
  consent.value = { originKey: '', acceptedAt: 0 }
  undoRecord.value = null
  pendingRecovery.value = null
  preview.value = null
  state.result = null
  state.error = ''
  state.message = '已清除本地配置、隐私确认与撤销记录；浏览器书签未被改动'
  void refreshUndo()
}

/** 导出书签栏与其他书签的完整结构；文件里不含浏览器节点 ID。 */
async function exportBackup() {
  state.error = ''
  state.message = ''
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
  state.error = ''
  state.message = ''
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
  if (!pendingImport.value)
    return
  state.busy = true
  state.error = ''
  state.message = ''
  try {
    const report = await importBackup(pendingImport.value.data, browserTree, state.fallbackRootId)
    state.message = `已导入 ${report.folders} 个文件夹、${report.bookmarks} 个书签到 ${report.roots.join('、')}${report.skipped ? `；${report.skipped} 个节点未写入` : ''}`
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
</script>

<template>
  <a class="skip-link" href="#main-content" target="_self">跳到整理内容</a>
  <main id="main-content" class="workspace-shell" tabindex="-1">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 28" fill="none"><path d="M6 3h12v22l-6-4-6 4V3Z" stroke="currentColor" stroke-width="1.5"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.5"/></svg></span>
        <div><p class="brand-name">智能书签分类</p><p class="brand-caption" lang="en">Better Bookmark</p></div>
      </div>
      <button class="button-ghost-sm" type="button" @click="openOptions">模型设置 <span aria-hidden="true">↗</span></button>
    </header>

    <div class="workspace-intro">
      <p class="eyebrow" lang="en">BOOKMARK ORGANIZER</p>
      <h1>给书签一个好去处。</h1>
      <p>先预览分类，再决定移动。</p>
    </div>

    <ol class="workflow" aria-label="整理流程">
      <li :class="{ 'is-active': !preview && state.undoStatus.state !== 'available' }" :aria-current="!preview && state.undoStatus.state !== 'available' ? 'step' : undefined"><span>1</span>选择范围</li>
      <li :class="{ 'is-active': !!preview }" :aria-current="preview ? 'step' : undefined"><span>2</span>检查预览</li>
      <li :class="{ 'is-active': !preview && state.undoStatus.state === 'available' }" :aria-current="!preview && state.undoStatus.state === 'available' ? 'step' : undefined"><span>3</span>确认移动</li>
    </ol>

    <section class="status-strip" :class="resolved.ok ? 'is-ready' : 'is-warning'" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span>
      <div class="status-copy">
        <strong>{{ resolved.ok ? '模型已配置' : '连接你的模型' }}</strong>
        <p v-if="resolved.ok">{{ config.model }} · {{ resolved.value.origin }}</p>
        <p v-else>{{ resolved.error }}，完成设置后即可开始。</p>
      </div>
      <button v-if="!resolved.ok" class="button-ghost-sm status-action" type="button" @click="openOptions">去设置</button>
      <button v-else class="button-ghost-sm status-action" type="button" :disabled="state.busy" @click="testConnection">
        {{ state.testState === 'ok' ? '重新测试' : '测试连接' }}
      </button>
    </section>

    <section class="setup-panel" aria-labelledby="setup-title">
      <div class="panel-heading">
        <h2 id="setup-title">整理书签</h2>
        <span class="section-meta">先预览 · 不直接移动</span>
      </div>

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
          <p class="field-help">每层 3–15 个，最多三层。</p>
        </div>
        <input v-model.number="config.categoryLimit" class="number-control" type="number" min="3" max="15" :disabled="state.busy" aria-label="分类数量上限">
      </div>

      <div v-if="consentNeeded" class="privacy-note">
        <span class="privacy-icon" aria-hidden="true">◇</span>
        <div>
          <strong>发送前，由你授权</strong>
          <p>仅向你配置的模型发送书签标题、脱敏 URL 与相对路径。不抓取网页正文；query、凭据和 fragment 不会离开浏览器。</p>
          <button class="text-action" type="button" @click="acceptConsent">我已了解并同意</button>
        </div>
      </div>

      <div class="primary-actions">
        <button class="button-primary" type="button" :disabled="state.busy || consentNeeded || !resolved.ok" @click="classify">
          <span>{{ state.busy ? '正在处理' : '生成分类预览' }}</span><span aria-hidden="true">→</span>
        </button>
        <button v-if="state.busy" class="button-secondary" type="button" @click="orchestrator.cancel()">取消</button>
      </div>

      <div v-if="state.progress" class="progress-block" aria-live="polite">
        <div class="progress-meta"><span>{{ { summarize: '读取书签信息', plan: '生成分类方案', classify: '逐项分类' }[state.progress.stage] }}</span><strong>{{ state.progress.done }}/{{ state.progress.total }}</strong></div>
        <progress class="progress-track" :value="state.progress.done" :max="state.progress.total || 1" aria-label="分类进度"></progress>
        <p v-if="state.progress.message">{{ state.progress.message }}</p>
      </div>
    </section>

    <p v-if="state.testMessage" class="notice" :class="state.testState === 'ok' ? 'notice-success' : 'notice-error'" role="status">{{ state.testMessage }}</p>
    <p v-if="state.error" class="notice notice-error" role="alert">{{ state.error }}</p>
    <p v-if="state.message" class="notice notice-success" role="status">{{ state.message }}</p>
    <ul v-if="state.ignored.length" class="notice notice-muted"><li v-for="item in state.ignored" :key="item">已忽略不支持的要求：{{ item }}</li></ul>

    <section v-if="preview" class="preview-panel" aria-labelledby="preview-title">
      <div class="panel-heading preview-heading">
        <div><p class="eyebrow" lang="en">REVIEW BEFORE MOVING</p><h2 id="preview-title">检查分类预览</h2></div>
        <span class="preview-total">{{ preview.counts.total }} 个书签</span>
      </div>

      <div class="metric-grid">
        <div><strong>{{ preview.counts.moving }}</strong><span>待移动</span></div>
        <div><strong>{{ preview.counts.unchanged }}</strong><span>不变</span></div>
        <div><strong>{{ preview.counts.pending }}</strong><span>待确认</span></div>
        <div><strong>{{ preview.counts.unclassifiable }}</strong><span>无法分类</span></div>
      </div>
      <input v-model="state.filter" class="text-control search-control" placeholder="筛选标题或 URL" aria-label="筛选标题或 URL">

      <div v-if="selected.length" class="selection-bar">
        <span>已选 {{ selected.length }} 条</span>
        <select class="mini-control" aria-label="批量改派分类" @change="batchAssign(($event.target as HTMLSelectElement).value || null)">
          <option value="">改为待确认</option>
          <option v-for="option in allGroups" :key="option.category.id" :value="option.category.id">{{ option.label }}</option>
        </select>
      </div>

      <div class="category-list">
        <details v-for="group in groups" :key="group.category.id" :open="group.expanded || !state.filter" class="category-group" :style="{ marginLeft: `${group.depth * 16}px` }">
          <summary>
            <span class="category-summary">
              <span class="category-marker"></span>
              <input class="category-name" :value="group.category.name" :aria-label="`分类名称：${group.category.name}`" @click.stop @change="rename(group.category.id, ($event.target as HTMLInputElement).value)">
            </span>
            <span class="category-count">{{ group.rows.length }}</span>
          </summary>
          <button class="delete-action" type="button" @click="drop(group.category.id)">删除分类及子树，保留书签</button>
          <ul class="bookmark-list">
            <li v-for="row in group.rows" :key="row.bookmarkId">
              <label><input type="checkbox" :checked="selected.includes(row.bookmarkId)" @change="toggleSelect(row.bookmarkId)"><span>{{ row.title || row.displayUrl }}</span></label>
              <small :title="row.displayUrl">{{ row.displayUrl }}</small>
            </li>
          </ul>
        </details>
        <details v-if="pendingGroup.length" open class="category-group">
          <summary><span class="category-summary"><span class="category-marker is-pending"></span><span class="category-name">待确认</span></span><span class="category-count">{{ pendingGroup.length }}</span></summary>
          <ul class="bookmark-list"><li v-for="row in pendingGroup" :key="row.bookmarkId"><label><input type="checkbox" :checked="selected.includes(row.bookmarkId)" @change="toggleSelect(row.bookmarkId)"><span>{{ row.title || row.displayUrl }}</span></label><small :title="row.displayUrl">{{ row.displayUrl }}</small></li></ul>
        </details>
      </div>

      <p v-if="!groups.length && !pendingGroup.length" class="empty-filter">没有符合筛选条件的书签。</p>
      <div v-if="blocking.length" class="notice notice-error blocking-notice"><p v-for="item in blocking" :key="item">{{ item }}</p></div>
      <p class="field-help preview-hint">可改名、勾选改派，或删除分类节点。待确认的书签保留原位置。</p>
      <button class="button-primary execute-button" type="button" :disabled="state.busy || blocking.length > 0" @click="confirmExecute"><span>确认并执行移动</span><span aria-hidden="true">→</span></button>
    </section>

    <section v-if="state.dropped.length" class="notice notice-muted"><strong>无法分类</strong><ul><li v-for="item in state.dropped" :key="item.id">{{ item.title || item.url }}</li></ul></section>

    <section class="recovery-panel" aria-labelledby="recovery-title">
      <div class="recovery-copy"><h2 id="recovery-title">最近一次整理</h2><p>{{ state.undoStatus.state === 'available' ? '可撤销最近一次移动，恢复原位置。' : state.undoStatus.state === 'disabled' ? '书签已发生变化，暂不能安全撤销。' : '整理完成后，可在这里撤销移动。' }}</p></div>
      <button class="button-secondary" type="button" :disabled="state.undoStatus.state !== 'available' || state.busy" @click="runUndo">撤销</button>
      <ul v-if="state.undoStatus.state === 'disabled'" class="recovery-reasons"><li v-for="reason in state.undoStatus.reasons" :key="reason">{{ reason }}</li></ul>
      <button v-if="pendingRecovery" class="recovery-link" type="button" :disabled="state.busy" @click="runRecovery">恢复未完成的移动（{{ pendingRecovery.completed.length }} 个）</button>
    </section>

    <section class="backup-panel" aria-labelledby="backup-title">
      <div class="panel-heading">
        <h2 id="backup-title">备份与导入</h2>
        <span class="section-meta">本地 JSON 文件</span>
      </div>
      <p class="field-help">备份「书签栏」与「其他书签」的完整结构。导入只追加节点，不删除、不覆盖现有书签。</p>
      <div class="backup-actions">
        <button class="button-secondary" type="button" :disabled="state.busy" @click="exportBackup">导出备份 <span aria-hidden="true">↓</span></button>
        <label class="button-secondary file-label" :class="{ 'is-disabled': state.busy }">
          选择备份文件 <span aria-hidden="true">↑</span>
          <input type="file" accept=".json,application/json" aria-label="选择备份文件" :disabled="state.busy" @change="pickBackup">
        </label>
      </div>
      <div v-if="pendingImport" class="import-summary">
        <p><strong>{{ pendingImport.name }}</strong>：{{ pendingImport.folders }} 个文件夹、{{ pendingImport.bookmarks }} 个书签</p>
        <p v-if="pendingImport.other" class="field-help">其中 {{ pendingImport.other }} 个书签不是 HTTP(S)（例如书签小工具），会原样导入。</p>
        <p class="field-help">将写入：{{ importTargets(pendingImport.data.roots) }}</p>
        <label v-if="unmatchedRoots.length" class="field-row">
          <span class="field-label">备份中的「{{ unmatchedRoots.map(root => root.title).join('」「') }}」在当前浏览器不存在，改为写入</span>
          <select v-model="state.fallbackRootId" class="text-control">
            <option v-for="root in state.roots" :key="root.id" :value="root.id">{{ root.title || root.id }}</option>
          </select>
        </label>
        <div class="backup-actions">
          <button class="button-secondary" type="button" :disabled="state.busy" @click="confirmImport">确认导入</button>
          <button class="text-action" type="button" :disabled="state.busy" @click="pendingImport = null">取消</button>
        </div>
      </div>
    </section>
    <footer class="workspace-footer">
      <p><span class="footer-dot" aria-hidden="true"></span> 本机存储 · 由你决定何时发送</p>
      <details class="local-data">
        <summary>本地数据管理</summary>
        <p>仅清除配置、隐私确认与撤销记录，不改动浏览器书签。</p>
        <button class="delete-action" type="button" :disabled="state.busy" @click="clearLocalData">清除本地配置与撤销记录</button>
      </details>
    </footer>
  </main>
</template>

