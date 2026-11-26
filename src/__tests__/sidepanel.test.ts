// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { Preview } from '../core/types'
import { buildPreview, buildSnapshot } from '../core/plan'
import OrganizeWorkspace from '../sidepanel/OrganizeWorkspace.vue'

const { classify, execute, OperationError, StalePreviewError } = vi.hoisted(() => {
  class OperationError extends Error {}
  class StalePreviewError extends OperationError {}
  return { classify: vi.fn(), execute: vi.fn(), OperationError, StalePreviewError }
})
vi.mock('../core/classifier', () => ({
  OperationError,
  StalePreviewError,
  createOrchestrator: () => ({ classify, execute, cancel: vi.fn(), blockingOf: () => [], checkUndo: async () => ({ state: 'none' }) }),
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
  execute.mockReset()
  const snapshot = buildSnapshot({ rootId: '1', rootTitle: '书签栏', categoryLimit: 8, nodes: [
    { id: '10', parentId: '1', title: 'MDN', url: 'https://developer.mozilla.org/', index: 0 },
    { id: '11', parentId: '1', title: 'Vue', url: 'https://vuejs.org/', index: 1 },
    { id: '12', parentId: '1', title: '小书签', url: 'javascript:alert(1)', index: 2 },
  ] })
  const result = buildPreview({
    snapshot,
    categories: [{
      id: 'c1',
      name: '开发工具',
      parentId: null,
      children: [{ id: 'c2', name: '前端', parentId: 'c1', children: [] }],
    }],
    decisions: [
      { bookmarkId: '10', kind: 'assign', categoryId: 'c1' },
      { bookmarkId: '11', kind: 'assign', categoryId: 'c2' },
    ],
  })
  if (!result.ok)
    throw new Error(result.error)
  classify.mockResolvedValue({ preview: result.preview as Preview, ignoredRequirements: [], skipped: false })
})

async function showPreview(wrapper: VueWrapper) {
  await flushPromises()
  await wrapper.find('.privacy-note button').trigger('click')
  await wrapper.find('.primary-actions .button-primary').trigger('click')
  await flushPromises()
}

it('生成预览后聚焦审阅，渲染可折叠的嵌套分类树，并在切换入口时保留筛选与改派状态', async () => {
  const wrapper = mount(OrganizeWorkspace, { props: { active: true }, attachTo: document.body })
  try {
    await showPreview(wrapper)
    expect(wrapper.find('.setup-panel').attributes('open')).toBeUndefined()
    expect(document.activeElement).toBe(wrapper.find('.preview-panel').element)

    // 顶层只有一个分类：子分类真实嵌套，折叠父节点会一并收起子树。
    const roots = wrapper.findAll('.category-list > .category-group:not(.is-pending):not(.is-unclassifiable)')
    expect(roots).toHaveLength(1)
    const nested = roots[0].find('.category-children > .category-group')
    expect(nested.exists()).toBe(true)
    expect(nested.find('.category-path').text()).toBe('开发工具 / 前端')
    expect(roots[0].element.querySelector('.category-children > .category-group')).not.toBeNull()
    expect(wrapper.findAll('.bookmark-status.is-moving')).toHaveLength(2)
    expect(wrapper.find('.category-group.is-unclassifiable').text()).toContain('小书签')
    expect(wrapper.find('.category-group.is-unclassifiable .bookmark-status').text()).toBe('无法分类')

    await wrapper.find('.bookmark-list input').setValue(true)
    const target = wrapper.find('.selection-bar select')
    expect((target.element as HTMLSelectElement).value).toBe('__choose__')
    await target.setValue('')
    expect(wrapper.find('.execute-button').text()).toContain('1 个书签')
    expect(wrapper.findAll('.category-name').some(el => el.text() === '待确认')).toBe(true)
    expect(wrapper.find('.category-group.is-pending').exists()).toBe(true)

    await wrapper.find('.search-control').setValue('Vue')
    expect(location.search).toBe('?filter=Vue')
    await wrapper.setProps({ active: false })
    await wrapper.setProps({ active: true })
    await flushPromises()
    expect(wrapper.find('.preview-panel').exists()).toBe(true)
    expect((wrapper.find('.search-control').element as HTMLInputElement).value).toBe('Vue')
    expect(wrapper.find('.execute-button').text()).toContain('1 个书签')

    await wrapper.find('.search-control').setValue('no-match')
    expect(location.search).toBe('?filter=no-match')
    await wrapper.find('.empty-filter button').trigger('click')
    await flushPromises()
    expect(location.search).toBe('')
    expect(wrapper.find('.empty-filter').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.find('.search-control').element)
  }
  finally {
    wrapper.unmount()
  }
})

it('执行遇到明确的过期错误时作废预览并要求重新生成', async () => {
  const wrapper = mount(OrganizeWorkspace, { props: { active: true }, attachTo: document.body })
  try {
    await showPreview(wrapper)
    execute.mockRejectedValueOnce(new StalePreviewError('书签在预览后发生了变化，请重新生成预览'))
    await wrapper.find('.execute-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.preview-panel').exists()).toBe(false)
    expect(wrapper.find('.notice-error').text()).toContain('重新生成预览')
  }
  finally {
    wrapper.unmount()
  }
})

it('部分失败后显示移动与未执行数量，并锁定再次执行直到恢复', async () => {
  const wrapper = mount(OrganizeWorkspace, { props: { active: true }, attachTo: document.body })
  try {
    await showPreview(wrapper)
    execute.mockResolvedValueOnce({
      moved: 1,
      unchanged: 0,
      pending: 0,
      unclassifiable: 1,
      createdFolders: [],
      targets: ['开发工具', '前端'],
      undo: { state: 'none' },
      changes: [],
      recovery: {
        rootId: '1',
        createdAt: Date.now(),
        createdFolders: [],
        completed: [{ bookmarkId: '10', toParent: 'c1', fromParent: '1', fromIndex: 0 }],
        remaining: [{ bookmarkId: '11', toParent: 'c2', fromParent: '1', fromIndex: 1 }],
      },
      error: '移动「Vue」失败，已停止后续移动',
    })
    await wrapper.find('.execute-button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.notice-error').text()).toContain('已移动 1 个，未执行 1 个')
    expect(wrapper.find('.recovery-panel').text()).toContain('恢复未完成的移动（1 个）')
    expect(wrapper.find('.execute-button').attributes('disabled')).toBeDefined()
  }
  finally {
    wrapper.unmount()
  }
})
