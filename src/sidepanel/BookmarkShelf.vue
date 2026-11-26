<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import BookmarkDetails from './BookmarkDetails.vue'
import { buildShelfCatalog, hasReliableDates } from './shelf-catalog'
import type { ShelfBookmark, ShelfCatalog } from './shelf-catalog'
import { browserApi } from '~/core/browser-api'
import './shelf.css'

const props = defineProps<{ active: boolean, searchTarget?: HTMLElement | null }>()

const EMPTY_CATALOG: ShelfCatalog = { total: 0, folders: [], bookmarks: [], covers: [] }
const REFRESH_DELAY = 160

const rootEl = ref<HTMLElement | null>(null)
const headingEl = ref<HTMLElement | null>(null)
const listTitleEl = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const catalog = shallowRef<ShelfCatalog>(EMPTY_CATALOG)
const loading = ref(true)
const loadError = ref('')

const initialParams = new URLSearchParams(location.search)
const query = ref(initialParams.get('q') ?? '')
const scopeId = ref<string | null>(initialParams.get('topic'))
const activeId = ref<string | null>(null)
const selectedId = ref<string | null>(null)
const shown = ref(100)
const wide = ref(false)
let wideQuery: MediaQueryList | undefined

let restoreScrollY = 0
let restoreFocusId = ''
let savedTopicId = ''
let detailTrigger: HTMLElement | null = null
let stale = false
let importing = false
let refreshTimer: number | null = null
let loadVersion = 0
const cleanups: Array<() => void> = []

const tokens = computed(() => {
  const phrase = query.value.trim().toLocaleLowerCase()
  return phrase ? phrase.split(/\s+/).filter(Boolean) : []
})

const scopeFolder = computed(() => scopeId.value
  ? catalog.value.folders.find(folder => folder.id === scopeId.value) ?? null
  : null)

const scopedBookmarks = computed(() => scopeId.value
  ? catalog.value.bookmarks.filter(bookmark => bookmark.folderIds.includes(scopeId.value!))
  : catalog.value.bookmarks)

const matchedBookmarks = computed(() => {
  if (!tokens.value.length)
    return scopedBookmarks.value
  return scopedBookmarks.value.filter(bookmark => tokens.value.every(token => bookmark.searchText.includes(token)))
})

const datesReliable = computed(() => hasReliableDates(matchedBookmarks.value))
const visibleBookmarks = computed(() => {
  const list = matchedBookmarks.value
  return datesReliable.value ? [...list].sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0) || a.order - b.order) : list
})
const shownBookmarks = computed(() => visibleBookmarks.value.slice(0, shown.value))
const selectedBookmark = computed(() => selectedId.value
  ? shownBookmarks.value.find(bookmark => bookmark.id === selectedId.value) ?? null
  : null)

const listHeading = computed(() => {
  if (tokens.value.length)
    return '搜索结果'
  if (scopeFolder.value)
    return scopeFolder.value.title
  return datesReliable.value ? '最近收录' : '全部书签'
})

const searchLabel = computed(() => scopeFolder.value
  ? `在「${scopeFolder.value.title}」中搜索书签`
  : '搜索书签')

const searchPlaceholder = computed(() => scopeFolder.value
  ? `在「${scopeFolder.value.title}」中搜索标题、网站或路径`
  : '搜索标题、网站或文件夹路径')

const emptyTitle = computed(() => query.value.trim()
  ? '没有匹配的书签'
  : scopeFolder.value ? '这个文件夹还没有书签' : '还没有可浏览的书签')

function displayTitle(bookmark: ShelfBookmark): string {
  return bookmark.title || bookmark.url || '未命名书签'
}

function domainLabel(bookmark: ShelfBookmark): string {
  if (bookmark.domain)
    return bookmark.domain
  return bookmark.url ? '非网页地址' : '无地址'
}

