import type { Manifest } from 'webextension-polyfill'

export const dist = {
  options: 'dist/options/index.html',
  sidepanel: 'dist/sidepanel/index.html',
  background: 'dist/background/index.mjs',
}

export const ICON_PATHS: Record<number, string> = {
  16: 'assets/icon-512.png',
  32: 'assets/icon-512.png',
  48: 'assets/icon-512.png',
  128: 'assets/icon-512.png',
}

/** 只申请书签、本地存储与侧边栏权限；不申请 tabs、activeTab 或 <all_urls>。 */
export const PERMISSIONS = ['bookmarks', 'storage', 'sidePanel']

/** 可选主机权限：运行期只对用户配置的那一个模型源申请，安装时不授予任何主机权限。 */
export const OPTIONAL_HOST_PERMISSIONS = ['http://*/*', 'https://*/*']

export function defineManifest(): { manifest: Manifest.WebExtensionManifest, dist: typeof dist } {
  const manifest: Manifest.WebExtensionManifest = {
    manifest_version: 3,
    name: '拾页 · 主题书架',
    version: '0.1.0',
    description: '浏览和搜索本机书签。用自己的模型生成分类预览，确认后移动，最近一次整理可撤销。',
    icons: ICON_PATHS,
    permissions: PERMISSIONS,
    optional_host_permissions: OPTIONAL_HOST_PERMISSIONS,
    action: {
      default_title: '拾页 · 主题书架',
    },
    background: {
      service_worker: dist.background,
    },
    // side_panel 尚未进入 webextension-polyfill 的类型定义。
    side_panel: { default_path: dist.sidepanel },
    options_ui: {
      page: dist.options,
      open_in_tab: true,
    },
  } as Manifest.WebExtensionManifest & { side_panel: { default_path: string } }

  return { manifest, dist }
}
