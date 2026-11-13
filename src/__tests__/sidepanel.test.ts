// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Preview } from '../core/types'
import { buildPreview, buildSnapshot } from '../core/plan'
import Sidepanel from '../sidepanel/Sidepanel.vue'

const { classify } = vi.hoisted(() => ({ classify: vi.fn() }))
vi.mock('../core/classifier', () => ({
  OperationError: class extends Error {},
  createOrchestrator: () => ({ classify, cancel: vi.fn(), blockingOf: () => [], checkUndo: async () => ({ state: 'none' }) }),
}))
vi.mock('../core/browser-tree', () => ({ createBrowserTree: () => ({ roots: async () => [{ id: '1', title: '书签栏' }] }) }))
vi.mock('../core/permissions', () => ({ ensureHostPermission: async () => true }))
vi.mock('../composables/useWebExtensionStorage', () => ({
  useWebExtensionStorage: (key: string, fallback: unknown) => ref(key === 'config'
    ? { apiKey: 'local-test-key', baseUrl: 'http://localhost:9999/v1', model: 'local-test', categoryLimit: 8 }
    : fallback),
}))

beforeEach(() => {
  history.replaceState(null, '', '/')
  const snapshot = buildSnapshot({ rootId: '1', rootTitle: '书签栏', categoryLimit: 8, nodes: [
    { id: '10', parentId: '1', title: 'MDN', url: 'https://developer.mozilla.org/', index: 0 },
    { id: '11', parentId: '1', title: 'Vue', url: 'https://vuejs.org/', index: 1 },
  ] })
  const result = buildPreview({ snapshot, categories: [{ id: 'c1', name: '开发工具', parentId: null, children: [] }], decisions: [
    { bookmarkId: '10', kind: 'assign', categoryId: 'c1' },
    { bookmarkId: '11', kind: 'assign', categoryId: 'c1' },
  ] })
  if (!result.ok)
    throw new Error(result.error)
  classify.mockResolvedValue({ preview: result.preview as Preview, ignoredRequirements: [], skipped: false })
})

it('生成预览后聚焦审阅，允许把已分配书签主动改为待确认并清除无结果筛选', async () => {
  const wrapper = mount(Sidepanel, { attachTo: document.body })
  try {
    await flushPromises()
    await wrapper.find('.privacy-note button').trigger('click')
    await wrapper.find('.primary-actions .button-primary').trigger('click')
    await flushPromises()
    expect(wrapper.find('.setup-panel').attributes('open')).toBeUndefined()
    expect(document.activeElement).toBe(wrapper.find('.preview-panel').element)
    await wrapper.find('.bookmark-list input').setValue(true)
    const target = wrapper.find('.selection-bar select')
    expect((target.element as HTMLSelectElement).value).toBe('__choose__')
    await target.setValue('')
    expect(wrapper.find('.execute-button').text()).toContain('1 个书签')
    expect(wrapper.findAll('.category-name').some(el => el.text() === '待确认')).toBe(true)
    await wrapper.find('.search-control').setValue('no-match')
    expect(location.search).toBe('?filter=no-match')
    await wrapper.find('.empty-filter button').trigger('click')
    expect(location.search).toBe('')
    expect(wrapper.find('.empty-filter').exists()).toBe(false)
  }
  finally {
    wrapper.unmount()
  }
})