async function loadShelf(): Promise<void> {
  const version = ++loadVersion
  try {
    const tree = await browserApi.bookmarks.getTree()
    if (version !== loadVersion)
      return
    const next = buildShelfCatalog(tree)
    catalog.value = next
    loadError.value = ''
    if (scopeId.value && !next.folders.some(folder => folder.id === scopeId.value))
      scopeId.value = null
    if (activeId.value && !next.bookmarks.some(bookmark => bookmark.id === activeId.value))
      activeId.value = null
    if (selectedId.value && !next.bookmarks.some(bookmark => bookmark.id === selectedId.value))
      selectedId.value = null
  }
  catch {
    if (version === loadVersion)
      loadError.value = '读取书签失败，请稍后重试'
  }
  finally {
    if (version === loadVersion)
      loading.value = false
  }
}

function clearRefreshTimer(): void {
  if (refreshTimer) {
    window.clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleRefresh(): void {
  if (refreshTimer)
    return
  refreshTimer = window.setTimeout(() => {
    refreshTimer = null
    void loadShelf()
  }, REFRESH_DELAY)
}

/** 外部移动、导入会产生一串事件；合并为一次读取。 */
function onBookmarkMutation(): void {
  if (importing)
    return
  if (props.active)
    scheduleRefresh()
  else
    stale = true
}

function onImportBegan(): void {
  importing = true
  clearRefreshTimer()
}

function onImportEnded(): void {
  importing = false
  onBookmarkMutation()
}

interface MutationEvent {
  addListener: (listener: () => void) => void
  removeListener: (listener: () => void) => void
}

function attachBookmarkEvents(): void {
  const bookmarks = browserApi.bookmarks
  const mutation = () => onBookmarkMutation()
  bookmarks.onCreated.addListener(mutation)
  bookmarks.onChanged.addListener(mutation)
  bookmarks.onMoved.addListener(mutation)
  bookmarks.onRemoved.addListener(mutation)
  cleanups.push(() => {
    bookmarks.onCreated.removeListener(mutation)
    bookmarks.onChanged.removeListener(mutation)
    bookmarks.onMoved.removeListener(mutation)
    bookmarks.onRemoved.removeListener(mutation)
  })

  // 扩展 API 有这些事件，但 polyfill 类型未声明；按结构读取可选事件。
  const extra = bookmarks as unknown as Record<string, MutationEvent | undefined>
  for (const name of ['onChildrenReordered', 'onImportBegan', 'onImportEnded']) {
    const event = extra[name]
    if (!event)
      continue
    const listener = name === 'onImportBegan' ? () => onImportBegan() : name === 'onImportEnded' ? () => onImportEnded() : mutation
    event.addListener(listener)
    cleanups.push(() => event.removeListener(listener))
  }
}

function syncLocation(): void {
  if (!props.active)
    return
  const url = new URL(location.href)
  if (query.value)
    url.searchParams.set('q', query.value)
  else
    url.searchParams.delete('q')
  if (scopeId.value)
    url.searchParams.set('topic', scopeId.value)
  else
    url.searchParams.delete('topic')
  history.replaceState(history.state, '', url)
}

function focusSearch(): void {
  searchInput.value?.focus()
  searchInput.value?.select()
}

function enterTopic(folderId: string): void {
  if (!scopeId.value) {
    restoreScrollY = window.scrollY
    const focused = document.activeElement
    restoreFocusId = focused instanceof HTMLElement ? focused.id : ''
    savedTopicId = folderId
  }
  scopeId.value = folderId
  query.value = ''
  activeId.value = null
  selectedId.value = null
  void nextTick(() => listTitleEl.value?.focus())
}

function clearQuery(): void {
  query.value = ''
  activeId.value = null
  void nextTick(() => searchInput.value?.focus())
}

function clearScope(focusSearchAfter = false): void {
  scopeId.value = null
  void nextTick(() => {
    if (focusSearchAfter)
      focusSearch()
    else
      listTitleEl.value?.focus()
  })
}

async function returnToShelf(): Promise<void> {
  const scrollY = restoreScrollY
  const focusId = restoreFocusId
  const coverId = savedTopicId
  restoreScrollY = 0
  restoreFocusId = ''
  savedTopicId = ''
  query.value = ''
  scopeId.value = null
  activeId.value = null
  selectedId.value = null
  await nextTick()
  try {
    window.scrollTo(0, scrollY)
  }
  catch {
    // 页面被脚本关闭或运行在受限环境时忽略滚动恢复。
  }
  const target = (focusId ? document.getElementById(focusId) : null)
    ?? (coverId ? document.getElementById(`shelf-cover-${coverId}`) : null)
    ?? headingEl.value
  target?.focus({ preventScroll: true })
}

function activate(bookmarkId: string): void {
  activeId.value = bookmarkId
}

async function scrollActiveRow(index: number): Promise<void> {
  if (index >= shown.value)
    shown.value = Math.ceil((index + 1) / 100) * 100
  await nextTick()
  document.getElementById(`shelf-row-${activeId.value}`)?.scrollIntoView?.({ block: 'nearest' })
}

function openBookmark(bookmark: ShelfBookmark): void {
  if (!bookmark.href) {
    openDetails(bookmark)
    return
  }
  window.open(bookmark.href, '_blank', 'noopener,noreferrer')
}

function updateDetailLayout(): void {
  wide.value = wideQuery?.matches ?? false
}

function openDetails(bookmark: ShelfBookmark, event?: MouseEvent): void {
  activeId.value = bookmark.id
  detailTrigger = event?.currentTarget instanceof HTMLElement ? event.currentTarget : searchInput.value
  selectedId.value = bookmark.id
  void nextTick(() => {
    rootEl.value?.querySelector<HTMLElement>('.shelf-detail-panel')?.focus()
  })
}

function closeDetails(): void {
  const trigger = detailTrigger
  selectedId.value = null
  void nextTick(() => {
    if (trigger?.isConnected)
      trigger.focus()
    else
      listTitleEl.value?.focus()
  })
}

function onSearchKeydown(event: KeyboardEvent): void {
  // 输入法组字期间不拦截方向键与回车。
  if (event.isComposing || event.keyCode === 229)
    return

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!visibleBookmarks.value.length)
      return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    const current = visibleBookmarks.value.findIndex(bookmark => bookmark.id === activeId.value)
    const index = current < 0
      ? (direction === 1 ? 0 : visibleBookmarks.value.length - 1)
      : (current + direction + visibleBookmarks.value.length) % visibleBookmarks.value.length
    activeId.value = visibleBookmarks.value[index].id
    void scrollActiveRow(index)
    return
  }

  if (event.key === 'Enter') {
    const bookmark = visibleBookmarks.value.find(entry => entry.id === activeId.value) ?? visibleBookmarks.value[0]
    if (!bookmark)
      return
    event.preventDefault()
    activeId.value = bookmark.id
    openBookmark(bookmark)
    return
  }

  if (event.key === 'Escape') {
    if (query.value) {
      event.preventDefault()
      clearQuery()
    }
    else if (scopeId.value) {
      event.preventDefault()
      clearScope(true)
    }
  }
}

