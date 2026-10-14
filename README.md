# 智能书签分类（better-bookmark）

Chrome/Edge Manifest V3 扩展：选择一个书签根目录，用你自己配置的 OpenAI-compatible 模型生成一级分类建议，先看完整预览再执行移动，最近一次整理可撤销。产品规格见 `docs/specs/ai-bookmark-classification.md`。

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

1. 打开扩展设置页，填写 API Key、Base URL（不含 `/chat/completions`）与模型名称；非本机地址必须使用 HTTPS。
2. “测试连接”发送一条固定消息，不含任何书签数据。
3. 在侧边栏确认隐私说明（Base URL 或模型变化后需重新确认），选择整理范围与分类数量上限。
4. 生成预览后可筛选、改名、批量改派或删除拟建分类；确认后才会创建文件夹并移动书签。
5. 执行失败会停止后续移动并给出恢复入口；成功后可“撤销上次整理”。
6. “导出备份”把书签栏与其他书签的完整结构写成 JSON 文件；“选择备份文件”校验后确认导入，只新增节点并追加在同名根目录末尾，不删除现有书签；URL 原样恢复，书签小工具等非 HTTP(S) 地址会在摘要里提示数量。

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
- `src/sidepanel/`：侧边栏界面；`src/options/`：模型配置页。
- `docs/adr/`：架构决策；`CONTEXT.md`：领域术语。
