import fs from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { root, imageDirectory, manifestPath, digest, thumbnailSources, checkThumbnails } from './connector-thumbnail-sources.mjs'

if (process.argv.includes('--check')) {
  const manifest = checkThumbnails()
  console.log(`${Object.keys(manifest.images).length} connector thumbnails match their source geometry`)
} else {
  // SSR transforms TypeScript/JSON without opening an HTTP port or rendering the app.
  const { createServer } = await import('vite')
  const { chromium } = await import('@playwright/test')
  const cacheDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-thumbnails-'))
  const transport = createHttpServer()
  const loader = await createServer({ root, configFile: false,
    cacheDir: cacheDirectory,
    // Sharing an unbound transport also prevents Vite's HMR listener opening a port.
    server: { middlewareMode: true, hmr: { server: transport }, watch: null },
    ssr: { noExternal: ['three-bvh-csg', 'three-mesh-bvh'] },
    optimizeDeps: { noDiscovery: true },
  })
  let browser
  try {
    const { projectThumbnail, thumbnailTypes, thumbnailSeries } = await loader.ssrLoadModule('/scripts/connector-thumbnail-model.ts')
    browser = await chromium.launch({ headless: true })
    const page = await browser.newPage()
    const files = new Map(), images = {}
    for (const type of thumbnailTypes) for (const series of thumbnailSeries) {
      const triangles = projectThumbnail(type, series)
      const png = await page.evaluate((faces) => {
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 168
        const context = canvas.getContext('2d')
        context.scale(2, 2)
        context.lineWidth = .3
        context.lineJoin = 'round'
        for (const { path, fill } of faces) {
          context.fillStyle = context.strokeStyle = fill
          const triangle = new Path2D(path)
          context.fill(triangle)
          context.stroke(triangle)
        }
        return canvas.toDataURL('image/png').split(',')[1]
      }, triangles)
      const buffer = Buffer.from(png, 'base64'), sha256 = digest(buffer)
      const file = `${type}-${series}-${sha256.slice(0, 12)}.png`
      files.set(file, buffer)
      images[`${type}:${series}`] = { file, sha256 }
    }
    fs.mkdirSync(imageDirectory, { recursive: true })
    for (const [file, data] of files) fs.writeFileSync(path.join(imageDirectory, file), data)
    for (const file of fs.readdirSync(imageDirectory)) {
      if (file.endsWith('.png') && !files.has(file)) fs.unlinkSync(path.join(imageDirectory, file))
    }
    const manifest = { format: 1, width: 168, height: 168, ...thumbnailSources(), images }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
    checkThumbnails()
    console.log(`Generated ${files.size} connector thumbnails (${[...files.values()].reduce((sum, data) => sum + data.length, 0)} bytes)`)
  } finally {
    await browser?.close()
    await loader.close()
    fs.rmSync(cacheDirectory, { recursive: true, force: true })
  }
}
