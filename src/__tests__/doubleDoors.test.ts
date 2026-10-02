import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { useStore, type FittingData, type Overlay } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { buildBom } from '../utils/bom'
import { parseProjectDocument, serializeProjectDocument, PROJECT_VERSION } from '../utils/document'
import { liveParts, mirrorSelected } from '../utils/editOps'
import { fittingHandle, fittingParts, hingeAxis, leafObb, openTransform, swingClashes } from '../utils/fittingGeometry'
import { canSplitDoor, splitDoor, splitSelectedDoors, updateFittings } from '../utils/fittingOps'
import { obbCorners, obbPenetration } from '../utils/obb'
import { decodeShare, encodeShareLink } from '../utils/shareLink'

const makeDoor = (patch: Partial<FittingData> = {}): FittingData => ({
  id: 'door', kind: 'door', width: 930, height: 800, depth: 540, frame: 20,
  material: 'mdf', position: [400, 500, -200], quaternion: [0, 0, 0, 1],
  hinge: 'left', hingeType: 'cup', overlay: 'full', swing: 110, open: 0, ...patch,
})
const frontOf = (f: FittingData) => fittingParts(f).boards[0]
const docOf = (fittings: FittingData[]) => ({
  profiles: [], connectors: [], panels: [], fittings, throughRule: 'posts' as const,
})
const localPoint = (p: THREE.Vector3, f: FittingData) => p.clone().sub(new THREE.Vector3(...f.position))
  .applyQuaternion(new THREE.Quaternion(...f.quaternion).normalize().invert())
const worldPoint = (p: THREE.Vector3, f: FittingData, open = 0) => {
  const at = openTransform({ ...f, open })
  return p.clone().applyQuaternion(at.quaternion).add(at.position)
    .applyQuaternion(new THREE.Quaternion(...f.quaternion).normalize()).add(new THREE.Vector3(...f.position))
}
const boundsInOpening = (f: FittingData, opening: FittingData) => new THREE.Box3()
  .setFromPoints(obbCorners(leafObb(f, 0)!).map((p) => localPoint(p, opening)))
