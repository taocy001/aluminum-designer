import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { 'three-bvh-csg': 'three-bvh-csg/src/index.js' } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    server: { deps: { inline: ['three-bvh-csg', 'three-mesh-bvh'] } },
  },
})
