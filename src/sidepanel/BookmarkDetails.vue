<script setup lang="ts">
import { computed } from 'vue'
import type { ShelfBookmark } from './shelf-catalog'

const props = defineProps<{ bookmark: ShelfBookmark }>()
const emit = defineEmits<{ close: [] }>()
const added = computed(() => props.bookmark.dateAdded
  ? new Date(props.bookmark.dateAdded).toLocaleDateString('zh-CN')
  : '')
</script>

<template>
  <div class="shelf-detail-panel" tabindex="-1" @keydown.esc.stop.prevent="emit('close')">
    <div class="shelf-detail-label">
      <span class="shelf-mono">书签详情</span>
      <button class="shelf-detail-close" type="button" @click="emit('close')">
        收起
      </button>
    </div>
    <div class="shelf-detail-body">
      <h3>{{ bookmark.title || bookmark.url || '未命名书签' }}</h3>
      <p v-if="bookmark.domain" class="shelf-detail-domain">
        {{ bookmark.domain }}
      </p>
      <p class="shelf-detail-path">
        {{ bookmark.pathLabel }}
      </p>
      <p v-if="added" class="shelf-detail-date">
        添加于 {{ added }}
      </p>
      <p class="shelf-detail-url">
        {{ bookmark.url || '无地址' }}
      </p>
      <div class="shelf-detail-actions">
        <a v-if="bookmark.href" class="button-secondary" :href="bookmark.href" target="_blank" rel="noopener noreferrer">打开网页 <span aria-hidden="true">↗</span></a>
        <p v-else class="shelf-detail-warning">
          此地址不能直接打开；仍可查看上方完整 URL。
        </p>
      </div>
    </div>
  </div>
</template>