function onSearchShortcut(event: KeyboardEvent): void {
  if (!props.active)
    return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    focusSearch()
  }
}

watch([query, scopeId], () => {
  shown.value = 100
  activeId.value = null
  selectedId.value = null
  syncLocation()
})

watch(visibleBookmarks, (list) => {
  if (activeId.value && !list.some(bookmark => bookmark.id === activeId.value))
    activeId.value = null
})

watch(() => props.active, (isActive) => {
  if (!isActive)
    return
  // 重新进入书架时让地址栏只补上书架自己的参数，不覆盖视图等无关参数。
  syncLocation()
  if (stale) {
    stale = false
    void loadShelf()
  }
})

onMounted(() => {
  wideQuery = window.matchMedia?.('(min-width: 901px)')
  wideQuery?.addEventListener('change', updateDetailLayout)
  updateDetailLayout()
  void loadShelf()
  attachBookmarkEvents()
  document.addEventListener('keydown', onSearchShortcut)
})

onUnmounted(() => {
  wideQuery?.removeEventListener('change', updateDetailLayout)
  loadVersion += 1
  clearRefreshTimer()
  for (const cleanup of cleanups)
    cleanup()
  document.removeEventListener('keydown', onSearchShortcut)
})

defineExpose({ returnToShelf })
</script>

