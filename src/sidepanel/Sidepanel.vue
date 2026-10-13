<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef } from 'vue'
import { OperationError, createOrchestrator } from '~/core/classifier'
import { browserApi } from '~/core/browser-api'
import { createBrowserTree } from '~/core/browser-tree'
import { resolveConfig } from '~/core/config'
import { CONNECTION_TEST_MESSAGES, ModelError, createModelClient } from '~/core/model'
import { ensureHostPermission } from '~/core/permissions'
import { deleteCategory, reassign, renameCategory, rowsByCategory } from '~/core/plan'
import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'
import type { BookmarkView, OperationResult, Preview, Progress, RecoveryState, UndoRecord, UndoStatus } from '~/core/types'

const browserTree = createBrowserTree()

const state = reactive({
  roots: [] as BookmarkView[],
  rootId: '',
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

const orchestrator = createOrchestrator(browserTree, {
  onProgress: (progress) => { state.progress = progress },
})

const preview = shallowRef<Preview | null>(null)
const selected = ref<string[]>([])

const resolved = computed(() => resolveConfig(config.value))
/** 首次分类，以及 Base URL 或模型变化后，都需要重新确认隐私边界。 */
const consentNeeded = computed(() => resolved.value.ok && consent.value.originKey !== resolved.value.value.originKey)
const blocking = computed(() => (preview.value ? orchestrator.blockingOf(preview.value) : []))
const groups = computed(() => {
  if (!preview.value)
    return []
  const needle = state.filter.trim().toLowerCase()
  return rowsByCategory(preview.value)
    .map(group => ({
      category: group.category,
      rows: needle
        ? group.rows.filter(row => row.title.toLowerCase().includes(needle) || row.displayUrl.toLowerCase().includes(needle))
        : group.rows,
    }))
    .filter(group => group.rows.length > 0)
})

onMounted(async () => {
  state.roots = await browserTree.roots()
  state.rootId = state.roots.find(root => root.id.startsWith('1'))?.id ?? state.roots[0]?.id ?? ''
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
      <button class="quiet-button" type="button" @click="openOptions">设置</button>
    </header>

    <section class="intro-block">
      <div>
        <p class="section-kicker">从混乱到清晰</p>
        <h2>让 AI 先提案，<br><em>你来定稿。</em></h2>
      </div>
      <p class="intro-copy">只整理你选中的书签范围。完整预览后才会移动，随时可以修改、恢复或撤销。</p>
    </section>

    <nav class="workflow" aria-label="整理流程">
      <span class="workflow-step is-active"><b>01</b>范围</span>
      <i aria-hidden="true"></i>
      <span class="workflow-step"><b>02</b>提案</span>
      <i aria-hidden="true"></i>
      <span class="workflow-step"><b>03</b>确认</span>
    </nav>

    <section class="status-strip" :class="resolved.ok ? 'is-ready' : 'is-warning'">
      <span class="status-dot" aria-hidden="true"></span>
      <div>
        <strong>{{ resolved.ok ? '模型服务已就绪' : '还需要完成设置' }}</strong>
        <p v-if="resolved.ok">{{ config.model }} · {{ resolved.value.origin }}</p>
        <p v-else>{{ resolved.error }}，前往设置页完成连接。</p>
      </div>
      <button v-if="resolved.ok" class="status-action" type="button" :disabled="state.busy" @click="testConnection">
        {{ state.testState === 'ok' ? '已连接' : '测试' }}
      </button>
    </section>

    <section class="setup-panel" aria-labelledby="setup-title">
      <div class="panel-heading">
        <div>
          <p class="section-kicker">开始一次整理</p>
          <h3 id="setup-title">先告诉我从哪里开始</h3>
        </div>
        <span class="panel-index">A / 01</span>
      </div>

      <label class="field-row">
        <span class="field-label">整理范围</span>
        <select v-model="state.rootId" class="text-control">
          <option v-for="root in state.roots" :key="root.id" :value="root.id">
            {{ root.title || root.id }}
          </option>
        </select>
      </label>

      <label class="field-row">
        <span class="field-label">整理要求 <small>可选</small></span>
        <textarea v-model="state.requirement" class="text-control text-area" rows="3" placeholder="例如：按用途分组，工作与生活分开" />
      </label>

      <div class="field-row limit-row">
        <div>
          <span class="field-label">分类数量上限</span>
          <p class="field-help">建议保持在 3–15 个，目录更容易维护。</p>
        </div>
        <input v-model.number="config.categoryLimit" class="number-control" type="number" min="3" max="15" aria-label="分类数量上限">
      </div>

      <div v-if="consentNeeded" class="privacy-note">
        <span class="privacy-icon" aria-hidden="true">◌</span>
        <div>
          <strong>第一次整理前，请确认隐私边界</strong>
          <p>只发送书签标题、脱敏 URL 与相对路径。query、凭据和 fragment 永远不会离开浏览器。</p>
          <button class="text-action" type="button" @click="acceptConsent">我已了解并同意</button>
        </div>
      </div>

      <div class="primary-actions">
        <button class="primary-button" type="button" :disabled="state.busy || consentNeeded" @click="classify">
          <span>{{ state.busy ? '正在整理' : '生成分类提案' }}</span>
          <span aria-hidden="true">→</span>
        </button>
        <button v-if="state.busy" class="secondary-button" type="button" @click="orchestrator.cancel()">取消</button>
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
    <ul v-if="state.ignored.length" class="notice notice-muted">
      <li v-for="item in state.ignored" :key="item">已忽略不支持的要求：{{ item }}</li>
    </ul>

    <section v-if="preview" class="preview-panel" aria-labelledby="preview-title">
      <div class="panel-heading preview-heading">
        <div>
          <p class="section-kicker">B / 可编辑结果</p>
          <h3 id="preview-title">分类提案</h3>
        </div>
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
          <option v-for="category in preview.categories" :key="category.id" :value="category.id">{{ category.name }}</option>
        </select>
      </div>

      <div class="category-list">
        <details v-for="group in groups" :key="group.category.id" open class="category-group">
          <summary>
            <span class="category-summary">
              <span class="category-marker" :class="group.category.id === '__pending__' ? 'is-pending' : ''"></span>
              <input v-if="group.category.id !== '__pending__'" class="category-name" :value="group.category.name" :aria-label="`分类名称：${group.category.name}`" @click.stop @change="rename(group.category.id, ($event.target as HTMLInputElement).value)">
              <span v-else class="category-name">待确认</span>
            </span>
            <span class="category-count">{{ group.rows.length }}</span>
          </summary>
          <button v-if="group.category.id !== '__pending__'" class="delete-action" type="button" @click="drop(group.category.id)">删除分类，保留书签</button>
          <ul class="bookmark-list">
            <li v-for="row in group.rows" :key="row.bookmarkId">
              <label><input type="checkbox" :checked="selected.includes(row.bookmarkId)" @change="toggleSelect(row.bookmarkId)"><span>{{ row.title || row.displayUrl }}</span></label>
              <small :title="row.displayUrl">{{ row.displayUrl }}</small>
            </li>
          </ul>
        </details>
      </div>

      <div v-if="blocking.length" class="notice notice-error blocking-notice">
        <p v-for="item in blocking" :key="item">{{ item }}</p>
      </div>
      <button class="primary-button execute-button" type="button" :disabled="state.busy || blocking.length > 0" @click="confirmExecute">
        <span>确认并执行移动</span><span aria-hidden="true">→</span>
      </button>
    </section>

    <section v-if="state.dropped.length" class="notice notice-muted">
      <strong>无法分类</strong>
      <ul><li v-for="item in state.dropped" :key="item.id">{{ item.title || item.url }}</li></ul>
    </section>

    <section class="recovery-panel">
      <div class="recovery-copy"><p class="section-kicker">安全网</p><h3>最近一次整理</h3><p>{{ state.undoStatus.state === 'available' ? '可以撤销最近一次移动。' : state.undoStatus.state === 'disabled' ? '撤销已被保护性禁用。' : '完成一次整理后，这里会保留撤销入口。' }}</p></div>
      <button class="secondary-button" type="button" :disabled="state.undoStatus.state !== 'available' || state.busy" @click="runUndo">撤销</button>
      <ul v-if="state.undoStatus.state === 'disabled'" class="recovery-reasons"><li v-for="reason in state.undoStatus.reasons" :key="reason">{{ reason }}</li></ul>
      <button v-if="pendingRecovery" class="recovery-link" type="button" :disabled="state.busy" @click="runRecovery">恢复未完成的移动（{{ pendingRecovery.completed.length }} 个）</button>
      <button class="recovery-link muted-link" type="button" @click="clearLocalData">清除本地配置与撤销记录</button>
    </section>
  </main>
</template>

<style>
:root {
  color-scheme: light;
  --ink: #20201e;
  --muted: #77746d;
  --line: #dedbd2;
  --paper: #f6f5f0;
  --surface: #fffefa;
  --accent: #d95332;
  --accent-dark: #a93822;
  --success: #36745d;
  --error: #ad3d35;
}

* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: var(--paper); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
button, input, select, textarea { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .48; }
.workspace-shell { max-width: 580px; margin: 0 auto; padding: 20px 18px 28px; }
.topbar, .brand-lockup, .panel-heading, .workflow, .status-strip, .primary-actions, .progress-meta, .selection-bar, .recovery-panel { display: flex; align-items: center; }
.topbar { justify-content: space-between; margin-bottom: 30px; }
.brand-lockup { gap: 10px; }
.brand-mark { display: grid; width: 30px; height: 30px; place-items: center; border: 1px solid var(--ink); border-radius: 50%; color: var(--accent); font-size: 18px; line-height: 1; }
.eyebrow, .section-kicker { margin: 0 0 4px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .14em; }
.topbar h1 { margin: 0; font-size: 16px; letter-spacing: -.02em; }
.quiet-button, .text-action, .recovery-link, .delete-action { border: 0; background: none; color: var(--accent-dark); font-size: 12px; }
.quiet-button { padding: 6px 0; }
.intro-block { display: grid; gap: 12px; margin-bottom: 24px; }
.intro-block h2 { margin: 0; font-size: clamp(30px, 8vw, 48px); font-weight: 750; letter-spacing: -.075em; line-height: 1.05; }
.intro-block h2 em { color: var(--accent); font-style: normal; }
.intro-copy { max-width: 400px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
.workflow { gap: 10px; margin-bottom: 18px; color: var(--muted); font-size: 11px; }
.workflow-step { display: flex; align-items: center; gap: 5px; white-space: nowrap; }
.workflow-step b { color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.workflow-step.is-active { color: var(--accent-dark); font-weight: 700; }
.workflow i { flex: 1; height: 1px; background: var(--line); }
.status-strip { gap: 10px; padding: 11px 12px; border: 1px solid var(--line); background: rgba(255,254,250,.65); }
.status-dot { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); }
.is-ready .status-dot { background: var(--success); }
.status-strip strong, .status-strip p { display: block; }
.status-strip strong { font-size: 12px; }
.status-strip p { max-width: 340px; margin: 2px 0 0; overflow: hidden; color: var(--muted); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.status-action { margin-left: auto; border: 0; background: none; color: var(--accent-dark); font-size: 11px; }
.setup-panel, .preview-panel, .recovery-panel { margin-top: 14px; border-top: 2px solid var(--ink); background: var(--surface); }
.setup-panel, .preview-panel { padding: 18px 16px; }
.panel-heading { justify-content: space-between; align-items: flex-start; margin-bottom: 18px; }
.panel-heading h3, .recovery-panel h3 { margin: 0; font-size: 18px; letter-spacing: -.04em; }
.panel-index, .preview-total { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.field-row { display: block; margin-top: 16px; }
.field-label { display: block; margin-bottom: 7px; font-size: 12px; font-weight: 700; }
.field-label small { color: var(--muted); font-size: 11px; font-weight: 400; }
.text-control, .number-control, .mini-control { width: 100%; border: 1px solid var(--line); border-radius: 0; outline: 0; background: #fff; color: var(--ink); }
.text-control { padding: 10px 11px; font-size: 13px; transition: border-color .18s, box-shadow .18s; }
.text-control:focus, .number-control:focus, .mini-control:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(217,83,50,.12); }
.text-area { min-height: 76px; resize: vertical; line-height: 1.5; }
.limit-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.field-help { margin: -2px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.number-control { width: 64px; padding: 9px 8px; text-align: center; }
.privacy-note { display: flex; gap: 10px; margin-top: 18px; padding: 12px; border-left: 3px solid var(--accent); background: #fff4ed; }
.privacy-icon { color: var(--accent); font-size: 19px; }
.privacy-note strong { font-size: 12px; }
.privacy-note p { margin: 4px 0 7px; color: #6f625c; font-size: 11px; line-height: 1.6; }
.text-action { padding: 0; font-weight: 700; }
.primary-actions { gap: 8px; margin-top: 20px; }
.primary-button, .secondary-button { min-height: 40px; border-radius: 0; font-size: 13px; font-weight: 700; transition: transform .16s, background .16s, border-color .16s; }
.primary-button { display: flex; flex: 1; align-items: center; justify-content: space-between; padding: 0 13px; border: 1px solid var(--accent); background: var(--accent); color: white; }
.primary-button:hover:not(:disabled) { background: var(--accent-dark); }
.primary-button:active:not(:disabled) { transform: scale(.98); }
.secondary-button { padding: 0 13px; border: 1px solid var(--line); background: transparent; color: var(--ink); }
.progress-block { margin-top: 17px; }
.progress-meta { justify-content: space-between; color: var(--muted); font-size: 11px; }
.progress-meta strong { color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.progress-track { height: 4px; margin-top: 8px; background: #ece9e0; }
.progress-track span { display: block; height: 100%; background: var(--accent); transition: width .25s ease; }
.progress-block p { margin: 7px 0 0; color: var(--muted); font-size: 11px; }
.notice { margin: 12px 0 0; padding: 10px 12px; font-size: 12px; line-height: 1.55; }
.notice-success { border-left: 3px solid var(--success); background: #edf6f0; color: #2d604d; }
.notice-error { border-left: 3px solid var(--error); background: #fff0ed; color: #8f342f; }
.notice-muted { border-left: 3px solid var(--line); background: #eeece6; color: var(--muted); }
.notice ul { margin: 6px 0 0; padding-left: 16px; }
.preview-panel { margin-top: 22px; }
.preview-heading { margin-bottom: 14px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, 1fr); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.metric-grid div { padding: 10px 8px; border-right: 1px solid var(--line); }
.metric-grid div:last-child { border-right: 0; }
.metric-grid strong, .metric-grid span { display: block; }
.metric-grid strong { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 19px; }
.metric-grid span { margin-top: 2px; color: var(--muted); font-size: 10px; }
.search-control { margin-top: 14px; }
.selection-bar { justify-content: space-between; gap: 8px; margin-top: 10px; color: var(--muted); font-size: 11px; }
.mini-control { width: auto; padding: 6px 8px; font-size: 11px; }
.category-list { margin-top: 12px; }
.category-group { border-bottom: 1px solid var(--line); }
.category-group summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 13px 0; cursor: pointer; list-style: none; }
.category-group summary::-webkit-details-marker { display: none; }
.category-summary { display: flex; min-width: 0; align-items: center; gap: 8px; }
.category-marker { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--accent); }
.category-marker.is-pending { background: #aaa69c; }
.category-name { min-width: 0; border: 0; outline: 0; background: transparent; color: var(--ink); font-size: 13px; font-weight: 700; }
.category-count { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.delete-action { display: block; padding: 0 0 8px 16px; color: var(--error); font-size: 11px; }
.bookmark-list { margin: 0; padding: 0 0 9px 16px; list-style: none; }
.bookmark-list li { padding: 7px 0; }
.bookmark-list label { display: flex; align-items: flex-start; gap: 7px; font-size: 12px; line-height: 1.45; }
.bookmark-list input { margin: 2px 0 0; accent-color: var(--accent); }
.bookmark-list label span { overflow-wrap: anywhere; }
.bookmark-list small { display: block; overflow: hidden; margin: 2px 0 0 21px; color: var(--muted); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.blocking-notice { margin-top: 14px; }
.blocking-notice p { margin: 0; }
.execute-button { width: 100%; margin-top: 14px; }
.recovery-panel { display: grid; grid-template-columns: 1fr auto; gap: 12px; padding: 16px; }
.recovery-copy p:last-child { margin: 5px 0 0; color: var(--muted); font-size: 11px; line-height: 1.5; }
.recovery-reasons, .recovery-link { grid-column: 1 / -1; }
.recovery-reasons { margin: 0; padding-left: 16px; color: var(--muted); font-size: 11px; }
.recovery-link { padding: 0; text-align: left; }
.muted-link { color: var(--muted); }
@media (min-width: 640px) { .workspace-shell { padding: 30px 28px 44px; } .intro-block { grid-template-columns: 1.1fr .9fr; align-items: end; } .intro-copy { padding-bottom: 4px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
