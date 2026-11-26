# 拾页 · 主题书架（better-bookmark）

Chrome/Edge Manifest V3 扩展。用主题书架浏览浏览器文件夹，在本机搜索书签；需要整理时，用自己配置的 OpenAI-compatible 模型生成最多三层的分类预览，确认后移动。分类规格见 `docs/specs/ai-bookmark-classification.md`，界面以 `DESIGN.md` 和 `design/bookmark-atlas/topic-shelf.html` 为准。

## 开发

```bash
npm install
npm run build        # 清理后生成 extension/manifest.json 与 extension/dist
npm run typecheck
npm test
npm run lint
```

在 Chrome/Edge 打开 `chrome://extensions`，启用开发者模式，选择“加载已解压的扩展程序”并指向 `extension/`。
`npm run dev` 以 watch 模式重建前端产物（后台脚本需手动重跑 `npm run build:background`）。

## 使用

1. 点击扩展图标打开「主题书架」。封面和目录读取真实的浏览器文件夹；搜索匹配标题、域名和文件夹路径，不需要配置模型。`⌘ K` / `Ctrl K` 聚焦搜索，方向键选中结果，回车打开网页。
2. 点击「智能分类」进入整理工作区。配置 API Key、Base URL（不含 `/chat/completions`）和模型名称；非本机地址必须使用 HTTPS。「测试连接」只发送固定消息，不发送任何书签。
3. 单独选择分类范围，填写可选整理要求和每层分类数量上限，确认隐私说明后生成预览。Base URL 或模型变化时须重新确认；模型已配置与测试连接成功分别显示。
4. 审阅多层分类树。支持筛选、改名、批量改派和移除分类节点。移除节点会同时移除拟建子树，相关书签改为待确认并保留原位置。筛选不影响最终执行范围，确认前不创建文件夹或移动书签。
5. 部分移动失败会停止后续写入，并提供恢复入口；成功后可在「最近一次整理」里撤销。相关节点发生外部改动时不会强制撤销。
6. 「备份与导入」可把书签栏和其他书签的完整结构下载为 JSON，包含原始 URL。导入先校验和预览，确认后只追加，非 HTTP(S) 项会在摘要中单独提示。清除本地配置与整理记录需确认，不删除浏览器书签。

## 权限与隐私

- 安装时只申请书签、本地存储与侧边栏权限，不申请 `<all_urls>`。
- 模型请求由侧边栏直接发出，因此会在你点击“测试连接”或“开始分类”时，按需申请**仅你所配置的那个源**的主机权限（`optional_host_permissions`）；拒绝即无法调用模型。
- 只发送书签标题、脱敏 HTTP(S) URL 与相对文件夹路径；query、凭据与 fragment 不会离开浏览器，也不抓取网页正文。
- API Key、隐私确认与撤销记录只存在 `storage.local`，不同步、不上报；控制台不打印密钥、请求体、响应体或书签元数据。
- 备份文件由侧边栏直接下载到本地，不经过任何服务；文件包含完整 URL（含 query 与 fragment），请自行保管。

## 结构

- `src/core/`：与浏览器 API 解耦的分类领域逻辑（快照、方案、预览、执行、恢复、撤销）。
- `src/core/browser-tree.ts`：书签 API 适配器；`src/__tests__/memory-tree.ts` 为对应的内存实现。
- `src/core/backup.ts`：备份导出与导入；导入只追加，不删除任何现有书签。
- `src/sidepanel/`：主题书架、本地搜索、智能分类与维护工作区；`src/options/`：模型设置；`src/ui.css`：共用视觉令牌与控件。
- `docs/adr/`：架构决策；`CONTEXT.md`：领域术语。
