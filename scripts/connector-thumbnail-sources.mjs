import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const imageDirectory = path.join(root, 'public/connector-thumbnails')
export const manifestPath = path.join(root, 'src/assets/connectorThumbnails.json')
export const digest = (data) => createHash('sha256').update(data).digest('hex')

/** Follow runtime imports so a changed CAD file or dimension cannot leave a stale icon. */
export function thumbnailSources() {
  const files = new Map()
  const resolve = (from, specifier) => {
    const base = path.resolve(path.dirname(from), specifier)
    const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.json`, path.join(base, 'index.ts')]
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    if (!resolved) throw new Error(`Cannot resolve thumbnail dependency ${specifier} from ${from}`)
    return resolved
  }
  const visit = (file) => {
    const relative = path.relative(root, file).split(path.sep).join('/')
    if (files.has(relative)) return
    const data = fs.readFileSync(file)
    files.set(relative, digest(data))
    if (!/\.[cm]?[jt]sx?$/.test(file)) return
    const source = ts.createSourceFile(file, data.toString(), ts.ScriptTarget.Latest, true)
    const importFile = (specifier) => {
      if (specifier?.startsWith('.')) visit(resolve(file, specifier))
    }
    const scan = (node) => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        if (clause?.isTypeOnly) return
        const bindings = clause?.namedBindings
        if (!clause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.length
          && bindings.elements.every((entry) => entry.isTypeOnly)) return
        if (ts.isStringLiteral(node.moduleSpecifier)) importFile(node.moduleSpecifier.text)
      } else if (ts.isExportDeclaration(node)) {
        if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) importFile(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) importFile(node.arguments[0].text)
      ts.forEachChild(node, scan)
    }
    scan(source)
  }
  for (const file of ['scripts/generate-connector-thumbnails.mjs', 'scripts/connector-thumbnail-sources.mjs',
    'scripts/connector-thumbnail-model.ts', 'package-lock.json']) visit(path.join(root, file))
  const sources = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b, 'en')))
  return { sources, sourceHash: digest(JSON.stringify(sources)) }
}

export function checkThumbnails() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const current = thumbnailSources()
  if (manifest.sourceHash !== current.sourceHash || JSON.stringify(manifest.sources) !== JSON.stringify(current.sources)) {
    throw new Error('Connector thumbnails are stale. Run node scripts/generate-connector-thumbnails.mjs')
  }
  for (const [key, image] of Object.entries(manifest.images)) {
    const data = fs.readFileSync(path.join(imageDirectory, image.file))
    if (digest(data) !== image.sha256 || data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || data.readUInt32BE(16) !== 168 || data.readUInt32BE(20) !== 168) {
      throw new Error(`Invalid connector thumbnail ${key}`)
    }
  }
  const actual = fs.readdirSync(imageDirectory).filter((file) => file.endsWith('.png')).sort()
  const expected = Object.values(manifest.images).map(({ file }) => file).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Untracked or missing connector thumbnails')
  return manifest
}
