<script setup lang="ts">
import { nextTick, ref } from 'vue'
import BookmarkShelf from './BookmarkShelf.vue'
import OrganizeWorkspace from './OrganizeWorkspace.vue'
import PagekeepBrand from '~/PagekeepBrand.vue'
import { browserApi } from '~/core/browser-api'

const params = new URLSearchParams(location.search)
const organizing = ref(params.get('view') === 'organize' || params.has('filter'))
const workspaceOpened = ref(organizing.value)
const main = ref<HTMLElement>()
const searchTarget = ref<HTMLElement>()
const shelf = ref<InstanceType<typeof BookmarkShelf>>()
const settingsError = ref(false)

function bindSearchTarget(element: unknown) {
  searchTarget.value = element instanceof HTMLElement ? element : undefined
}

async function switchView(showWorkspace: boolean) {
  if (showWorkspace)
    workspaceOpened.value = true
  const url = new URL(location.href)
  if (showWorkspace) {
    url.searchParams.set('view', 'organize')
  }
  else {
    url.searchParams.delete('view')
    url.searchParams.delete('filter')
  }
  history.replaceState(history.state, '', url)
  organizing.value = showWorkspace
  await nextTick()
  if (showWorkspace) {
    window.scrollTo(0, 0)
    main.value?.focus({ preventScroll: true })
  }
  else {
    await shelf.value?.returnToShelf()
  }
}

async function openSettings() {
  settingsError.value = false
  try {
    await browserApi.runtime.openOptionsPage()
  }
  catch {
    settingsError.value = true
  }
}
</script>

<template>
  <a class="skip-link" href="#main-content" target="_self">跳到{{ organizing ? '整理' : '书签' }}内容</a>
  <header class="pagekeep-masthead">
    <div class="pagekeep-bar">
      <PagekeepBrand :caption="organizing ? 'SORT' : 'SHELF'" />
      <div v-show="!organizing" :ref="bindSearchTarget" class="pagekeep-search" />
      <div v-if="organizing" class="pagekeep-actions">
        <button class="button-ghost-sm" type="button" @click="openSettings">
          模型设置
        </button>
        <button class="button-secondary" type="button" @click="switchView(false)">
          返回书架
        </button>
      </div>
      <button v-else class="button-primary" type="button" @click="switchView(true)">
        <svg class="organize-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="1.5" aria-hidden="true">
          <path d="m10 3 1.8 5.2L17 10l-5.2 1.8L10 17l-1.8-5.2L3 10l5.2-1.8L10 3Zm8 10 1 2.8 2.8 1.2-2.8 1-1 3-1.2-3-2.8-1 2.8-1.2L18 13Z" />
        </svg>
        智能分类
      </button>
    </div>
  </header>
  <main id="main-content" ref="main" tabindex="-1">
    <BookmarkShelf v-show="!organizing" ref="shelf" :active="!organizing" :search-target="searchTarget" />
    <p v-if="organizing && settingsError" class="pagekeep-settings-error notice notice-error" role="alert">
      无法打开模型设置。请从浏览器的扩展管理页打开扩展选项。
    </p>
    <OrganizeWorkspace v-if="workspaceOpened" v-show="organizing" :active="organizing" />
  </main>
</template>

<style>
.pagekeep-masthead { border-bottom: 1px solid var(--line); }
.pagekeep-bar { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 75px; max-width: var(--layout); margin-inline: auto; padding: 8px var(--gutter); }
.pagekeep-search { min-width: 0; width: min(440px, 48%); margin-left: auto; }
.pagekeep-actions { display: flex; align-items: center; gap: 6px; }
.pagekeep-actions button { white-space: nowrap; }
.organize-icon { width: 18px; height: 18px; }
.pagekeep-settings-error { max-width: 712px; margin-inline: max(var(--gutter), calc((100% - 712px) / 2)); }
@media (max-width: 620px) {
  .pagekeep-bar { display: grid; grid-template-columns: minmax(0, 1fr) auto; min-height: 64px; }
  .pagekeep-search { grid-row: 2; grid-column: 1 / -1; width: 100%; margin: 0; }
  .pagekeep-actions .button-secondary { padding-inline: 8px; }
}
</style>