const expectSameBox = (a: THREE.Box3, b: THREE.Box3) => {
  for (const axis of ['x', 'y', 'z'] as const) {
    expect(a.min[axis]).toBeCloseTo(b.min[axis], 7)
    expect(a.max[axis]).toBeCloseTo(b.max[axis], 7)
  }
}
const overlays: Overlay[] = ['full', 'half', 'inset']
const packedPayload = async (packed: unknown) => {
  const stream = new Blob([JSON.stringify(packed)]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

beforeEach(() => {
  useStore.setState({ ...docOf([]), past: [], future: [], selectedIds: [] })
  useToolStore.setState({ viewMode: false, toasts: [] })
})

describe('two doors share one opening without overlaying the meeting edge', () => {
  it.each(overlays)('preserves %s outside edges, height and front plane with a 3 mm meeting gap', (overlay) => {
    const poses: FittingData['quaternion'][] = [
      [0, 0, 0, 1], [0, 1, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.2, 0.1)).toArray() as FittingData['quaternion'],
      // A valid project quaternion can be a non-unit multiple of the same orientation.
      [0, 2, 0, 2],
    ]
    for (const frame of [0, 20, 40]) for (const quaternion of poses) {
      const source = makeDoor({ overlay, frame, quaternion, hinge: 'right' })
      const snapshot = structuredClone(source)
      const [left, right] = splitDoor(source, ['left', 'right'])!
      const before = boundsInOpening(source, source)
      const lb = boundsInOpening(left, source), rb = boundsInOpening(right, source)
      expectSameBox(lb.clone().union(rb), before)
      expect(rb.min.x - lb.max.x).toBeCloseTo(3, 7)
      expect(lb.max.x).toBeCloseTo(-1.5, 7)
      expect(rb.min.x).toBeCloseTo(1.5, 7)
      expect(left.hinge).toBe('left')
      expect(left.meeting).toBe('right')
      expect(right.hinge).toBe('right')
      expect(right.meeting).toBe('left')
      for (const leaf of [left, right]) {
        expect(leaf.width).toBe(source.width / 2)
        expect(leaf.height).toBe(source.height)
        expect(leaf.depth).toBe(source.depth)
        expect(leaf.frame).toBe(source.frame)
        expect(leaf.overlay).toBe(source.overlay)
        expect(leaf.material).toBe(source.material)
        expect(leaf.quaternion).toEqual(source.quaternion)
      }
      expect(source).toEqual(snapshot)
    }
  })

  it.each(overlays)('keeps %s hinges on the outside and handles beside the meeting edge', (overlay) => {
    const source = makeDoor({ overlay, frame: 40, quaternion: [0, 1, 0, 0] })
    const [left, right] = splitDoor(source, ['left', 'right'])!
    const outer = boundsInOpening(source, source)
    for (const [leaf, edge] of [[left, outer.min.x], [right, outer.max.x]] as const) {
      const pivot = hingeAxis(leaf).origin
      const closed = worldPoint(pivot, leaf)
      expect(localPoint(closed, source).x).toBeCloseTo(edge, 7)
      for (const open of [0.25, 0.5, 1]) expect(worldPoint(pivot, leaf, open).distanceTo(closed)).toBeLessThan(1e-7)
      const front = frontOf(leaf), handle = fittingHandle(leaf)
      const handleAt = localPoint(worldPoint(new THREE.Vector3(...handle.grip.position), leaf), source)
      expect(Math.abs(handleAt.x)).toBeCloseTo(41.5, 7)
      expect(handle.grip.position[2] - handle.grip.size[2] / 2
        - front.position[2] - front.thickness / 2).toBeCloseTo(18, 7)
      for (const hinge of fittingParts(leaf).hinges) {
        expect(localPoint(worldPoint(new THREE.Vector3(...hinge), leaf), source).x).toBeCloseTo(edge, 7)
      }
    }
  })

  it.each(overlays)('has no closed or sampled opening clash between its %s leaves', (overlay) => {
    const pair = splitDoor(makeDoor({ overlay, swing: 180 }), ['left', 'right'])!
    expect(obbPenetration(leafObb(pair[0], 0)!, leafObb(pair[1], 0)!)).toBe(0)
    expect(swingClashes(pair)).toEqual([])
    for (const a of [0, 0.25, 0.5, 0.75, 1]) for (const b of [0, 0.25, 0.5, 0.75, 1]) {
      expect(obbPenetration(leafObb(pair[0], a)!, leafObb(pair[1], b)!)).toBeLessThan(1e-7)
    }
  })

  it('lists the actual two board cuts and both leaves’ hinges', () => {
    const pair = splitDoor(makeDoor(), ['left', 'right'])!
    const bom = buildBom([], [], new Map(), 'en', [], pair)
    expect(bom.panels).toEqual([expect.objectContaining({ label: '830 × 478.5 mm', qty: 2 })])
    expect(bom.totalBoardArea).toBeCloseTo(830 * 478.5 * 2 / 1e6, 7)
    expect(bom.connectors.find((row) => row.key === 'hinge-cup')?.qty).toBe(4)
  })

  it.each([
    { kind: 'drawer' }, { width: 119 }, { width: NaN }, { width: Infinity },
    { hinge: 'top' }, { hinge: 'bottom' }, { meeting: 'left' }, { meeting: 'right' },
  ] as Partial<FittingData>[])('does not split unsupported door data %j', (patch) => {
    const source = makeDoor(patch)
    expect(canSplitDoor(source)).toBe(false)
    expect(splitDoor(source)).toBeNull()
  })

  it('accepts the minimum two 60 mm openings and a legacy default left hinge', () => {
    const pair = splitDoor(makeDoor({ width: 120, hinge: undefined }), ['left', 'right'])!
    expect(pair.map((f) => f.width)).toEqual([60, 60])
    expect(pair.map((f) => f.hinge)).toEqual(['left', 'right'])
  })
})

describe('double door design survives files, links and later edits', () => {
  it('saves and reads meeting edges, opening dimensions and closed geometry', () => {
    const source = makeDoor({ overlay: 'inset', quaternion: [0, 1, 0, 0], open: 0.5 })
    const pair = splitDoor(source, ['left', 'right'])!
    const document = docOf(pair)
    const saved = serializeProjectDocument(document)
    expect(JSON.parse(saved).version).toBe(PROJECT_VERSION)
    const back = parseProjectDocument(saved)
    expect(back).toEqual({ ...document, equipment: [], version: PROJECT_VERSION })
    for (let i = 0; i < pair.length; i++) expectSameBox(boundsInOpening(back.fittings[i], source), boundsInOpening(pair[i], source))
  })

  it('reads an old single door without changing its width or centred front', () => {
    const single = makeDoor()
    const back = parseProjectDocument({ version: 3, ...docOf([single]) }).fittings[0]
    expect(back.meeting).toBeUndefined()
    expect(frontOf(back).width).toBe(960)
    expect(frontOf(back).position[0]).toBe(0)
  })

  it.each([
    { meeting: 'middle' }, { meeting: null }, { meeting: 1 }, { meeting: 'left', kind: 'drawer' },
  ])('rejects invalid meeting data before replacing the drawing: %j', (patch) => {
    const before = useStore.getState()
    expect(() => useStore.getState().loadDocument(docOf([{ ...makeDoor(), ...patch } as FittingData])))
      .toThrow('fitting dimensions or mechanism')
    expect(useStore.getState()).toBe(before)
  })

  it('carries both meeting edges in a v4 link and keeps its board geometry', async () => {
    const source = makeDoor({ quaternion: [0, 1, 0, 0], overlay: 'half', open: 0.8 })
    const pair = splitDoor(source, ['left', 'right'])!
    const link = await encodeShareLink(docOf(pair), 'https://example.com/')
    const back = await decodeShare(new URL(link).hash.slice(3))
    expect(back.throughRule).toBe('posts')
    expect(back.fittings.map((f) => f.meeting)).toEqual(['right', 'left'])
    expect(back.fittings.map((f) => f.hinge)).toEqual(['left', 'right'])
    expect(back.fittings.map((f) => f.open)).toEqual([0, 0])
    for (let i = 0; i < pair.length; i++) expectSameBox(boundsInOpening(back.fittings[i], source), boundsInOpening(pair[i], source))
  })

  it('still reads v3 links without meeting columns', async () => {
    const single = makeDoor()
    const payload = await packedPayload([3, 'posts', [], [], [], [[
      single.kind, single.width, single.height, single.depth, single.position, single.quaternion,
      single.material, single.hinge, single.hingeType, single.overlay, single.swing,
      single.frame, null, false,
    ]]])
    const back = await decodeShare(payload)
    expect(back.fittings[0].meeting).toBeUndefined()
    expect(frontOf(back.fittings[0]).width).toBe(960)
  })

  it.each(['middle', null, 0, false])('rejects invalid meeting columns in v4 links: %j', async (meeting) => {
    const source = makeDoor()
    const payload = await packedPayload([4, 'posts', [], [], [], [[
      source.kind, source.width, source.height, source.depth, source.position, source.quaternion,
      source.material, source.hinge, source.hingeType, source.overlay, source.swing, source.frame, null, false, meeting,
    ]]])
    await expect(decodeShare(payload)).rejects.toThrow('fitting dimensions or mechanism')
  })

  it('keeps each leaf’s independent dimensions and meeting marker during later edits', () => {
    const pair = splitDoor(makeDoor(), ['left', 'right'])!
    useStore.setState(docOf(pair))
    expect(updateFittings(['left'], { width: 450 })).toBe(true)
    expect(useStore.getState().fittings[0]).toMatchObject({ width: 450, meeting: 'right' })
    expect(useStore.getState().fittings[1]).toBe(pair[1])
    expect(liveParts(['left'], { width: 460 }, true)).toBe(true)
    expect(useStore.getState().fittings[0]).toMatchObject({ width: 460, meeting: 'right' })
    expect(liveParts(['left'], { meeting: 'middle' }, true)).toBe(false)
    expect(liveParts(['left'], { kind: 'drawer' }, true)).toBe(false)
    const back = parseProjectDocument(serializeProjectDocument(useStore.getState()))
    expect(back.fittings[0]).toMatchObject({ width: 460, meeting: 'right' })
    expect(back.fittings[1].width).toBe(465)
  })

  it.each(['x', 'y', 'z'] as const)('reflects the meeting edge, hinge and moving leaf across world %s', (axis) => {
    const source = makeDoor({ quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -1.2, 0.1))
      .toArray() as FittingData['quaternion'] })
    const pair = splitDoor(source, ['left', 'right'])!
    useStore.setState({ ...docOf(pair), selectedIds: ['left', 'right'] })
    expect(mirrorSelected(axis)).toBe(true)
    const copies = useStore.getState().fittings.filter((f) => !['left', 'right'].includes(f.id))
    expect(copies).toHaveLength(2)
    expect(copies.map((f) => f.meeting)).toEqual(['left', 'right'])
    expect(copies.map((f) => f.hinge)).toEqual(['right', 'left'])
    for (let i = 0; i < copies.length; i++) for (const open of [0, 0.5, 1]) {
      const reflected = obbCorners(leafObb(pair[i], open)!).map((p) => {
        p[axis] = 2 * new THREE.Vector3(...source.position)[axis] - p[axis]
        return p
      })
      const actual = obbCorners(leafObb(copies[i], open)!)
      // Editing rounds part positions to 0.001 mm; orientation and leaf geometry still reflect.
      for (const p of reflected) expect(Math.min(...actual.map((a) => a.distanceTo(p)))).toBeLessThan(0.001)
    }
  })
})

