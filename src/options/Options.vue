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
  <a class="skip-link" href="#main-content" target="_self">跳到模型设置</a>
  <div class="settings-shell">
    <header class="settings-topbar">
      <a class="brand-lockup brand-home" href="../sidepanel/index.html" target="_self" aria-label="返回书签整理">
        <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 28" fill="none"><path d="M6 3h12v22l-6-4-6 4V3Z" stroke="currentColor" stroke-width="1.5"/><path d="M9 8h6M9 12h6" stroke="currentColor" stroke-width="1.5"/></svg></span>
        <div><p class="brand-name">智能书签分类</p><p class="brand-caption" lang="en">Better Bookmark</p></div>
      </a>
      <a class="button-ghost-sm" href="../sidepanel/index.html" target="_self">返回整理 <span aria-hidden="true">↗</span></a>
    </header>

    <main id="main-content" tabindex="-1">
      <header class="settings-header">
        <p class="eyebrow" lang="en">MODEL & PREFERENCES</p>
        <h1>模型设置</h1>
        <p class="lede">连接你信任的模型。配置在本机自动保存，不会同步到云端。</p>
      </header>

      <div class="settings-layout">
        <div class="settings-main">
          <section class="settings-section" aria-labelledby="connection-title">
            <div class="section-title"><h2 id="connection-title">连接信息</h2><span>OpenAI-compatible</span></div>
            <p class="section-description">使用你自己的 API Key，扩展直接连接模型服务。</p>
            <label class="setting-field"><span>API Key</span><div class="key-row"><input v-model="config.apiKey" :type="showKey ? 'text' : 'password'" placeholder="sk-..." autocomplete="off" spellcheck="false"><button class="button-secondary" type="button" :aria-pressed="showKey" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></div></label>
            <label class="setting-field"><span>Base URL</span><input v-model="config.baseUrl" type="url" placeholder="https://api.openai.com/v1" spellcheck="false" aria-describedby="base-url-help"><small id="base-url-help">不要包含 /chat/completions；非本机地址必须使用 HTTPS。</small></label>
            <label class="setting-field"><span>模型名称</span><input v-model="config.model" placeholder="例如：gpt-4o-mini" spellcheck="false"></label>

            <div class="endpoint-note" :class="{ 'is-ready': resolved.ok }" role="status">
              <span class="status-dot" aria-hidden="true"></span>
              <div v-if="resolved.ok"><strong>请求地址已解析，尚需测试连接</strong><p>{{ resolved.value.endpoint }}</p></div>
              <div v-else><strong>配置未完成</strong><p>{{ resolved.error }}</p></div>
            </div>
            <div class="settings-actions"><button class="button-primary" type="button" @click="testConnection">测试连接 <span aria-hidden="true">→</span></button><p>只发送固定测试消息，不含书签数据。</p></div>
            <p v-if="message" class="notice" :class="messageKind === 'ok' ? 'notice-success' : 'notice-error'" role="status">{{ message }}</p>
          </section>

          <section class="settings-section" aria-labelledby="preferences-title">
            <div class="section-title"><h2 id="preferences-title">分类偏好</h2><span>最多三层分类树</span></div>
            <label class="setting-field preference-field"><div><span class="field-label">分类数量上限 <small>{{ CATEGORY_LIMIT_MIN }}–{{ CATEGORY_LIMIT_MAX }}</small></span><span class="field-help">分别限制每层数量，不会生成空分类。<br>实际上限还受可分类书签数量限制。</span></div><input v-model.number="config.categoryLimit" type="number" :min="CATEGORY_LIMIT_MIN" :max="CATEGORY_LIMIT_MAX" aria-label="分类数量上限" @change="normalizeLimit"></label>
          </section>
        </div>

        <aside class="privacy-aside" aria-labelledby="privacy-title">
          <p class="eyebrow" lang="en">YOUR DATA, YOUR CALL</p>
          <h2 id="privacy-title">数据边界，<br>始终由你决定。</h2>
          <dl>
            <div><dt>保存在本机</dt><dd>API Key、配置、隐私确认与撤销记录只存于本机扩展存储，不同步、不上报。</dd></div>
            <div><dt>只连接你的模型</dt><dd>请求不经过开发方服务器。测试连接只发送固定消息；分类前需确认授权。</dd></div>
            <div><dt>仅发送必要信息</dt><dd>分类时发送标题、脱敏 URL 与相对路径。移除 query、凭据和 fragment，不抓取网页正文。</dd></div>
          </dl>
          <p class="privacy-footnote">修改 Base URL 或模型后，分类前需要重新确认隐私边界。</p>
        </aside>
      </div>
    </main>
    <footer class="settings-footer"><span lang="en">Better Bookmark</span><span>本机配置 · 按需授权</span></footer>
  </div>
</template>

