import { defineManifest } from './core/manifest'

const { manifest, dist } = defineManifest()

export async function getManifest() {
  return manifest
}

export { dist }
