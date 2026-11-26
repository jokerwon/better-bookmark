import process from 'node:process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'vite'
import { defineConfig } from 'vitest/config'
import Vue from '@vitejs/plugin-vue'

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
  plugins: [Vue()],
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
  base: './',
  test: {
    globals: true,
    environment: 'node',
    include: [r('src/__tests__/**/*.test.ts')],
    server: { deps: { inline: [] } },
  },
})
