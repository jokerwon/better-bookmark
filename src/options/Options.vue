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
  <main class="settings-shell">
    <header class="settings-header">
      <div>
        <p class="eyebrow">BOOKMARK WORKBENCH / CONFIGURATION</p>
        <h1>模型设置</h1>
        <p class="lede">连接你信任的 OpenAI-compatible 服务。所有配置只保存在本机扩展存储中。</p>
      </div>
      <span class="header-index">SET / 01</span>
    </header>

    <section class="settings-layout">
      <div class="settings-main">
        <section class="settings-section">
          <div class="section-title"><span>A</span><div><p>连接信息</p><h2>告诉整理台使用哪个模型</h2></div></div>
          <label class="setting-field"><span>API Key</span><div class="key-row"><input v-model="config.apiKey" :type="showKey ? 'text' : 'password'" placeholder="sk-..." autocomplete="off"><button type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></div></label>
          <label class="setting-field"><span>Base URL</span><input v-model="config.baseUrl" placeholder="https://api.openai.com/v1"><small>不要包含 /chat/completions；非本机地址必须使用 HTTPS。</small></label>
          <label class="setting-field"><span>模型名称</span><input v-model="config.model" placeholder="gpt-4o-mini"></label>
        </section>

        <section class="settings-section">
          <div class="section-title"><span>B</span><div><p>整理偏好</p><h2>让分类结果保持可维护</h2></div></div>
          <label class="setting-field"><span>分类数量上限 <small>({{ CATEGORY_LIMIT_MIN }}–{{ CATEGORY_LIMIT_MAX }})</small></span><input v-model.number="config.categoryLimit" type="number" :min="CATEGORY_LIMIT_MIN" :max="CATEGORY_LIMIT_MAX" class="limit-input"><small>实际上限会再受可分类书签数量限制，也不会制造空分类。</small></label>
        </section>

        <section v-if="resolved.ok" class="endpoint-note"><span class="endpoint-dot"></span><div><strong>请求地址已解析</strong><p>{{ resolved.value.endpoint }}</p></div></section>
        <section v-else class="endpoint-note is-warning"><span class="endpoint-dot"></span><div><strong>还需要完善配置</strong><p>{{ resolved.error }}</p></div></section>

        <div class="settings-actions"><button class="primary-button" type="button" @click="testConnection">测试连接 <span aria-hidden="true">→</span></button><button class="secondary-button" type="button" @click="normalizeLimit">保存分类上限</button></div>
        <p v-if="message" class="notice" :class="messageKind === 'ok' ? 'notice-success' : 'notice-error'" role="status">{{ message }}</p>
      </div>

      <aside class="privacy-aside">
        <p class="eyebrow">LOCAL BY DEFAULT</p>
        <h2>你的书签，<br><em>留在你的边界里。</em></h2>
        <p>扩展不会经过开发方服务器。只有你主动测试连接或开始分类时，才会向当前配置的模型源发送必要的书签信息。</p>
        <ul><li>API Key 只保存在本机</li><li>不会同步到云端</li><li>query、凭据和 fragment 会被移除</li></ul>
      </aside>
    </section>
  </main>
</template>

<style>
:root { color-scheme: light; --ink: #20201e; --muted: #77746d; --line: #dedbd2; --paper: #f6f5f0; --surface: #fffefa; --accent: #d95332; --accent-dark: #a93822; --success: #36745d; --error: #ad3d35; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
button, input { font: inherit; } button { cursor: pointer; } button:disabled { cursor: not-allowed; opacity: .48; }
.settings-shell { max-width: 1020px; margin: 0 auto; padding: 42px 28px 64px; }
.settings-header { display: flex; align-items: flex-start; justify-content: space-between; padding-bottom: 34px; border-bottom: 2px solid var(--ink); }
.eyebrow { margin: 0 0 9px; color: var(--muted); font-size: 10px; font-weight: 700; letter-spacing: .14em; }
h1, h2, p { margin: 0; } .settings-header h1 { font-size: 42px; letter-spacing: -.07em; line-height: 1; } .lede { max-width: 470px; margin-top: 12px; color: var(--muted); font-size: 14px; line-height: 1.7; }
.header-index { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; }
.settings-layout { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 64px; padding-top: 38px; }
.settings-section { padding: 0 0 30px; border-bottom: 1px solid var(--line); }
.settings-section + .settings-section { padding-top: 30px; }
.section-title { display: flex; gap: 14px; margin-bottom: 22px; }.section-title > span { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 700; }.section-title p { margin-bottom: 4px; color: var(--muted); font-size: 11px; }.section-title h2 { font-size: 19px; letter-spacing: -.04em; }
.setting-field { display: block; margin-top: 18px; }.setting-field > span { display: block; margin-bottom: 7px; font-size: 13px; font-weight: 700; }.setting-field > span small { color: var(--muted); font-weight: 400; }.setting-field input { width: 100%; padding: 11px 12px; border: 1px solid var(--line); border-radius: 0; outline: 0; background: var(--surface); color: var(--ink); font-size: 13px; }.setting-field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(217,83,50,.12); }.setting-field small { display: block; margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.5; }.key-row { display: flex; gap: 8px; }.key-row input { flex: 1; }.key-row button { padding: 0 12px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); font-size: 12px; }.limit-input { max-width: 100px; }
.endpoint-note { display: flex; gap: 10px; margin-top: 24px; padding: 12px; background: #edf6f0; color: #2d604d; }.endpoint-note.is-warning { background: #fff4ed; color: #8f342f; }.endpoint-dot { width: 8px; height: 8px; flex: 0 0 auto; margin-top: 4px; border-radius: 50%; background: var(--success); }.is-warning .endpoint-dot { background: var(--accent); }.endpoint-note strong { font-size: 12px; }.endpoint-note p { margin-top: 3px; overflow-wrap: anywhere; font-size: 11px; line-height: 1.5; }
.settings-actions { display: flex; gap: 8px; margin-top: 24px; }.primary-button, .secondary-button { min-height: 42px; border-radius: 0; font-size: 13px; font-weight: 700; }.primary-button { padding: 0 14px; border: 1px solid var(--accent); background: var(--accent); color: #fff; }.secondary-button { padding: 0 14px; border: 1px solid var(--line); background: transparent; color: var(--ink); }.primary-button:hover { background: var(--accent-dark); }.notice { margin-top: 14px; padding: 10px 12px; border-left: 3px solid var(--success); background: #edf6f0; color: #2d604d; font-size: 12px; }.notice-error { border-color: var(--error); background: #fff0ed; color: #8f342f; }
.privacy-aside { align-self: start; padding: 20px; border-top: 2px solid var(--ink); background: var(--surface); }.privacy-aside h2 { font-size: 25px; letter-spacing: -.06em; line-height: 1.1; }.privacy-aside em { color: var(--accent); font-style: normal; }.privacy-aside > p:not(.eyebrow) { margin-top: 16px; color: var(--muted); font-size: 12px; line-height: 1.7; }.privacy-aside ul { margin: 20px 0 0; padding: 14px 0 0 16px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; line-height: 1.9; }
@media (max-width: 760px) { .settings-shell { padding: 24px 18px 40px; }.settings-header h1 { font-size: 34px; }.settings-layout { grid-template-columns: 1fr; gap: 30px; }.privacy-aside { order: -1; }.settings-header { padding-bottom: 26px; } }
</style>
