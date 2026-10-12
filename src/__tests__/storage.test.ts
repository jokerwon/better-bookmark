import { describe, expect, it, vi } from 'vitest'

/** 内存扩展存储替身：与浏览器一致，保存 JSON 可序列化的值。 */
const memory = new Map<string, unknown>()
vi.mock('webextension-polyfill', () => ({
  storage: {
    local: {
      get: async (key: string) => (memory.has(key) ? { [key]: memory.get(key) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items))
          memory.set(key, value)
      },
      remove: async (key: string) => {
        memory.delete(key)
      },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
}))

const { useWebExtensionStorage } = await import('~/composables/useWebExtensionStorage')
const { nextTick } = await import('vue')

describe('扩展本地存储', () => {
  it('以 null 为初值的对象能完整往返（撤销记录场景）', async () => {
    memory.clear()
    const record = { createdAt: 1, entries: [{ bookmarkId: 'b1', fromIndex: 0 }], createdFolders: [{ id: 'f1', name: '开发' }] }
    const state = useWebExtensionStorage<typeof record | null>('undo', null)
    state.value = record
    await nextTick()
    await nextTick()

    expect(memory.has('undo')).toBe(true)
    expect(memory.get('undo')).toBe(JSON.stringify(record))
    expect(JSON.parse(String(memory.get('undo')))).toEqual(record)
  })

  it('字符串与对象初值都按各自的 JSON 形式读写', async () => {
    memory.clear()
    const config = useWebExtensionStorage('config', { apiKey: '', categoryLimit: 8 })
    config.value = { apiKey: 'k', categoryLimit: 3 }
    await nextTick()
    await nextTick()
    expect(memory.get('config')).toBe(JSON.stringify({ apiKey: 'k', categoryLimit: 3 }))
  })
})
