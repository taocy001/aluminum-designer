import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { parseProjectDocument } from '../utils/document'
import { computeAllTrims, computeFrameBounds, getProfileDir, setThroughRule, trimmedBox } from '../utils/jointUtils'
import { fittingParts, openTransform, swingClashes } from '../utils/fittingGeometry'
import type { FittingData } from '../store/useStore'
import { auditBrackets } from '../utils/bracketSeat'
import { findConflicts } from '../utils/analysis'
import { sameConnectorInstallation } from '../utils/connectorPlacement'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const frontBoard = (f: FittingData) => fittingParts(f).boards.find((b) => b.role === 'front' || b.role === 'panel')!
const loaded = import.meta.glob(['../../examples/*.json', '../../examples/flat/*.json'], { eager: true }) as Record<string, { default: unknown }>
const drawings = Object.entries(loaded).filter(([file]) => !file.endsWith('/connector-demo.json'))
const load = (name: string) => {
  const source = drawings.find(([file]) => file.endsWith(`/${name}.json`))
  if (!source) throw new Error(`Missing example ${name}`)
  const doc = parseProjectDocument(source[1].default)
  setThroughRule(doc.throughRule)
  return doc
}

afterEach(() => setThroughRule('rails'))

describe('example cabinet layouts', () => {
  it.each(drawings)('%s does not charge for the same connector twice', (_file, source) => {
    const { connectors } = parseProjectDocument(source.default)
    const duplicates: string[][] = []
    for (let i = 0; i < connectors.length; i++) {
      const a = connectors[i]
      for (const b of connectors.slice(i + 1)) {
        if (sameConnectorInstallation(a, b)) duplicates.push([a.id, b.id])
      }
    }
    expect(duplicates).toEqual([])
  })

  it.each([
    ['01-kitchen-base', [780, 610, 930, 280, 680]],
    ['02-kitchen-wall', [780, 610, 930, 280, 680]],
    ['03-tall-unit', [910, 580]],
    ['04-shoe-cupboard', [580, 580]],
    ['05-media-unit', [580, 580, 580, 580]],
    ['06-wardrobe', [960, 960]],
    ['07-desk', [880, 480]],
    ['08-bookshelf', [680, 680]],
    ['09-laundry', [640, 810]],
    ['10-wardrobe-small', [560, 560]],
    ['11-sideboard', [580, 580]],
    ['12-vanity', [380, 380]],
  ] as const)('%s keeps the documented clear bay widths', (name, expected) => {
    const doc = load(name)
    const trims = computeAllTrims(doc.profiles)
    const posts = doc.profiles.filter((p) => Math.abs(getProfileDir(p).y) > 0.999)
      .map((p) => ({ x: p.position[0], box: trimmedBox(p, trims.get(p.id)!) }))
    const columns = [...new Set(posts.map((p) => Math.round(p.x)))].sort((a, b) => a - b)
    const widths = columns.slice(1).map((x, i) => {
      const left = Math.max(...posts.filter((p) => Math.abs(p.x - columns[i]) < 0.1).map((p) => p.box.max.x))
      const right = Math.min(...posts.filter((p) => Math.abs(p.x - x) < 0.1).map((p) => p.box.min.x))
      return Math.round(right - left)
    })
    expect(widths).toEqual(expected)
  })

  it.each([
    ['01-kitchen-base', 810, 1420, 650, 0, 840, [3400, 880, 670]],
    ['03-tall-unit', 20, 930, 660, -10, 2260, [1610, 2300, 690]],
    ['09-laundry', 10, 650, 780, 0, 940, [1510, 980, 800]],
  ] as const)('%s has an open appliance entry and keeps its rear rail', (name, left, right, front, rear, top, size) => {
    const doc = load(name)
    const trims = computeAllTrims(doc.profiles)
    const bodies = doc.profiles.map((p) => ({ p, box: trimmedBox(p, trims.get(p.id)!) }))
    // The entry is the space between actual post faces, from the post-base datum to the
    // underside of the header. This checks framing, not compatibility with an unknown machine.
    const entry = new THREE.Box3(new THREE.Vector3(left + 0.1, 0.1, front - 0.1), new THREE.Vector3(right - 0.1, top - 0.1, front + 30))
    expect(bodies.filter(({ box }) => box.intersectsBox(entry)).map(({ p }) => p.id)).toEqual([])
    expect(bodies.some(({ p, box }) => Math.abs(getProfileDir(p).x) > 0.999
      && box.min.x <= left + 0.1 && box.max.x >= right - 0.1 && box.min.y < 1 && box.max.y >= 39
      && box.min.z <= rear && box.max.z >= rear)).toBe(true)
    const bounds = computeFrameBounds(doc.profiles, trims)!.getSize(new THREE.Vector3())
    bounds.toArray().forEach((v, i) => expect(v).toBeCloseTo(size[i], 6))
    expect(auditBrackets(doc.profiles, doc.connectors, trims, undefined, doc.panels)).toEqual([])
  })

  it('the kitchen drawers close on the same front as its doors and pull towards the user', () => {
    const doc = load('01-kitchen-base')
    expect(doc.fittings).toHaveLength(7)
    for (const f of doc.fittings) {
      const q = new THREE.Quaternion(...f.quaternion)
      const out = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
      expect(out.z).toBeCloseTo(1, 8)
      const front = fittingParts(f).boards.find((b) => b.role === (f.kind === 'door' ? 'panel' : 'front'))!
      const innerFace = new THREE.Vector3(...front.position).add(new THREE.Vector3(0, 0, -front.thickness / 2))
        .applyQuaternion(q).add(new THREE.Vector3(...f.position))
      expect(innerFace.z).toBeCloseTo(660, 6)
      if (f.kind === 'drawer') {
        const motion = openTransform({ ...f, open: 1 })
        const movement = motion.position.clone().applyQuaternion(q)
        expect(movement.z).toBeGreaterThan(0)
      }
    }
    const trims = computeAllTrims(doc.profiles)
    for (const open of [0, 0.5, 1]) {
      expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, doc.fittings.map((f) => ({ ...f, open })))).toEqual([])
    }
  })

  it('does not force every valid cabinet front into the same world direction', () => {
    const kitchen = load('kitchen-l-shaped')
    const directions = kitchen.fittings.map((f) => new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...f.quaternion)))
    expect(directions.filter((v) => v.z > 0.99)).toHaveLength(3)
    expect(directions.filter((v) => v.x < -0.99)).toHaveLength(1)
    for (const name of ['05-media-unit', '07-desk']) {
      const doc = load(name)
      expect(doc.fittings.every((f) => new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion(...f.quaternion)).z < -0.99)).toBe(true)
    }
  })

  it.each([
    ['desk-with-pedestal', 1, 940],
    ['07-desk', -1, 880],
  ] as const)('%s leaves the leg entry open on the drawer-facing side and retains a rear brace', (name, frontSign, width) => {
    const doc = load(name)
    const drawers = doc.fittings.filter((f) => f.kind === 'drawer')
    expect(drawers.length).toBeGreaterThan(0)
    const out = V(0, 0, 1).applyQuaternion(new THREE.Quaternion(...drawers[0].quaternion))
    expect(out.z).toBeCloseTo(frontSign, 8)
    for (const drawer of drawers) {
      const direction = V(0, 0, 1).applyQuaternion(new THREE.Quaternion(...drawer.quaternion))
      expect(direction.distanceTo(out)).toBeLessThan(1e-8)
      expect(openTransform({ ...drawer, open: 1 }).position.applyQuaternion(new THREE.Quaternion(...drawer.quaternion)).dot(out)).toBeGreaterThan(0)
    }

    const trims = computeAllTrims(doc.profiles)
    const bodies = doc.profiles.map((p) => ({ p, box: trimmedBox(p, trims.get(p.id)!) }))
    const posts = bodies.filter(({ p }) => Math.abs(getProfileDir(p).y) > 0.999)
    const columns = [...new Set(posts.map(({ p }) => p.position[0]))].sort((a, b) => a - b)
    const left = Math.max(...posts.filter(({ p }) => p.position[0] === columns[0]).map(({ box }) => box.max.x))
    const right = Math.min(...posts.filter(({ p }) => p.position[0] === columns[1]).map(({ box }) => box.min.x))
    expect(right - left).toBeCloseTo(width, 6)
    const floor = Math.min(...bodies.map(({ box }) => box.min.y))
    const front = frontSign > 0 ? Math.max(...posts.map(({ box }) => box.max.z)) : Math.min(...posts.map(({ box }) => box.min.z))
    const rear = frontSign > 0 ? Math.min(...posts.map(({ p }) => p.position[2])) : Math.max(...posts.map(({ p }) => p.position[2]))
    const crossRails = bodies.filter(({ p, box }) => Math.abs(getProfileDir(p).x) > 0.999
      && box.min.x <= left + 0.1 && box.max.x >= right - 0.1)
    const header = Math.min(...crossRails.filter(({ box }) => box.min.y > floor + 100).map(({ box }) => box.min.y))
    expect(Number.isFinite(header)).toBe(true)
    expect(header - floor).toBeGreaterThanOrEqual(600)
    // Derive the approach side from the drawers, including the low foot-entry zone.
    // The strip extends 100 mm into the frame and 30 mm outside its front posts.
    const depth = [front - out.z * 100, front + out.z * 30].sort((a, b) => a - b)
    const entry = new THREE.Box3(V(left + 0.1, floor + 0.1, depth[0]), V(right - 0.1, header - 0.1, depth[1]))
    expect(bodies.filter(({ box }) => box.intersectsBox(entry)).map(({ p }) => p.id)).toEqual([])
    expect(crossRails.some(({ box }) => box.min.y <= floor + 0.1 && box.max.y > floor
      && box.min.z <= rear && box.max.z >= rear)).toBe(true)
  })

  it.each([
    ['01-kitchen-base', 400, 780, 6],
    ['01-kitchen-base', 3030, 680, 6],
    ['02-kitchen-wall', 400, 780, 6],
    ['02-kitchen-wall', 1115, 610, 6],
    ['02-kitchen-wall', 3030, 680, 6],
    ['06-wardrobe', 500, 960, 15],
    ['06-wardrobe', 1500, 960, 15],
    ['09-laundry', 1075, 810, 6],
    ['wardrobe-2-door', 460, 840, 15],
    ['wardrobe-2-door', 1340, 840, 15],
  ] as const)('%s has two outward-hinged leaves covering the bay at x=%s', (name, x, width, lap) => {
    const doc = load(name)
    const pair = doc.fittings.filter((f) => f.kind === 'door' && f.meeting
      && Math.abs(f.position[0] - x) < width / 2).sort((a, b) => a.position[0] - b.position[0])
    expect(pair).toHaveLength(2)
    expect(pair.map((f) => f.hinge)).toEqual(['left', 'right'])
    expect(pair.map((f) => f.meeting)).toEqual(['right', 'left'])
    const extents = pair.map((f) => {
      const board = frontBoard(f)
      const center = f.position[0] + board.position[0]
      return [center - board.width / 2, center + board.width / 2]
    })
    expect(extents[0][0]).toBeCloseTo(x - width / 2 - lap, 6)
    expect(extents[1][1]).toBeCloseTo(x + width / 2 + lap, 6)
    expect(extents[1][0] - extents[0][1]).toBeCloseTo(3, 6)
    const trims = computeAllTrims(doc.profiles)
    for (const open of [0.25, 0.5, 0.75, 1]) {
      for (const ids of [[pair[0].id], [pair[1].id], pair.map((f) => f.id)]) {
        const fittings = doc.fittings.map((f) => ids.includes(f.id) ? { ...f, open } : f)
        expect(findConflicts(doc.profiles, trims, doc.connectors, doc.panels, fittings)).toEqual([])
      }
    }
  })

  it('keeps the dishwasher entry free of ordinary cabinet doors and drawer fronts', () => {
    const doc = load('01-kitchen-base')
    const fronts = doc.fittings.map((f) => {
      const b = frontBoard(f)
      const x = f.position[0] + b.position[0]
      return [x - b.width / 2, x + b.width / 2]
    })
    expect(fronts.filter(([left, right]) => right > 810 && left < 1420)).toEqual([])
  })

  it.each(drawings)('%s uses its specified drawer widths and door boards at most 610 mm wide', (file, source) => {
    const doc = parseProjectDocument(source.default)
    const wideDrawer = file.endsWith('/01-kitchen-base.json') ? 930 : file.endsWith('/wardrobe-2-door.json') ? 840 : undefined
    for (const f of doc.fittings) {
      if (f.kind === 'door') expect(frontBoard(f).width).toBeLessThanOrEqual(610.001)
      else if (wideDrawer !== undefined) expect(f.width).toBe(wideDrawer)
      else expect(f.width).toBeLessThanOrEqual(580.001)
    }
  })

  it.each(['01-kitchen-base', '02-kitchen-wall', '06-wardrobe', '09-laundry', 'wardrobe-2-door'])(
    '%s keeps adjacent doors apart throughout their configured swings', (name) => {
      expect(swingClashes(load(name).fittings)).toEqual([])
    },
  )

  it('bolts both ends of the kitchen cupboard shelf rails to their posts', () => {
    const doc = load('01-kitchen-base')
    const supports = new Map<string, string[]>()
    expect(auditBrackets(doc.profiles, doc.connectors, computeAllTrims(doc.profiles), supports, doc.panels)).toEqual([])
    for (const z of [0, 650]) for (const x of [2680, 3380]) {
      const rail = doc.profiles.find((p) => p.position[0] === 2680 && p.position[1] === 440
        && p.position[2] === z && getProfileDir(p).x > 0.999)!
      const post = doc.profiles.find((p) => p.position[0] === x && p.position[2] === z
        && getProfileDir(p).y > 0.999)!
      expect(rail).toBeDefined()
      expect(post).toBeDefined()
      const bracket = doc.connectors.find((c) => c.type === 'inside-corner'
        && supports.get(c.id)?.includes(rail.id) && supports.get(c.id)?.includes(post.id)
        && [V(1, 0, 0), V(0, 1, 0)].some((axis) => axis.applyQuaternion(new THREE.Quaternion(...c.quaternion)).y > 0.999))
      expect(bracket).toBeDefined()
      const q = new THREE.Quaternion(...bracket!.quaternion)
      const arms = [V(1, 0, 0).applyQuaternion(q), V(0, 1, 0).applyQuaternion(q)]
      expect(arms.some((v) => v.y > 0.999)).toBe(true)
      expect(arms.some((v) => v.x * (x === 2680 ? 1 : -1) > 0.999)).toBe(true)
      expect(auditBrackets(doc.profiles, [bracket!])).toEqual([])
    }
  })
})
