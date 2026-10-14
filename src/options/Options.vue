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
          <label class="setting-field"><span>API Key</span><div class="key-row"><input v-model="config.apiKey" :type="showKey ? 'text' : 'password'" placeholder="sk-..." autocomplete="off"><button class="button-ghost-sm" type="button" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></div></label>
          <label class="setting-field"><span>Base URL</span><input v-model="config.baseUrl" placeholder="https://api.openai.com/v1"><small>不要包含 /chat/completions；非本机地址必须使用 HTTPS。</small></label>
          <label class="setting-field"><span>模型名称</span><input v-model="config.model" placeholder="gpt-4o-mini"></label>
        </section>

        <section class="settings-section">
          <div class="section-title"><span>B</span><div><p>整理偏好</p><h2>让分类结果保持可维护</h2></div></div>
          <label class="setting-field"><span>分类数量上限 <small>({{ CATEGORY_LIMIT_MIN }}–{{ CATEGORY_LIMIT_MAX }})</small></span><input v-model.number="config.categoryLimit" type="number" :min="CATEGORY_LIMIT_MIN" :max="CATEGORY_LIMIT_MAX" class="limit-input"><small>实际上限会再受可分类书签数量限制，也不会制造空分类。</small></label>
        </section>

        <section v-if="resolved.ok" class="endpoint-note"><span class="endpoint-dot"></span><div><strong>请求地址已解析</strong><p>{{ resolved.value.endpoint }}</p></div></section>
        <section v-else class="endpoint-note is-warning"><span class="endpoint-dot"></span><div><strong>还需要完善配置</strong><p>{{ resolved.error }}</p></div></section>

        <div class="settings-actions"><button class="button-primary" type="button" @click="testConnection">测试连接 <span aria-hidden="true">→</span></button><button class="button-secondary" type="button" @click="normalizeLimit">保存分类上限</button></div>
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
:root { color-scheme: light; --ink: #171717; --body: #4d4d4d; --mute: #8f8f8f; --hairline: #ebebeb; --hairline-soft: #f2f2f2; --canvas: #fafafa; --surface: #fff; --link: #0070f3; --error: #ee0000; }
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--canvas); color: var(--ink); font-family: Geist, Inter, Arial, "PingFang SC", "Microsoft YaHei", sans-serif; }
body { font-size: 14px; }
button, input { font: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .48; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
.settings-shell { max-width: 1080px; margin: 0 auto; padding: 32px 28px 72px; }
.settings-header { display: flex; align-items: flex-start; justify-content: space-between; padding-bottom: 34px; border-bottom: 1px solid var(--ink); }
.eyebrow { margin: 0 0 10px; color: var(--mute); font-family: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 500; letter-spacing: .02em; }
h1, h2, p { margin: 0; }
.settings-header h1 { font-size: clamp(38px, 6vw, 52px); font-weight: 600; line-height: 1; letter-spacing: -2.4px; }
.lede { max-width: 490px; margin-top: 16px; color: var(--body); font-size: 16px; line-height: 1.6; }
.header-index { color: var(--mute); font-family: "Geist Mono", ui-monospace, monospace; font-size: 11px; }
.settings-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 72px; padding-top: 44px; }
.settings-section { padding: 0 0 32px; border-bottom: 1px solid var(--hairline); }
.settings-section + .settings-section { padding-top: 32px; }
.section-title { display: flex; gap: 16px; margin-bottom: 24px; }
.section-title > span { color: var(--link); font-family: "Geist Mono", ui-monospace, monospace; font-size: 12px; font-weight: 500; }
.section-title p { margin-bottom: 5px; color: var(--mute); font-family: "Geist Mono", ui-monospace, monospace; font-size: 11px; }
.section-title h2 { font-size: 20px; font-weight: 600; letter-spacing: -.4px; }
.setting-field { display: block; margin-top: 20px; }
.setting-field > span { display: block; margin-bottom: 8px; font-size: 14px; font-weight: 500; }
.setting-field > span small { color: var(--mute); font-weight: 400; }
.setting-field input { width: 100%; padding: 11px 12px; border: 1px solid var(--hairline); border-radius: 6px; outline: 0; background: var(--surface); color: var(--ink); font-size: 14px; transition: border-color .16s, box-shadow .16s; }
.setting-field input:focus { border-color: var(--link); box-shadow: 0 0 0 3px rgba(0,112,243,.12); }
.setting-field small { display: block; margin-top: 7px; color: var(--mute); font-size: 12px; line-height: 1.55; }
.key-row { display: flex; gap: 8px; }
.key-row input { flex: 1; }
.button-ghost-sm, .button-secondary { border: 1px solid var(--hairline); border-radius: 6px; background: var(--surface); color: var(--ink); font-size: 14px; font-weight: 500; }
.button-ghost-sm { min-height: 42px; padding: 0 12px; }
.limit-input { max-width: 110px; }
.endpoint-note { display: flex; gap: 10px; margin-top: 26px; padding: 14px; border: 1px solid #b9d9ff; background: #f1f7ff; color: #0756ae; }
.endpoint-note.is-warning { border-color: #ffcaca; background: #fff5f5; color: #a50000; }
.endpoint-dot { width: 7px; height: 7px; flex: 0 0 auto; margin-top: 5px; border-radius: 50%; background: var(--link); }
.is-warning .endpoint-dot { background: var(--error); }
.endpoint-note strong { font-size: 13px; font-weight: 600; }
.endpoint-note p { margin-top: 4px; overflow-wrap: anywhere; font-family: "Geist Mono", ui-monospace, monospace; font-size: 12px; line-height: 1.5; }
.settings-actions { display: flex; gap: 8px; margin-top: 26px; }
.button-primary, .button-secondary { min-height: 44px; font-size: 14px; font-weight: 500; transition: background .16s, border-color .16s, transform .16s; }
.button-primary { padding: 0 16px; border: 1px solid var(--ink); border-radius: 100px; background: var(--ink); color: #fff; }
.button-primary:hover { background: #333; }
.button-secondary { padding: 0 16px; }
.notice { margin-top: 16px; padding: 12px 14px; border: 1px solid #b9d9ff; background: #f1f7ff; color: #0756ae; font-size: 13px; line-height: 1.55; }
.notice-error { border-color: #ffcaca; background: #fff5f5; color: #a50000; }
.privacy-aside { align-self: start; padding: 22px; border: 1px solid var(--hairline); background: var(--surface); }
.privacy-aside h2 { font-size: 28px; font-weight: 600; line-height: 1.12; letter-spacing: -1px; }
.privacy-aside em { background: linear-gradient(90deg, #007cf0, #7928ca 55%, #ff0080); -webkit-background-clip: text; background-clip: text; color: transparent; font-style: normal; }
.privacy-aside > p:not(.eyebrow) { margin-top: 18px; color: var(--body); font-size: 14px; line-height: 1.7; }
.privacy-aside ul { margin: 22px 0 0; padding: 16px 0 0 18px; border-top: 1px solid var(--hairline); color: var(--body); font-size: 13px; line-height: 1.9; }
@media (max-width: 760px) { .settings-shell { padding: 24px 18px 48px; } .settings-header h1 { font-size: 40px; } .settings-layout { grid-template-columns: 1fr; gap: 32px; padding-top: 30px; } .privacy-aside { order: -1; } .settings-header { padding-bottom: 26px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; animation-duration: .01ms !important; } }
</style>
