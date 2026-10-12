import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import Vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import packageJson from './package.json'

const root = dirname(fileURLToPath(import.meta.url))
export const r = (...segments: string[]) => resolve(root, ...segments)
const isDev = process.env.NODE_ENV !== 'production'
export const port = Number(process.env.PORT || '') || 3303

export const sharedConfig: UserConfig = {
  root: r('src'),
  resolve: {
    alias: {
      '~/': `${r('src')}/`,
    },
  },
  define: {
    __DEV__: isDev,
    __NAME__: JSON.stringify(packageJson.name),
  },
  plugins: [
    Vue(),
    UnoCSS(),
    // 构建产物使用相对路径，扩展页面才能正确加载 assets。
    {
      name: 'assets-rewrite',
      enforce: 'post',
      apply: 'build',
      transformIndexHtml(html, { path }) {
        const relative = (from: string, to: string) => {
          const fromParts = dirname(from).split('/').filter(Boolean)
          const toParts = to.split('/').filter(Boolean)
          while (fromParts.length && fromParts[0] === toParts[0]) {
            fromParts.shift()
            toParts.shift()
          }
          return [...fromParts.map(() => '..'), ...toParts].join('/') || '.'
        }
        return html.replace(/"\/assets\//g, `"${relative(path, '/assets')}/`)
      },
    },
  ],
  build: {
    outDir: r('extension/dist'),
    emptyOutDir: false,
    sourcemap: isDev ? 'inline' : false,
    rollupOptions: {
      input: {
        options: r('src/options/index.html'),
        sidepanel: r('src/sidepanel/index.html'),
      },
    },
  },
}

export default defineConfig({
  ...sharedConfig,
  base: '/dist/',
  test: {
    globals: true,
    environment: 'node',
    include: [r('src/__tests__/**/*.test.ts')],
    server: { deps: { inline: [] } },
  },
})
