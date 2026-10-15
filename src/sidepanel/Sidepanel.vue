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
  <main class="workspace-shell">
    <header class="topbar">
      <div class="brand-lockup">
        <span class="brand-mark" aria-hidden="true">↗</span>
        <div>
          <p class="eyebrow">BOOKMARK WORKBENCH</p>
          <h1>整理台</h1>
        </div>
      </div>
      <button class="button-ghost-sm" type="button" @click="openOptions">设置</button>
    </header>

    <section class="hero-band" aria-labelledby="hero-title">
      <div class="hero-mesh" aria-hidden="true"></div>
      <p class="mono-eyebrow">AI BOOKMARK ORGANIZER / 01</p>
      <h2 id="hero-title">让 AI 先提案，<br><span>你来定稿。</span></h2>
      <p class="hero-copy">只整理你选中的书签范围。完整预览后才会移动，随时可以修改、恢复或撤销。</p>
      <nav class="workflow" aria-label="整理流程">
        <span class="workflow-step is-active"><b>01</b>范围</span>
        <i aria-hidden="true"></i>
        <span class="workflow-step"><b>02</b>提案</span>
        <i aria-hidden="true"></i>
        <span class="workflow-step"><b>03</b>确认</span>
      </nav>
    </section>

    <section class="status-strip" :class="resolved.ok ? 'is-ready' : 'is-warning'" aria-live="polite">
      <span class="status-dot" aria-hidden="true"></span>
      <div class="status-copy">
        <strong>{{ resolved.ok ? '模型服务已就绪' : '还需要完成设置' }}</strong>
        <p v-if="resolved.ok">{{ config.model }} · {{ resolved.value.origin }}</p>
        <p v-else>{{ resolved.error }}，前往设置页完成连接。</p>
      </div>
      <button v-if="resolved.ok" class="button-ghost-sm status-action" type="button" :disabled="state.busy" @click="testConnection">
        {{ state.testState === 'ok' ? '已连接' : '测试连接' }}
      </button>
    </section>

    <section class="setup-panel surface-panel" aria-labelledby="setup-title">
      <div class="panel-heading">
        <div>
          <p class="mono-eyebrow">SCOPE / 01</p>
          <h3 id="setup-title">先告诉我从哪里开始</h3>
        </div>
        <span class="panel-index">INPUT</span>
      </div>

      <label class="field-row">
        <span class="field-label">整理范围</span>
        <select v-model="state.rootId" class="text-control">
          <option v-for="root in state.roots" :key="root.id" :value="root.id">{{ root.title || root.id }}</option>
        </select>
      </label>

      <label class="field-row">
        <span class="field-label">整理要求 <small>可选</small></span>
        <textarea v-model="state.requirement" class="text-control text-area" rows="3" placeholder="例如：按用途分组，用英文命名；留空则跟随书签语言" />
      </label>

      <div class="field-row limit-row">
        <div>
          <span class="field-label">分类数量上限</span>
          <p class="field-help">建议保持在 3–15 个，目录更容易维护。</p>
        </div>
        <input v-model.number="config.categoryLimit" class="number-control" type="number" min="3" max="15" aria-label="分类数量上限">
      </div>

      <div v-if="consentNeeded" class="privacy-note">
        <span class="privacy-icon" aria-hidden="true">◎</span>
        <div>
          <strong>第一次整理前，请确认隐私边界</strong>
          <p>只发送书签标题、脱敏 URL 与相对路径。query、凭据和 fragment 永远不会离开浏览器。</p>
          <button class="text-action" type="button" @click="acceptConsent">我已了解并同意</button>
        </div>
      </div>

      <div class="primary-actions">
        <button class="button-primary" type="button" :disabled="state.busy || consentNeeded" @click="classify">
          <span>{{ state.busy ? '正在整理' : '生成分类提案' }}</span><span aria-hidden="true">→</span>
        </button>
        <button v-if="state.busy" class="button-secondary" type="button" @click="orchestrator.cancel()">取消</button>
      </div>

      <div v-if="state.progress" class="progress-block" aria-live="polite">
        <div class="progress-meta"><span>{{ state.progress.stage }}</span><strong>{{ state.progress.done }}/{{ state.progress.total }}</strong></div>
        <div class="progress-track"><span :style="{ width: `${state.progress.total ? Math.round(state.progress.done / state.progress.total * 100) : 0}%` }"></span></div>
        <p v-if="state.progress.message">{{ state.progress.message }}</p>
      </div>
    </section>

    <p v-if="state.testMessage" class="notice" :class="state.testState === 'ok' ? 'notice-success' : 'notice-error'" role="status">{{ state.testMessage }}</p>
    <p v-if="state.error" class="notice notice-error" role="alert">{{ state.error }}</p>
    <p v-if="state.message" class="notice notice-success" role="status">{{ state.message }}</p>
    <ul v-if="state.ignored.length" class="notice notice-muted"><li v-for="item in state.ignored" :key="item">已忽略不支持的要求：{{ item }}</li></ul>

    <section v-if="preview" class="preview-panel surface-panel" aria-labelledby="preview-title">
      <div class="panel-heading preview-heading">
        <div><p class="mono-eyebrow">PROPOSAL / 02</p><h3 id="preview-title">分类提案</h3></div>
        <span class="preview-total">{{ preview.counts.total }} 条</span>
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

      <div v-if="blocking.length" class="notice notice-error blocking-notice"><p v-for="item in blocking" :key="item">{{ item }}</p></div>
      <button class="button-primary execute-button" type="button" :disabled="state.busy || blocking.length > 0" @click="confirmExecute"><span>确认并执行移动</span><span aria-hidden="true">→</span></button>
    </section>

    <section v-if="state.dropped.length" class="notice notice-muted"><strong>无法分类</strong><ul><li v-for="item in state.dropped" :key="item.id">{{ item.title || item.url }}</li></ul></section>

    <section class="recovery-panel surface-panel">
      <div class="recovery-copy"><p class="mono-eyebrow">RECOVERY / 03</p><h3>最近一次整理</h3><p>{{ state.undoStatus.state === 'available' ? '可以撤销最近一次移动。' : state.undoStatus.state === 'disabled' ? '撤销已被保护性禁用。' : '完成一次整理后，这里会保留撤销入口。' }}</p></div>
      <button class="button-secondary" type="button" :disabled="state.undoStatus.state !== 'available' || state.busy" @click="runUndo">撤销</button>
      <ul v-if="state.undoStatus.state === 'disabled'" class="recovery-reasons"><li v-for="reason in state.undoStatus.reasons" :key="reason">{{ reason }}</li></ul>
      <button v-if="pendingRecovery" class="recovery-link" type="button" :disabled="state.busy" @click="runRecovery">恢复未完成的移动（{{ pendingRecovery.completed.length }} 个）</button>
      <button class="recovery-link muted-link" type="button" @click="clearLocalData">清除本地配置与撤销记录</button>
    </section>

    <section class="backup-panel surface-panel" aria-labelledby="backup-title">
      <div class="panel-heading">
        <div><p class="mono-eyebrow">BACKUP / 04</p><h3 id="backup-title">备份与导入</h3></div>
        <span class="panel-index">JSON</span>
      </div>
      <p class="field-help">导出「书签栏」与「其他书签」的完整结构。导入只创建节点，追加在同名根目录末尾，不删除现有书签。</p>
      <div class="backup-actions">
        <button class="button-secondary" type="button" :disabled="state.busy" @click="exportBackup">导出备份</button>
        <label class="button-secondary file-label" :class="{ 'is-disabled': state.busy }">
          选择备份文件
          <input type="file" accept=".json,application/json" hidden @change="pickBackup">
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
  </main>
