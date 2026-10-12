import type { Fingerprint } from './plan'
/** 书签树中的一个可分类条目（与浏览器 API 解耦的最小视图）。 */
export interface BookmarkView {
  id: string
  parentId: string
  title: string
  /** 文件夹没有 url；书签一定有。 */
  url?: string
  /** 父文件夹内的位置，从 0 开始。 */
  index: number
}

/** 只读书签树适配器；实现方负责隔离浏览器书签 API。 */
export interface BookmarkTree {
  /** 支持整理的根文件夹（书签栏、其他书签）。 */
  roots: () => Promise<BookmarkView[]>
  /** 某文件夹的直接子节点，顺序与浏览器一致。 */
  children: (parentId: string) => Promise<BookmarkView[]>
  get: (id: string) => Promise<BookmarkView | null>
  /** 分类范围内（含直接子节点）的全部节点。 */
  subtree: (rootId: string) => Promise<BookmarkView[]>
  /** 浏览器实时读取的范围指纹，用于执行前与预览比对。 */
  liveFingerprint: (rootId: string) => Promise<Fingerprint>
  createFolder: (parentId: string, title: string) => Promise<BookmarkView>
  move: (id: string, parentId: string, index?: number) => Promise<void>
  renameFolder: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

/** 模型客户端；生产实现直连用户配置的 OpenAI-compatible 服务。 */
export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface ModelClient {
  complete: (messages: ChatMessage[]) => Promise<string>
}

/** 用户配置。 */
export interface ApiConfig {
  apiKey: string
  baseUrl: string
  model: string
  /** 分类数量上限，3–15。 */
  categoryLimit: number
}

/** 发送给模型的书签条目（唯一允许披露的字段）。 */
export interface PromptBookmark {
  id: string
  title: string
  path: string
}

/** 一次分类使用的输入快照。 */
export interface ScopeSnapshot {
  rootId: string
  rootTitle: string
  /** 分类范围内的全部节点。 */
  nodes: BookmarkView[]
  /** 可分类书签，按遍历顺序。 */
  bookmarks: BookmarkView[]
  /** 无法分类的书签节点。 */
  unclassifiable: BookmarkView[]
  /** 冻结分类方案时使用的上限。 */
  effectiveLimit: number
}

/** 分类方案中的一个一级分类。 */
export interface Category {
  id: string
  name: string
}

export type Decision
  = { bookmarkId: string, kind: 'assign', categoryId: string }
    | { bookmarkId: string, kind: 'pending' }

/** 预览中的一条裁决行（含用户改名/删除后的展示状态）。 */
export interface PreviewRow {
  bookmarkId: string
  /** 原始 URL，仅用于撤销校验，不渲染、不持久化到界面状态之外。 */
  url: string
  /** 脱敏后的展示用 URL。 */
  displayUrl: string
  title: string
  categoryId: string | null
}

export interface PreviewCounts {
  total: number
  moving: number
  unchanged: number
  pending: number
  unclassifiable: number
  categories: number
}

export interface Preview {
  rootId: string
  categories: Category[]
  rows: PreviewRow[]
  /** 预览对应的书签指纹：成员、父节点、标题、URL、原索引。 */
  fingerprint: Fingerprint
  counts: PreviewCounts
  /** 阻断确认的预览级错误（重复分类名等）。 */
  blocking: string[]
}

export interface TreeChange {
  nodeId: string
  kind: 'moved' | 'created'
  fromParent: string | null
  toParent: string
  /** 落地后在目标父文件夹内的索引。 */
  toIndex: number
}

export interface UndoRecord {
  createdAt: number
  rootId: string
  categories: Category[]
  entries: Array<{
    bookmarkId: string
    fromParent: string
    toParent: string
    /** 整理前在原父文件夹内的索引。 */
    fromIndex: number
    /** 整理后在目标父文件夹内的索引，用于检测用户后续排序。 */
    toIndex: number
    title: string
    url: string
  }>
  /** 本次操作创建的分类文件夹。 */
  createdFolders: CreatedFolder[]
  changes: TreeChange[]
}

export type UndoStatus
  = { state: 'available' }
    | { state: 'disabled', reasons: string[] }
    | { state: 'none' }

export interface OperationResult {
  moved: number
  unchanged: number
  pending: number
  unclassifiable: number
  createdFolders: CreatedFolder[]
  targets: string[]
  undo: UndoStatus
  changes: TreeChange[]
  /** 失败或部分完成时存在，供用户显式触发恢复。 */
  recovery: RecoveryState | null
  /** 失败或部分完成的原因；成功时为 null。 */
  error: string | null
}

/** 本次操作创建的分类文件夹；名称与 id 一起记录，避免位置对齐出错。 */
export interface CreatedFolder {
  id: string
  name: string
}

export interface PendingMove {
  bookmarkId: string
  toParent: string
  /** 恢复时应当回到的父文件夹。 */
  fromParent: string
  /** 恢复时应当回到的父文件夹内索引。 */
  fromIndex: number
}

/** 中断的执行现场：已完成部分移动，等待用户显式恢复。 */
export interface RecoveryState {
  rootId: string
  createdAt: number
  /** 本次创建、可供清理的分类文件夹。 */
  createdFolders: CreatedFolder[]
  /** 已经落地的移动，恢复时按 fromParent 放回。 */
  completed: PendingMove[]
  /** 尚未执行的移动，仅用于报告。 */
  remaining: PendingMove[]
}

export interface RecoveryReport {
  restored: number
  conflicts: string[]
  removedFolders: string[]
}

export type OperationStage = 'summarize' | 'plan' | 'classify'

export interface Progress {
  stage: OperationStage
  done: number
  total: number
  retries: number
  message: string
}
