// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import BookmarkShelf from '../sidepanel/BookmarkShelf.vue'
import type { RawBookmarkNode } from '../sidepanel/shelf-catalog'

interface FakeEvent {
  addListener: (listener: () => void) => void
  removeListener: (listener: () => void) => void
  fire: () => void
}

interface Events {
  onCreated: FakeEvent
  onChanged: FakeEvent
  onMoved: FakeEvent
  onRemoved: FakeEvent
  onChildrenReordered: FakeEvent
  onImportBegan: FakeEvent
  onImportEnded: FakeEvent
}

function createEvent(): FakeEvent {
  const listeners = new Set<() => void>()
  return {
    addListener: vi.fn((listener: () => void) => { listeners.add(listener) }),
    removeListener: vi.fn((listener: () => void) => { listeners.delete(listener) }),
    fire() {
      for (const listener of [...listeners])
        listener()
    },
  }
}

function createEvents(): Events {
  return {
    onCreated: createEvent(),
    onChanged: createEvent(),
    onMoved: createEvent(),
    onRemoved: createEvent(),
    onChildrenReordered: createEvent(),
    onImportBegan: createEvent(),
    onImportEnded: createEvent(),
  }
}

/** 合成书签树：设计下含嵌套文件夹，书签栏还直接放着一个小书签。 */
function makeTree(withDates = true): RawBookmarkNode[] {
  const dated = (value: number) => (withDates ? { dateAdded: value } : {})
  return [{
    id: '0',
    title: '',
    children: [
      {
        id: '1',
        title: '书签栏',
        children: [
          {
            id: '10',
            title: '设计',
            children: [
              { id: '100', title: 'Figma', url: 'https://www.figma.com/file/1', ...dated(1000) },
              {
                id: '101',
                title: '规范',
                children: [
                  { id: '1010', title: 'Type Scale', url: 'https://typescale.example/', ...dated(4000) },
                ],
              },
            ],
          },
          {
            id: '11',
            title: '开发',
            children: [
              { id: '110', title: 'MDN', url: 'https://developer.mozilla.org/en-US/', ...dated(3000) },
            ],
          },
          { id: '12', title: '空目录', children: [] },
          { id: '13', title: '小书签', url: 'javascript:alert(1)', ...dated(5000) },
        ],
      },
      {
        id: '2',
        title: '其他书签',
        children: [
          {
            id: '20',
            title: '阅读',
            children: [
              { id: '200', title: 'Article', url: 'https://example.com/article?utm=1', ...dated(6000) },
            ],
          },
        ],
      },
    ],
  }]
}

let tree: RawBookmarkNode[]
let events: Events
let getTree: Mock

function mountShelf(active = true) {
  return mount(BookmarkShelf, { props: { active }, attachTo: document.body })
}