</template>

<style>
:root { color-scheme: light; --ink: #171717; --body: #4d4d4d; --mute: #8f8f8f; --faint: #a1a1a1; --hairline: #ebebeb; --hairline-soft: #f2f2f2; --canvas: #fafafa; --surface: #fff; --link: #0070f3; --error: #ee0000; --success: #0070f3; }
* { box-sizing: border-box; }
html, body { min-width: 320px; margin: 0; background: var(--canvas); color: var(--ink); font-family: Geist, Inter, Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
body { font-size: 14px; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .48; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.workspace-shell { max-width: 620px; margin: 0 auto; padding: 16px 16px 40px; }
.topbar, .brand-lockup, .panel-heading, .workflow, .status-strip, .primary-actions, .progress-meta, .selection-bar, .recovery-panel { display: flex; align-items: center; }
.topbar { justify-content: space-between; margin-bottom: 8px; }
.brand-lockup { gap: 9px; }
.brand-mark { display: grid; width: 28px; height: 28px; place-items: center; border: 1px solid var(--ink); border-radius: 50%; font-size: 16px; line-height: 1; }
.eyebrow, .mono-eyebrow { margin: 0; font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 500; letter-spacing: .02em; }
.eyebrow { color: var(--mute); }
.topbar h1 { margin: 2px 0 0; font-size: 16px; font-weight: 600; letter-spacing: -.02em; }
.button-ghost-sm, .button-secondary { border: 1px solid var(--hairline); border-radius: 6px; background: var(--surface); color: var(--ink); font-size: 14px; font-weight: 500; }
.button-ghost-sm { min-height: 32px; padding: 0 10px; }
.hero-band { position: relative; overflow: hidden; margin: 0 -16px; padding: 48px 16px 28px; border-bottom: 1px solid var(--hairline); }
.hero-mesh { position: absolute; inset: 0; pointer-events: none; opacity: .35; background: radial-gradient(circle at 86% 14%, #00dfd8 0, transparent 30%), radial-gradient(circle at 72% 52%, #7928ca 0, transparent 36%), radial-gradient(circle at 98% 96%, #ff0080 0, transparent 27%), radial-gradient(circle at 14% 94%, #f9cb28 0, transparent 24%); filter: blur(30px); }
.hero-band > *:not(.hero-mesh) { position: relative; }
.hero-band .mono-eyebrow { color: var(--body); }
.hero-band h2 { max-width: 520px; margin: 12px 0 16px; font-size: clamp(38px, 10vw, 56px); font-weight: 600; line-height: 1.05; letter-spacing: -2.7px; text-wrap: balance; }
.hero-band h2 span { background: linear-gradient(90deg, #007cf0, #7928ca 50%, #ff0080); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero-copy { max-width: 420px; margin: 0; color: var(--body); font-size: 15px; line-height: 1.65; }
.workflow { gap: 10px; margin-top: 30px; color: var(--mute); font-size: 12px; }
.workflow-step { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.workflow-step b { color: var(--ink); font-family: "Geist Mono", ui-monospace, monospace; font-size: 11px; font-weight: 500; }
.workflow-step.is-active { color: var(--ink); font-weight: 600; }
.workflow i { flex: 1; height: 1px; background: var(--hairline); }
.status-strip { gap: 10px; margin-top: 16px; padding: 12px; border: 1px solid var(--hairline); background: var(--surface); }
.status-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--error); }
.is-ready .status-dot { background: var(--success); }
.status-copy { min-width: 0; flex: 1; }
.status-copy strong, .status-copy p { display: block; }
.status-copy strong { font-size: 13px; font-weight: 600; }
.status-copy p { margin: 3px 0 0; overflow: hidden; color: var(--mute); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.status-action { flex: 0 0 auto; }
.surface-panel { border: 1px solid var(--hairline); background: var(--surface); }
.setup-panel, .preview-panel { margin-top: 16px; padding: 20px; }
.panel-heading { justify-content: space-between; align-items: flex-start; margin-bottom: 22px; }
.panel-heading h3, .recovery-panel h3, .backup-panel h3 { margin: 5px 0 0; font-size: 20px; font-weight: 600; letter-spacing: -.5px; }
.mono-eyebrow, .panel-index, .preview-total { color: var(--mute); }
.panel-index, .preview-total { font-family: "Geist Mono", ui-monospace, monospace; font-size: 11px; }
.field-row { display: block; margin-top: 18px; }
.field-label { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 500; }
.field-label small { color: var(--mute); font-size: 12px; font-weight: 400; }
.text-control, .number-control, .mini-control { width: 100%; border: 1px solid var(--hairline); border-radius: 6px; outline: 0; background: var(--surface); color: var(--ink); }
.text-control { padding: 10px 12px; font-size: 14px; transition: border-color .16s, box-shadow .16s; }
.text-control:focus, .number-control:focus, .mini-control:focus { border-color: var(--link); box-shadow: 0 0 0 3px rgba(0,112,243,.12); }
.text-area { min-height: 82px; resize: vertical; line-height: 1.55; }
.limit-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.field-help { margin: -2px 0 0; color: var(--mute); font-size: 12px; line-height: 1.5; }
.number-control { width: 72px; padding: 9px 8px; text-align: center; }
.privacy-note { display: flex; gap: 12px; margin-top: 20px; padding: 14px; border: 1px solid var(--hairline); background: var(--hairline-soft); }
.privacy-icon { color: var(--link); font-size: 18px; }
.privacy-note strong { font-size: 13px; font-weight: 600; }
.privacy-note p { margin: 5px 0 8px; color: var(--body); font-size: 12px; line-height: 1.55; }
.text-action, .recovery-link, .delete-action { padding: 0; border: 0; background: none; color: var(--link-deep, #0761d1); font-size: 12px; }
.text-action { font-weight: 500; }
.primary-actions { gap: 8px; margin-top: 24px; }
.button-primary, .button-secondary { min-height: 42px; font-size: 14px; font-weight: 500; transition: background .16s, border-color .16s, transform .16s; }
.button-primary { display: flex; flex: 1; align-items: center; justify-content: space-between; padding: 0 14px; border: 1px solid var(--ink); border-radius: 100px; background: var(--ink); color: #fff; }
.button-primary:hover:not(:disabled) { background: #333; }
.button-primary:active:not(:disabled) { transform: translateY(1px); }
.button-secondary { padding: 0 14px; }
.progress-block { margin-top: 18px; }
.progress-meta { justify-content: space-between; color: var(--mute); font-size: 12px; }
.progress-meta strong { color: var(--ink); font-family: "Geist Mono", ui-monospace, monospace; font-weight: 500; }
.progress-track { height: 3px; margin-top: 9px; background: var(--hairline-soft); }
.progress-track span { display: block; height: 100%; background: linear-gradient(90deg, #007cf0, #7928ca, #ff0080); transition: width .25s ease; }
.progress-block p { margin: 8px 0 0; color: var(--mute); font-size: 12px; }
.notice { margin: 12px 0 0; padding: 11px 13px; border: 1px solid var(--hairline); font-size: 13px; line-height: 1.55; }
.notice-success { border-color: #b9d9ff; background: #f1f7ff; color: #0756ae; }
.notice-error { border-color: #ffcaca; background: #fff5f5; color: #a50000; }
.notice-muted { background: var(--hairline-soft); color: var(--body); }
.notice ul { margin: 6px 0 0; padding-left: 17px; }
.preview-panel { margin-top: 24px; }
.preview-heading { margin-bottom: 18px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); }
.metric-grid div { padding: 12px 8px; border-right: 1px solid var(--hairline); }
.metric-grid div:last-child { border-right: 0; }
.metric-grid strong, .metric-grid span { display: block; }
.metric-grid strong { font-family: "Geist Mono", ui-monospace, monospace; font-size: 20px; font-weight: 500; }
.metric-grid span { margin-top: 3px; color: var(--mute); font-size: 11px; }
.search-control { margin-top: 16px; }
.selection-bar { justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--mute); font-size: 12px; }
.mini-control { width: auto; padding: 7px 9px; font-size: 12px; }
.category-list { margin-top: 14px; }
.category-group { border-bottom: 1px solid var(--hairline); }
.category-group summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 14px 0; cursor: pointer; list-style: none; }
.category-group summary::-webkit-details-marker { display: none; }
.category-summary { display: flex; min-width: 0; align-items: center; gap: 9px; }
.category-marker { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--link); }
.category-marker.is-pending { background: var(--mute); }
.category-name { min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 14px; font-weight: 600; }
.category-count { color: var(--mute); font-family: "Geist Mono", ui-monospace, monospace; font-size: 11px; }
.delete-action { display: block; padding: 0 0 8px 16px; color: var(--error); }
.bookmark-list { margin: 0; padding: 0 0 10px 16px; list-style: none; }
.bookmark-list li { padding: 8px 0; }
.bookmark-list label { display: flex; align-items: flex-start; gap: 8px; font-size: 13px; line-height: 1.45; }
.bookmark-list input { margin: 3px 0 0; accent-color: var(--link); }
.bookmark-list label span { overflow-wrap: anywhere; }
.bookmark-list small { display: block; overflow: hidden; margin: 3px 0 0 22px; color: var(--mute); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.blocking-notice { margin-top: 14px; }
.blocking-notice p { margin: 0; }
.execute-button { width: 100%; margin-top: 16px; }
.recovery-panel { display: grid; grid-template-columns: 1fr auto; gap: 14px; margin-top: 16px; padding: 18px 20px; }
.recovery-copy p:last-child { margin: 6px 0 0; color: var(--mute); font-size: 12px; line-height: 1.55; }
.recovery-reasons, .recovery-link { grid-column: 1 / -1; }
.recovery-reasons { margin: 0; padding-left: 17px; color: var(--body); font-size: 12px; }
.recovery-link { text-align: left; }
.muted-link { color: var(--mute); }
.backup-panel { margin-top: 16px; padding: 18px 20px; }
.backup-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.file-label { display: inline-flex; align-items: center; cursor: pointer; }
.file-label.is-disabled { pointer-events: none; opacity: .48; }
.import-summary { margin-top: 14px; padding: 12px 14px; border: 1px solid var(--hairline); background: var(--hairline-soft); }
.import-summary p { margin: 0; font-size: 13px; }
.import-summary .backup-actions { margin-top: 10px; }
@media (min-width: 640px) { .workspace-shell { padding: 22px 24px 48px; } .hero-band { margin: 0 -24px; padding-right: 24px; padding-left: 24px; } }
@media (max-width: 420px) { .metric-grid span { font-size: 10px; } .metric-grid div { padding-right: 5px; padding-left: 5px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
