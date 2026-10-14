import { describe, expect, it } from 'vitest'
import { MemoryTree } from './memory-tree'
import type { BackupFile } from '~/core/backup'
import { BACKUP_FORMAT, BACKUP_VERSION, buildBackup, importBackup, parseBackup } from '~/core/backup'

/** 书签栏（开发/A、B + C + 空目录）与其他书签。 */
function sample() {
  const memory = new MemoryTree()
  const bar = memory.addFolder('root', '书签栏')
  const other = memory.addFolder('root', '其他书签')
  const dev = memory.addFolder(bar, '开发')
  memory.addBookmark(dev, 'A', 'https://a.example.com/')
  memory.addBookmark(dev, 'B', 'https://b.example.com/')
  memory.addBookmark(bar, 'C', 'https://c.example.com/')
  memory.addFolder(bar, '空目录')
  return { memory, bar, other }
}

describe('书签备份与导入', () => {
  it('备份可以完整还原根目录下的结构与顺序', async () => {
    const { memory } = sample()
    const data = await buildBackup(memory.createTree())
    expect(data.format).toBe(BACKUP_FORMAT)

    const restored = new MemoryTree()
    const bar = restored.addFolder('root', '书签栏')
    const other = restored.addFolder('root', '其他书签')
    const report = await importBackup(data, restored.createTree(), other)

    // 根目录按标题匹配现有根，不新建，也不写进 fallback。
    expect(report.roots).toEqual(['书签栏', '其他书签'])
    expect(report.folders).toBe(2)
    expect(report.bookmarks).toBe(3)
    expect(report.conflicts).toEqual([])
    expect(restored.titlesOf(bar)).toEqual(['开发', 'C', '空目录'])
    expect(restored.titlesOf(other)).toEqual([])
    const dev = restored.idsOf(bar)[0]
    expect(restored.titlesOf(dev)).toEqual(['A', 'B'])
    expect(restored.urlsOf(dev)).toEqual(['https://a.example.com/', 'https://b.example.com/'])

    // 往返后的备份内容与原件一致（导出的时间戳除外）。
    expect((await buildBackup(restored.createTree())).roots).toEqual(data.roots)
  })

  it('导入追加在同名根目录末尾，不删除现有书签', async () => {
    const { memory } = sample()
    const data = await buildBackup(memory.createTree())

    const live = new MemoryTree()
    const bar = live.addFolder('root', '书签栏')
    live.addFolder('root', '其他书签')
    live.addBookmark(bar, '原有', 'https://keep.example.com/')
    await importBackup(data, live.createTree(), bar)

    expect(live.titlesOf(bar)[0]).toBe('原有')
    expect(live.urlsOf(bar)).toContain('https://keep.example.com/')
    expect(live.urlsOf(bar)).toContain('https://c.example.com/')
  })

  it('结构不合法的文件被拒绝，合法文件才被接受', async () => {
    const rejected = [
      '不是 JSON',
      '{}',
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, roots: [] }),
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, roots: [] }),
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, roots: [{ title: 'x', children: [{ title: 'y' }] }] }),
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, roots: [{ title: 'x', url: 'https://x.example.com/' }] }),
      JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, roots: [{ title: 'x', children: [{ title: 'y', url: 'https://y.example.com/', children: [] }] }] }),
    ]
    for (const text of rejected)
      expect(parseBackup(text).ok).toBe(false)

    const accepted = parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '2026-01-01T00:00:00.000Z',
      roots: [{ title: '书签栏', children: [{ title: 'X', url: 'https://x.example.com/' }, { title: '空目录', children: [] }] }],
    }))
    expect(accepted).toEqual({
      ok: true,
      value: {
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        exportedAt: '2026-01-01T00:00:00.000Z',
        roots: [{ title: '书签栏', children: [{ title: 'X', url: 'https://x.example.com/' }, { title: '空目录', children: [] }] }],
      },
    })
  })

  it('备份中的根目录在当前浏览器不存在时落到指定目录', async () => {
    const data: BackupFile = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '',
      roots: [{ title: '书签栏', children: [{ title: 'X', url: 'https://x.example.com/' }] }],
    }
    const live = new MemoryTree()
    const other = live.addFolder('root', '其他书签')
    const report = await importBackup(data, live.createTree(), other)

    // 报告实际落地的文件夹：备份里的「书签栏」在当前浏览器不存在，写进了「其他书签」。
    expect(report.roots).toEqual(['其他书签'])
    expect(report.bookmarks).toBe(1)
    expect(live.urlsOf(other)).toEqual(['https://x.example.com/'])
  })

  it('单个节点写入失败不中断其余节点，并记录冲突', async () => {
    const { memory } = sample()
    const data = await buildBackup(memory.createTree())

    const live = new MemoryTree()
    const bar = live.addFolder('root', '书签栏')
    live.addFolder('root', '其他书签')
    const tree = {
      ...live.createTree(),
      createBookmark: async () => {
        throw new Error('书签已存在')
      },
    }
    const report = await importBackup(data, tree, bar)

    expect(report.bookmarks).toBe(0)
    expect(report.conflicts.join()).toContain('A：书签已存在')
    // 文件夹仍然按备份内容建好，失败只影响单个节点。
    expect(live.titlesOf(bar)).toEqual(['开发', '空目录'])
  })

  it('父文件夹写入失败时整棵子树计入未写入数量', async () => {
    const { memory } = sample()
    const data = await buildBackup(memory.createTree())

    const live = new MemoryTree()
    const bar = live.addFolder('root', '书签栏')
    live.addFolder('root', '其他书签')
    const tree = {
      ...live.createTree(),
      createFolder: async () => {
        throw new Error('目录已存在')
      },
    }
    const report = await importBackup(data, tree, bar)

    expect(report.folders).toBe(0)
    // 「书签栏」下直接挂着的 C 仍然写入成功。
    expect(report.bookmarks).toBe(1)
    // 「开发」连同 A、B 一起跳过，「空目录」各自失败：共 4 个节点未写入。
    expect(report.skipped).toBe(4)
    expect(report.conflicts.join()).toContain('另有 2 个后代未导入')
  })

  it('非 HTTP(S) 书签原样还原：备份要能恢复用户自己的全部书签', async () => {
    const live = new MemoryTree()
    const bar = live.addFolder('root', '书签栏')
    live.addFolder('root', '其他书签')
    const report = await importBackup({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: '',
      roots: [{
        title: '书签栏',
        children: [
          { title: '书签小工具', url: 'javascript:alert(1)' },
          { title: '本地文件', url: 'file:///Users/me/notes.md' },
          { title: '正常', url: 'https://ok.example.com/' },
        ],
      }],
    }, live.createTree(), bar)

    expect(report.bookmarks).toBe(3)
    expect(report.skipped).toBe(0)
    expect(live.urlsOf(bar)).toEqual(['javascript:alert(1)', 'file:///Users/me/notes.md', 'https://ok.example.com/'])
  })

  it('超出体积或字段上限的文件在校验阶段就被拒绝', async () => {
    const huge = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      roots: [{ title: '书签栏', children: [{ title: 'x'.repeat(5000), url: 'https://x.example.com/' }] }],
    })
    expect(parseBackup(huge).ok).toBe(false)

    const longUrl = JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      roots: [{ title: '书签栏', children: [{ title: 'x', url: `https://x.example.com/${'a'.repeat(33_000)}` }] }],
    })
    expect(parseBackup(longUrl).ok).toBe(false)

    expect(parseBackup(JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      roots: [{ title: '书签栏', children: [] }],
    })).ok).toBe(true)
  })
})
