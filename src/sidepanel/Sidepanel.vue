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
  <main class="flex flex-col gap-3 p-3 text-sm text-gray-800">
    <header class="flex items-center justify-between">
      <h1 class="text-base font-semibold">
        智能书签分类
      </h1>
      <button class="text-xs text-blue-600" @click="openOptions">
        设置
      </button>
    </header>

    <p v-if="resolved.ok" class="rounded bg-gray-100 p-2 text-xs text-gray-600">
      模型服务：{{ resolved.value.endpoint }}（{{ config.model }}）
    </p>
    <p v-else class="rounded bg-yellow-50 p-2 text-xs text-yellow-700">
      {{ resolved.error }}，请先前往设置。
    </p>

    <section class="flex flex-col gap-2 rounded border border-gray-200 p-2">
      <label class="flex flex-col gap-1">
        <span class="text-xs text-gray-500">整理范围</span>
        <select v-model="state.rootId" class="rounded border border-gray-300 p-1">
          <option v-for="root in state.roots" :key="root.id" :value="root.id">
            {{ root.title || root.id }}
          </option>
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-xs text-gray-500">整理要求（可选）</span>
        <textarea v-model="state.requirement" rows="2" class="rounded border border-gray-300 p-1" placeholder="例如：按用途分组，工作与生活分开" />
      </label>
      <label class="flex items-center gap-2">
        <span class="text-xs text-gray-500">分类数量上限</span>
        <input v-model.number="config.categoryLimit" type="number" min="3" max="15" class="w-16 rounded border border-gray-300 p-1">
      </label>
      <button class="rounded bg-blue-600 p-1.5 text-white disabled:opacity-50" :disabled="state.busy" @click="testConnection">
        测试连接
      </button>
      <p v-if="state.testMessage" class="text-xs" :class="state.testState === 'ok' ? 'text-green-600' : 'text-red-600'">
        {{ state.testMessage }}
      </p>
      <div v-if="consentNeeded" class="rounded bg-yellow-50 p-2 text-xs text-yellow-800">
        <p>书签标题、脱敏后的 URL 与相对文件夹路径会发送到上述服务；query、凭据与 fragment 不会发送。确认后才会调用模型。</p>
        <button class="mt-1 rounded bg-yellow-600 px-2 py-1 text-white" @click="acceptConsent">
          我已了解并同意
        </button>
      </div>
      <button class="rounded bg-blue-600 p-1.5 text-white disabled:opacity-50" :disabled="state.busy || consentNeeded" @click="classify">
        开始分类
      </button>
      <button v-if="state.busy" class="rounded border border-gray-300 p-1.5" @click="orchestrator.cancel()">
        取消
      </button>
      <p v-if="state.progress" class="text-xs text-gray-500">
        {{ state.progress.stage }} {{ state.progress.done }}/{{ state.progress.total }}
        <span v-if="state.progress.message">（{{ state.progress.message }}）</span>
      </p>
    </section>

    <p v-if="state.error" class="rounded bg-red-50 p-2 text-xs text-red-700">
      {{ state.error }}
    </p>
    <p v-if="state.message" class="rounded bg-green-50 p-2 text-xs text-green-700">
      {{ state.message }}
    </p>
    <ul v-if="state.ignored.length" class="rounded bg-gray-100 p-2 text-xs text-gray-600">
      <li v-for="item in state.ignored" :key="item">
        已忽略不支持的破坏性要求：{{ item }}
      </li>
    </ul>

    <section v-if="preview" class="flex flex-col gap-2">
      <div class="flex items-center justify-between text-xs text-gray-600">
        <span>共 {{ preview.counts.total }} 条，待移动 {{ preview.counts.moving }}，不变 {{ preview.counts.unchanged }}，待确认 {{ preview.counts.pending }}，无法分类 {{ preview.counts.unclassifiable }}</span>
      </div>
      <input v-model="state.filter" class="rounded border border-gray-300 p-1 text-xs" placeholder="按标题或 URL 筛选">
      <p v-if="selected.length" class="flex items-center gap-2 text-xs">
        已选 {{ selected.length }} 条
        <select class="rounded border border-gray-300 p-1" @change="batchAssign(($event.target as HTMLSelectElement).value || null)">
          <option value="">
            改为待确认
          </option>
          <option v-for="category in preview.categories" :key="category.id" :value="category.id">
            {{ category.name }}
          </option>
        </select>
      </p>

      <details v-for="group in groups" :key="group.category.id" class="rounded border border-gray-200 p-2">
        <summary class="flex items-center justify-between">
          <input
            v-if="group.category.id !== '__pending__'"
            class="mr-1 rounded border border-gray-300 p-0.5 text-xs"
            :value="group.category.name"
            @change="rename(group.category.id, ($event.target as HTMLInputElement).value)"
          >
          <span v-else>待确认</span>
          <span class="text-xs text-gray-500">{{ group.rows.length }}</span>
        </summary>
        <button
          v-if="group.category.id !== '__pending__'"
          class="mt-1 text-xs text-red-600"
          @click="drop(group.category.id)"
        >
          删除该分类（其书签回到待确认）
        </button>
        <ul class="mt-1 flex flex-col gap-1">
          <li v-for="row in group.rows" :key="row.bookmarkId" class="flex items-start gap-1 text-xs">
            <input type="checkbox" :checked="selected.includes(row.bookmarkId)" @change="toggleSelect(row.bookmarkId)">
            <span class="line-clamp-2" :title="row.displayUrl">{{ row.title || row.displayUrl }}</span>
          </li>
        </ul>
      </details>

      <div v-if="blocking.length" class="rounded bg-red-50 p-2 text-xs text-red-700">
        <p v-for="item in blocking" :key="item">
          {{ item }}
        </p>
      </div>
      <button class="rounded bg-blue-600 p-1.5 text-white disabled:opacity-50" :disabled="state.busy || blocking.length > 0" @click="confirmExecute">
        确认并执行
      </button>
    </section>

    <ul v-if="state.dropped.length" class="rounded bg-gray-100 p-2 text-xs text-gray-600">
      <li v-for="item in state.dropped" :key="item.id">
        无法分类：{{ item.title || item.url }}
      </li>
    </ul>

    <section class="flex flex-col gap-2 rounded border border-gray-200 p-2">
      <div class="flex items-center justify-between text-xs">
        <span>撤销：{{ state.undoStatus.state === 'available' ? '可用' : state.undoStatus.state === 'disabled' ? '已禁用' : '无记录' }}</span>
        <button class="text-blue-600 disabled:opacity-50" :disabled="state.undoStatus.state !== 'available' || state.busy" @click="runUndo">
          撤销上次整理
        </button>
      </div>
      <ul v-if="state.undoStatus.state === 'disabled'" class="text-xs text-gray-600">
        <li v-for="reason in state.undoStatus.reasons" :key="reason">
          {{ reason }}
        </li>
      </ul>
      <button v-if="pendingRecovery" class="rounded border border-gray-300 p-1.5 text-xs" :disabled="state.busy" @click="runRecovery">
        恢复未完成的移动（{{ pendingRecovery.completed.length }} 个）
      </button>
      <button class="text-xs text-gray-500" @click="clearLocalData">
        清除本地配置与撤销记录
      </button>
    </section>
  </main>
</template>
