<script setup lang="ts">
import { computed, ref } from 'vue'
import { CATEGORY_LIMIT_DEFAULT, CATEGORY_LIMIT_MAX, CATEGORY_LIMIT_MIN, clampCategoryLimit, resolveConfig } from '~/core/config'
import { CONNECTION_TEST_MESSAGES, ModelError, createModelClient } from '~/core/model'
import { ensureHostPermission } from '~/core/permissions'
import { useWebExtensionStorage } from '~/composables/useWebExtensionStorage'
import type { ApiConfig } from '~/core/types'

const config = useWebExtensionStorage<ApiConfig>('config', {
  apiKey: '',
  baseUrl: '',
  model: '',
  categoryLimit: CATEGORY_LIMIT_DEFAULT,
})

const message = ref('')
const messageKind = ref<'ok' | 'fail'>('ok')
const showKey = ref(false)

const resolved = computed(() => resolveConfig(config.value))

async function testConnection() {
  message.value = ''
  try {
    if (!resolved.value.ok) {
      messageKind.value = 'fail'
      message.value = resolved.value.error
      return
    }
    if (!(await ensureHostPermission(resolved.value.value.origin))) {
      messageKind.value = 'fail'
      message.value = '未授予该模型源的访问权限'
      return
    }
    // 固定测试消息：不含任何书签数据。
    await createModelClient({ ...config.value }).complete([...CONNECTION_TEST_MESSAGES])
    messageKind.value = 'ok'
    message.value = '连接成功'
  }
  catch (error) {
    messageKind.value = 'fail'
    message.value = error instanceof ModelError ? error.message : '连接失败，请检查配置'
  }
}

function normalizeLimit() {
  config.value = { ...config.value, categoryLimit: clampCategoryLimit(config.value.categoryLimit) }
}
</script>

<template>
  <main class="mx-auto flex max-w-xl flex-col gap-4 p-6 text-sm text-gray-800">
    <h1 class="text-lg font-semibold">
      智能书签分类 · 设置
    </h1>
    <p class="text-xs text-gray-500">
      配置只保存在本机扩展存储中，不会同步，也不会发送到开发方服务器。
    </p>

    <label class="flex flex-col gap-1">
      <span>API Key</span>
      <div class="flex gap-2">
        <input
          v-model="config.apiKey"
          :type="showKey ? 'text' : 'password'"
          class="flex-1 rounded border border-gray-300 p-2"
          placeholder="sk-..."
          autocomplete="off"
        >
        <button class="rounded border border-gray-300 px-2" @click="showKey = !showKey">
          {{ showKey ? '隐藏' : '显示' }}
        </button>
      </div>
    </label>

    <label class="flex flex-col gap-1">
      <span>Base URL</span>
      <input v-model="config.baseUrl" class="rounded border border-gray-300 p-2" placeholder="https://api.openai.com/v1">
      <span class="text-xs text-gray-500">不要包含 /chat/completions；非本机地址必须使用 HTTPS。</span>
    </label>

    <label class="flex flex-col gap-1">
      <span>模型名称</span>
      <input v-model="config.model" class="rounded border border-gray-300 p-2" placeholder="gpt-4o-mini">
    </label>

    <label class="flex flex-col gap-1">
      <span>分类数量上限（{{ CATEGORY_LIMIT_MIN }}–{{ CATEGORY_LIMIT_MAX }}）</span>
      <input
        v-model.number="config.categoryLimit"
        type="number"
        :min="CATEGORY_LIMIT_MIN"
        :max="CATEGORY_LIMIT_MAX"
        class="w-24 rounded border border-gray-300 p-2"
      >
      <span class="text-xs text-gray-500">实际上限会再受可分类书签数量限制，也不会制造空分类。</span>
    </label>

    <p v-if="resolved.ok" class="text-xs text-gray-500">
      请求地址：{{ resolved.value.endpoint }}
    </p>
    <p v-else class="text-xs text-yellow-700">
      {{ resolved.error }}
    </p>

    <div class="flex items-center gap-2">
      <button class="rounded bg-blue-600 px-3 py-2 text-white" @click="testConnection">
        测试连接
      </button>
      <button class="rounded border border-gray-300 px-3 py-2" @click="normalizeLimit">
        保存分类上限
      </button>
    </div>

    <p v-if="message" class="text-xs" :class="messageKind === 'ok' ? 'text-green-600' : 'text-red-600'">
      {{ message }}
    </p>
  </main>
</template>
