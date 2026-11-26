<script setup lang="ts">
defineProps<{ caption: string }>()
</script>

<template>
  <div class="brand-lockup">
    <span class="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5">
        <path d="M4 5.5c3.3-.7 5.9 0 8 2 2.1-2 4.7-2.7 8-2v12c-3.3-.7-5.9 0-8 2-2.1-2-4.7-2.7-8-2zM12 7.5v12M7 10l2 .5m6 0 2-.5" />
      </svg>
    </span>
    <div>
      <p class="brand-name">
        拾页
      </p>
      <p class="brand-caption" lang="en">
        PAGEKEEP / {{ caption }}
      </p>
    </div>
  </div>
</template>
