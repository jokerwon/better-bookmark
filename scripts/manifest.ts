import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineManifest } from '../src/core/manifest'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const { manifest } = defineManifest()
const target = resolve(root, 'extension/manifest.json')

writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`).then(() => console.log('manifest.json 已写入', target))