beforeEach(() => {
  tree = makeTree()
  events = createEvents()
  getTree = vi.fn(async () => tree)
  vi.stubGlobal('chrome', {
    bookmarks: {
      getTree,
      ...events,
    },
  })
  history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('主题书架', () => {
  it('按真实后代计数展示前三文件夹、完整目录和可靠的最近收录', async () => {
    const wrapper = mountShelf()
    await flushPromises()
    try {
      const covers = wrapper.findAll('.shelf-cover')
      expect(covers.map(cover => cover.find('.shelf-cover-title').text())).toEqual(['设计', '开发', '阅读'])
      expect(covers.map(cover => cover.find('.shelf-cover-count').text())).toEqual(['2 条书签', '1 条书签', '1 条书签'])
      expect(wrapper.find('.shelf-folio strong').text()).toBe('5')
      expect(wrapper.find('.shelf-list-head h2').text()).toBe('最近收录')
      expect(wrapper.findAll('.shelf-row-title').map(title => title.text())[0]).toBe('Article')

      // 根目录、嵌套文件夹和空文件夹都在紧凑目录中，计数包含后代。
      expect(wrapper.find('[data-folder-id="1"] .shelf-folder-count').text()).toBe('4')
      expect(wrapper.find('[data-folder-id="10"] .shelf-folder-count').text()).toBe('2')
      expect(wrapper.find('[data-folder-id="101"] .shelf-folder-count').text()).toBe('1')
      expect(wrapper.find('[data-folder-id="2"] .shelf-folder-count').text()).toBe('1')
      expect(wrapper.find('[data-folder-id="12"]').exists()).toBe(true)
    }
    finally {
      wrapper.unmount()
    }
  })

  it('在主题内搜索并可清除查询、清除范围或切换为搜索全部书签', async () => {
    history.replaceState(null, '', '/sidepanel.html?keep=1#top')
    const wrapper = mountShelf()
    await flushPromises()
    try {
      const input = wrapper.find('#shelf-search-input')
      await input.setValue('type scale')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(1)
      expect(wrapper.text()).toContain('Type Scale')
      let params = new URLSearchParams(location.search)
      expect(params.get('q')).toBe('type scale')
      expect(params.get('keep')).toBe('1')
      expect(location.hash).toBe('#top')

      await input.setValue('developer.mozilla')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(1)
      expect(wrapper.text()).toContain('MDN')

      await wrapper.find('.shelf-clear').trigger('click')
      await flushPromises()
      expect((input.element as HTMLInputElement).value).toBe('')
      expect(document.activeElement).toBe(input.element)
      expect(new URLSearchParams(location.search).get('q')).toBeNull()

      await wrapper.find('[data-topic-id="10"]').trigger('click')
      await flushPromises()
      expect(new URLSearchParams(location.search).get('topic')).toBe('10')
      expect(wrapper.find('.shelf-scope-path').text()).toContain('书签栏 / 设计')
      expect(wrapper.find('#shelf-search-input').attributes('placeholder')).toContain('设计')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(2)

      await wrapper.find('#shelf-search-input').setValue('figma')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(1)
      await wrapper.find('.shelf-clear').trigger('click')
      await flushPromises()
      expect(new URLSearchParams(location.search).get('topic')).toBe('10')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(2)

      await wrapper.find('#shelf-search-input').setValue('mdn')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(0)
      const searchAll = wrapper.findAll('.shelf-status button').find(button => button.text().includes('搜索全部书签'))
      expect(searchAll).toBeTruthy()
      await searchAll!.trigger('click')
      await flushPromises()
      params = new URLSearchParams(location.search)
      expect(params.get('topic')).toBeNull()
      expect(params.get('q')).toBe('mdn')
      expect(wrapper.findAll('.shelf-row')).toHaveLength(1)
      expect(wrapper.text()).toContain('MDN')
    }
    finally {
      wrapper.unmount()
    }
  })

  it('日期不完整时保持浏览器树顺序，不宣称最近收录', async () => {
    tree = makeTree(false)
    const wrapper = mountShelf()
    await flushPromises()
    try {
      expect(wrapper.find('.shelf-list-head h2').text()).toBe('全部书签')
      expect(wrapper.findAll('.shelf-row-title').map(title => title.text())).toEqual([
        'Figma',
        'Type Scale',
        'MDN',
        '小书签',
        'Article',
      ])
    }
    finally {
      wrapper.unmount()
    }
  })

  it('合并外部书签变更事件刷新计数，并在卸载时清理监听', async () => {
    vi.useFakeTimers()
    const wrapper = mountShelf()
    await flushPromises()
    try {
      expect(getTree).toHaveBeenCalledTimes(1)
      const updated = makeTree()
      updated[0].children![0].children![1].children!.push({
        id: '120',
        title: 'Vite',
        url: 'https://vite.dev/guide/',
        dateAdded: 7000,
      })
      tree = updated
      events.onCreated.fire()
      events.onMoved.fire()
      expect(getTree).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(200)
      await flushPromises()
      expect(getTree).toHaveBeenCalledTimes(2)
      expect(wrapper.findAll('.shelf-row')).toHaveLength(6)
      expect(wrapper.find('[data-folder-id="11"] .shelf-folder-count').text()).toBe('2')
      expect(wrapper.find('[data-topic-id="11"] .shelf-cover-count').text()).toBe('2 条书签')
    }
    finally {
      wrapper.unmount()
    }
    expect(events.onCreated.removeListener).toHaveBeenCalled()
  })

  it('打开详情后可用键盘收起并回到触发按钮，不可安全打开的地址只读展示', async () => {
    const wrapper = mountShelf()
    await flushPromises()
    try {
      await wrapper.find('#shelf-search-input').setValue('小书签')
      await flushPromises()
      const row = wrapper.find('[data-bookmark-id="13"]')
      expect(row.find('a').exists()).toBe(false)
      expect(wrapper.findAll('a').every(link => !String(link.attributes('href') ?? '').toLowerCase().startsWith('javascript:'))).toBe(true)

      const trigger = row.find('[data-detail-trigger]')
      await trigger.trigger('click')
      await flushPromises()
      const detail = row.find('.shelf-inline-detail')
      expect(detail.exists()).toBe(true)
      expect(detail.find('.shelf-detail-url').text()).toBe('javascript:alert(1)')
      expect(detail.text()).toContain('不能直接打开')

      await detail.find('.shelf-detail-panel').trigger('keydown', { key: 'Escape' })
      await flushPromises()
      expect(row.find('.shelf-inline-detail').exists()).toBe(false)
      expect(document.activeElement).toBe(trigger.element)
    }
    finally {
      wrapper.unmount()
    }
  })

  it('方向键选中结果，回车只通过 noopener 打开安全链接', async () => {
    const wrapper = mountShelf()
    await flushPromises()
    try {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null)
      const input = wrapper.find('#shelf-search-input')
      await input.setValue('MDN')
      await flushPromises()
      await input.trigger('keydown', { key: 'ArrowDown' })
      expect(wrapper.find('.shelf-row.is-active').text()).toContain('MDN')
      await input.trigger('keydown', { key: 'Enter' })
      expect(open).toHaveBeenCalledWith('https://developer.mozilla.org/en-US/', '_blank', 'noopener,noreferrer')
    }
    finally {
      wrapper.unmount()
    }
  })

  it('返回书架时清除主题和查询，恢复滚动位置并让焦点回到原封面', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    Object.defineProperty(window, 'scrollY', { value: 240, configurable: true })
    const wrapper = mountShelf()
    await flushPromises()
    try {
      const cover = wrapper.find('[data-topic-id="10"]')
      if (cover.element instanceof HTMLElement)
        cover.element.focus()
      await cover.trigger('click')
      await flushPromises()
      expect(wrapper.find('.shelf-list-head h2').text()).toBe('设计')

      // defineExpose 的公开契约不在组件实例的静态类型里。
      const exposed = wrapper.vm as unknown as { returnToShelf: () => Promise<void> }
      await exposed.returnToShelf()
      await flushPromises()
      expect(new URLSearchParams(location.search).get('topic')).toBeNull()
      expect(wrapper.find('.shelf-list-head h2').text()).toBe('最近收录')
      expect(scrollTo).toHaveBeenCalledWith(0, 240)
      expect(document.activeElement).toBe(cover.element)
    }
    finally {
      wrapper.unmount()
    }
  })

  it('仅在激活时响应搜索快捷键', async () => {
    const wrapper = mountShelf(false)
    await flushPromises()
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
      expect(document.activeElement).not.toBe(wrapper.find('#shelf-search-input').element)

      await wrapper.setProps({ active: true })
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
      expect(document.activeElement).toBe(wrapper.find('#shelf-search-input').element)
    }
    finally {
      wrapper.unmount()
    }
  })
})
