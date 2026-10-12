import { browserApi } from '~/core/browser-api'

// 侧边栏通过 action 图标打开；后台只设置一次面板行为，不做任何书签操作。
browserApi.runtime.onInstalled.addListener(() => {
  void (browserApi as unknown as { sidePanel?: { setPanelBehavior: (behavior: { openPanelOnActionClick: boolean }) => Promise<void> } })
    .sidePanel?.setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {})
})
