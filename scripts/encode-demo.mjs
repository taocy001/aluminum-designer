/** Encode the UI recording without dropping low-motion frames. Requires FFmpeg. */
import { spawnSync } from 'node:child_process'
import { readFileSync, copyFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const input = 'test-results/demo-recording'
const hashes = JSON.parse(readFileSync(`${input}/complete.json`, 'utf8'))
for (const name of ['demo.webm', 'chapters.json', 'editor.png', 'save-dialog.png', 'five-tier-shelving.json']) {
  assert.equal(createHash('sha256').update(readFileSync(`${input}/${name}`)).digest('hex'), hashes[name],
    `Recording incomplete or changed: ${name}. Run record-demo.mjs again before encoding.`)
}
const chapters = JSON.parse(readFileSync(`${input}/chapters.json`, 'utf8'))
const start = chapters[0].seconds
const orbit = chapters.find(c => c.label.startsWith('左键拖动')).seconds
const pan = chapters.find(c => c.label.startsWith('右键拖动')).seconds
assert(start >= 0 && orbit > start && pan > orbit)
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
// The recording and script chapters use different time origins.
// Locate the caption's dark top edge in the fixed 1400×900 recording to align chapters.
const probe = spawnSync(ffmpeg, ['-v', 'error', '-t', String(start + 2), '-i', `${input}/demo.webm`,
  '-vf', 'crop=32:2:796:824,fps=25', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1024 * 1024 })
if (probe.error) throw probe.error
assert.equal(probe.status, 0, 'Cannot locate the recording caption')
const brightness = []
for (let at = 0; at + 64 <= probe.stdout.length; at += 64) {
  brightness.push(probe.stdout.subarray(at, at + 64).reduce((sum, pixel) => sum + pixel, 0) / 64)
}
const firstCaption = brightness.findIndex((value, i) => value < 35 && brightness[i + 1] < 35 && brightness[i + 2] < 35)
assert(firstCaption >= 0, 'Caption not found; verify recording layout before encoding')
const offset = start - firstCaption / 25
function encode(args) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  assert.equal(result.status, 0, 'FFmpeg encoding failed')
}

// The complete recording retains its original timing, including typing and gestures.
encode(['-i', `${input}/demo.webm`, '-an', '-c:v', 'libx264',
  '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'docs/demo.mp4'])
// The README loops only the orbit and zoom sequence; the full build is linked beside it.
encode(['-ss', String(Math.max(0, orbit - offset)), '-t', String(pan - orbit), '-i', `${input}/demo.webm`,
  '-filter_complex', 'fps=20,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  '-loop', '0', 'docs/demo.gif'])
for (const file of ['editor.png', 'save-dialog.png']) copyFileSync(`${input}/${file}`, `docs/${file}`)
console.log('Encoded full video, motion preview and editor screenshots')