<template>
  <section ref="rootEl" class="shelf-panel" aria-labelledby="shelf-title">
    <header class="shelf-intro">
      <div>
        <h1 id="shelf-title" ref="headingEl" tabindex="-1">
          主题书架
        </h1>
        <p>从一个主题开始，重读那些值得留下的网页。</p>
      </div>
      <p class="shelf-folio">
        <strong>{{ catalog.total }}</strong><span>条书签</span>
      </p>
    </header>

    <Teleport :to="searchTarget ?? 'body'" :disabled="!searchTarget">
      <div class="shelf-search" role="search" aria-label="搜索书签">
        <svg class="shelf-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.7" cy="10.7" r="6.1" fill="none" stroke="currentColor" stroke-width="1.6" />
          <path d="m15 15 4.7 4.7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
        <input
          id="shelf-search-input"
          ref="searchInput"
          v-model="query"
          type="text"
          :aria-label="searchLabel"
          :placeholder="searchPlaceholder"
          aria-controls="shelf-rows"
          autocomplete="off"
          @keydown="onSearchKeydown"
        >
        <button v-if="query" class="shelf-clear" type="button" aria-label="清空搜索" @click="clearQuery">
          清空
        </button>
        <kbd class="shelf-kbd" aria-hidden="true">⌘ K</kbd>
      </div>
    </Teleport>

    <nav v-if="!tokens.length && catalog.covers.length" class="shelf-covers" aria-label="浏览主题文件夹">
      <button
        v-for="(folder, index) in catalog.covers"
        :id="`shelf-cover-${folder.id}`"
        :key="folder.id"
        class="shelf-cover"
        :class="`tone-${index}`"
        type="button"
        :aria-pressed="scopeId === folder.id"
        :data-topic-id="folder.id"
        @click="enterTopic(folder.id)"
      >
        <span class="shelf-cover-top">
          <span class="shelf-mono" lang="en">PAGEKEEP / TOPIC</span>
          <svg class="shelf-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 7a1 1 0 0 1 1-1H10l2 2h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </span>

        <span class="shelf-cover-art">
          <svg v-if="index === 0" viewBox="0 0 320 150" aria-hidden="true" focusable="false">
            <g fill="none" stroke="var(--art-ink)" stroke-width="1.2" opacity=".55">
              <path d="M18 132h284M18 20v112M42 132V52h16m184 0h56v80" />
              <circle cx="207" cy="66" r="42" />
              <path d="M207 24v84M165 66h84M69 132v-22h236" />
            </g>
            <path d="M74 116h84l17-24h62v24z" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="1.4" />
            <path d="M96 92h118v24H96z" fill="var(--art-warm)" opacity=".9" />
            <g fill="var(--art-cool)">
              <rect x="48" y="108" width="14" height="8" />
              <rect x="247" y="40" width="21" height="8" />
              <circle cx="234" cy="124" r="4" />
            </g>
          </svg>
          <svg v-else-if="index === 1" viewBox="0 0 320 150" aria-hidden="true" focusable="false">
            <g fill="none" stroke="var(--art-ink)" stroke-width="1.1" opacity=".5">
              <path d="M20 28h280M20 50h280M20 72h280M20 94h280M20 116h280M20 138h280" stroke-dasharray="1 7" />
              <path d="M48 40v92m32-92v92m32-92v92m32-92v92m32-92v92m32-92v92m32-92v92m32-92v92" />
            </g>
            <g transform="rotate(-7 160 75)">
              <rect x="82" y="26" width="142" height="96" fill="var(--art-paper)" stroke="var(--art-ink)" stroke-width="1.4" />
              <path d="M98 46h110M98 62h84M98 78h96M98 94h70" stroke="var(--art-warm)" stroke-width="2" />
              <path d="M98 46h110M98 62h84M98 78h96M98 94h70" stroke="var(--art-ink)" stroke-width=".5" opacity=".45" />
            </g>
            <g transform="rotate(8 232 96)">
              <rect x="196" y="58" width="66" height="84" fill="var(--art-warm)" stroke="var(--art-ink)" stroke-width="1.3" />
              <path d="M208 76h42M208 90h30M208 104h38" stroke="var(--art-ink)" stroke-width="1" opacity=".55" />
            </g>
            <circle cx="57" cy="114" r="5" fill="var(--art-cool)" />
          </svg>
          <svg v-else viewBox="0 0 320 150" aria-hidden="true" focusable="false">
            <g fill="none" stroke="var(--art-ink)" stroke-width="1.2" opacity=".55">
              <ellipse cx="166" cy="78" rx="104" ry="54" transform="rotate(-18 166 78)" />
              <ellipse cx="166" cy="78" rx="112" ry="62" transform="rotate(19 166 78)" />
              <path d="M28 132h264M74 132V38h172v94" />
            </g>
            <circle cx="163" cy="72" r="39" fill="var(--art-warm)" stroke="var(--art-ink)" stroke-width="1.4" />
            <path d="M89 128c19-38 49-29 71-49 20-18 23-43 38-64-8 30-9 56-31 72-23 18-60 19-70 41z" fill="var(--art-ink)" opacity=".82" />
            <path d="M164 82c-18-24-37-29-58-20 23 1 32 16 44 30m26-27c2-18-8-30-21-42-4 19 5 32 16 50m-3 7c30-1 49-11 59-26-26 3-44 10-56 20" fill="var(--art-paper)" opacity=".9" />
            <g fill="var(--art-cool)">
              <circle cx="245" cy="39" r="4" />
              <rect x="58" y="53" width="12" height="12" />
            </g>
          </svg>
        </span>

        <span class="shelf-cover-foot">
          <span>
            <span class="shelf-cover-title">{{ folder.title }}</span>
            <span class="shelf-cover-count">{{ folder.count }} 条书签</span>
          </span>
          <span class="shelf-cover-arrow" aria-hidden="true">→</span>
        </span>
      </button>
    </nav>

    <details v-if="catalog.folders.length" class="shelf-directory">
      <summary>
        <span>全部文件夹</span>
        <span class="shelf-directory-count">{{ catalog.folders.length }}</span>
      </summary>
      <ul>
        <li v-for="folder in catalog.folders" :key="folder.id">
          <button
            :id="`shelf-folder-${folder.id}`"
            class="shelf-folder"
            :class="{ 'is-root': folder.isRoot, 'is-current': scopeId === folder.id }"
            type="button"
            :style="{ '--depth': String(folder.depth) }"
            :aria-pressed="scopeId === folder.id"
            :aria-label="`${folder.pathLabel}，${folder.count} 条书签`"
            :data-folder-id="folder.id"
            @click="enterTopic(folder.id)"
          >
            <svg class="shelf-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3.5 7a1 1 0 0 1 1-1H10l2 2h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.5" />
            </svg>
            <span class="shelf-folder-name">{{ folder.title }}</span>
            <span v-if="folder.isRoot" class="shelf-folder-root">根</span>
            <span class="shelf-folder-count">{{ folder.count }}</span>
          </button>
        </li>
      </ul>
    </details>

    <div class="shelf-results">
      <section class="shelf-list" aria-labelledby="shelf-list-title">
        <div class="shelf-list-head">
          <div class="shelf-heading-block">
            <h2 id="shelf-list-title" ref="listTitleEl" tabindex="-1">
              {{ listHeading }}
            </h2>
            <p v-if="scopeFolder" class="shelf-scope-path">
              {{ scopeFolder.pathLabel }}
            </p>
            <p v-else-if="tokens.length" class="shelf-scope-path">
              在全部书签中搜索
            </p>
          </div>
          <div class="shelf-head-actions">
            <output class="shelf-result-count" aria-live="polite">{{ visibleBookmarks.length }} 条书签</output>
            <button v-if="scopeId" class="shelf-scope-clear" type="button" @click="returnToShelf">
              返回书架
            </button>
          </div>
        </div>

        <p v-if="loadError && catalog.total" class="shelf-inline-error" role="alert">
          {{ loadError }}
          <button class="shelf-text-action" type="button" @click="loadShelf">
            重试
          </button>
        </p>

        <div v-if="loading && !catalog.total" class="shelf-status" role="status">
          正在读取书签…
        </div>
        <div v-else-if="loadError && !catalog.total" class="shelf-status" role="alert">
          <strong>读取书签失败</strong>
          <p>{{ loadError }}</p>
          <button class="button-secondary" type="button" @click="loadShelf">
            重试
          </button>
        </div>
        <div v-else-if="!catalog.bookmarks.length" class="shelf-status">
          <strong>还没有可浏览的书签</strong>
          <p>添加书签后，它们会按浏览器中的文件夹显示在这里。</p>
        </div>
        <div v-else-if="!visibleBookmarks.length" class="shelf-status">
          <strong>{{ emptyTitle }}</strong>
          <p v-if="query.trim()">
            试试更短的关键词，或清除搜索后浏览。
          </p>
          <p v-else>
            这个文件夹里还没有书签，可以切换到其他主题。
          </p>
          <div class="shelf-status-actions">
            <button v-if="query" class="shelf-text-action" type="button" @click="clearQuery">
              清除搜索
            </button>
            <button v-if="scopeId" class="shelf-text-action" type="button" @click="clearScope(true)">
              搜索全部书签
            </button>
          </div>
        </div>

        <ul v-else id="shelf-rows" class="shelf-rows">
          <li
            v-for="bookmark in shownBookmarks"
            :id="`shelf-row-${bookmark.id}`"
            :key="bookmark.id"
            class="shelf-row"
            :class="{ 'is-active': activeId === bookmark.id }"
            :aria-current="activeId === bookmark.id ? 'true' : undefined"
            :data-bookmark-id="bookmark.id"
          >
            <div class="shelf-row-body">
              <a
                v-if="bookmark.href"
                class="shelf-row-title"
                :href="bookmark.href"
                target="_blank"
                rel="noopener noreferrer"
                @focus="activate(bookmark.id)"
              >{{ displayTitle(bookmark) }}</a>
              <span v-else class="shelf-row-title">{{ displayTitle(bookmark) }}</span>
              <span class="shelf-row-domain">{{ domainLabel(bookmark) }}</span>
              <span v-if="!scopeFolder" class="shelf-row-path">{{ bookmark.pathLabel }}</span>
            </div>
            <button
              class="shelf-row-detail"
              type="button"
              data-detail-trigger
              :aria-expanded="selectedId === bookmark.id"
              @click="openDetails(bookmark, $event)"
            >
              详情
            </button>

            <div v-if="!wide && selectedId === bookmark.id" class="shelf-inline-detail">
              <BookmarkDetails :bookmark="bookmark" @close="closeDetails" />
            </div>
          </li>
        </ul>
        <button v-if="shown < visibleBookmarks.length" class="button-secondary shelf-more" type="button" @click="shown += 100">
          显示更多书签
        </button>
      </section>

      <aside v-if="wide" class="shelf-detail-aside" aria-label="书签详情">
        <BookmarkDetails v-if="selectedBookmark" :bookmark="selectedBookmark" @close="closeDetails" />
        <div v-else class="shelf-detail-empty">
          <span class="shelf-mono">书签详情</span>
          <p>选择一条书签查看完整地址与文件夹路径。</p>
        </div>
      </aside>
    </div>
  </section>
</template>