describe('splitting selected doors is one document edit', () => {
  it('splits multiple doors, leaves locked and unsupported parts unchanged, and undoes atomically', () => {
    const first = makeDoor({ id: 'first' }), second = makeDoor({ id: 'second', position: [1800, 500, -200] })
    const locked = makeDoor({ id: 'locked', locked: true }), flap = makeDoor({ id: 'flap', hinge: 'top' })
    const drawer = makeDoor({ id: 'drawer', kind: 'drawer', material: 'ply' })
    const before = [first, second, locked, flap, drawer]
    useStore.setState({ ...docOf(before), selectedIds: before.map((f) => f.id) })
    expect(splitSelectedDoors()).toBe(true)
    const after = useStore.getState()
    expect(after.fittings).toHaveLength(7)
    expect(after.past).toHaveLength(1)
    expect(after.selectedIds).toHaveLength(7)
    expect(after.fittings.filter((f) => ['locked', 'flap', 'drawer'].includes(f.id))).toEqual([locked, flap, drawer])
    expect(after.fittings.filter((f) => f.meeting).map((f) => f.id)).toHaveLength(4)
    useStore.getState().undo()
    expect(useStore.getState().fittings).toEqual(before)
    expect(useStore.getState().throughRule).toBe('posts')
    useStore.getState().redo()
    expect(useStore.getState().fittings).toEqual(after.fittings)
  })

  it.each(['view', 'locked', 'already paired', 'narrow', 'not selected'])('does not write history when %s prevents splitting', (reason) => {
    const door = makeDoor({
      ...(reason === 'locked' ? { locked: true } : {}),
      ...(reason === 'already paired' ? { meeting: 'left' } : {}),
      ...(reason === 'narrow' ? { width: 119 } : {}),
    })
    useStore.setState({ ...docOf([door]), selectedIds: reason === 'not selected' ? [] : [door.id] })
    useToolStore.setState({ viewMode: reason === 'view' })
    const before = useStore.getState()
    expect(splitSelectedDoors()).toBe(false)
    expect(useStore.getState()).toBe(before)
  })
})
