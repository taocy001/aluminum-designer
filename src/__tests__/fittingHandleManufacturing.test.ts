import { describe, expect, it } from 'vitest'
import { Quaternion, Vector3 } from 'three'
import type { FittingData } from '../store/useStore'
import { useStore } from '../store/useStore'
import { fittingHandle, fittingBodies, fittingSolids, frontBoard, openTransform } from '../utils/fittingGeometry'
import { fittingHandleHoles, handleFitsFront } from '../utils/fittingHandle'
import { validFitting } from '../utils/fittingValidation'
import { documentBoards, panelHolesCsv } from '../utils/panelNesting'
import { serializeProjectDocument, parseProjectDocument } from '../utils/document'
import { encodeShareLink, decodeShare } from '../utils/shareLink'
import { buildBom } from '../utils/bom'
import { buildDxf } from '../utils/dxf'
import { buildStep } from '../utils/step'
import { canSplitDoor, splitDoor } from '../utils/fittingOps'

const door = (patch: Partial<FittingData> = {}): FittingData => ({ id: 'pull-door', kind: 'door', width: 560, height: 720, depth: 440,
  position: [120, 430, -250], quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), .6).toArray(),
  material: 'mdf', hinge: 'left', open: 0, frame: 20, overlay: 'full',
  handle: { pitch: 128, projection: 32, thickness: 12, holeDiameter: 4.5, x: 245, y: 25 }, ...patch })
const doc = (f: FittingData) => ({ profiles: [], panels: [], connectors: [], fittings: [f], throughRule: 'rails' as const })

describe('measured pulls', () => {
  it.each(['left', 'right', 'top', 'bottom'] as const)('shares %s-hinged door hole centres, envelope and exports', hinge => {
    const f = door({ hinge, handle: { ...door().handle!, x: 0, y: 0 } })
    const front = frontBoard(f), holes = fittingHandleHoles(f, front.key), handle = fittingHandle(f)
    expect(validFitting(f)).toBe(true)
    expect(holes).toHaveLength(2)
    expect(Math.hypot(holes[0].x - holes[1].x, holes[0].y - holes[1].y)).toBeCloseTo(128)
    expect(handle.grip.position[2] + 6 - front.position[2] - 9).toBe(32)
    const boards = documentBoards(doc(f))
    expect(boards[0].holes).toEqual(holes.map(h => ({ ...h, x: h.x + front.width / 2, y: h.y + front.height / 2 })))
    expect(panelHolesCsv(boards)).toContain('"4.5"')
    const dxf = buildDxf(doc(f))
    expect(dxf.match(/\nCIRCLE\n/g)).toHaveLength(2)
    const step = buildStep(doc(f))
    expect(step).toContain('F-pull-door.H')
    const bom = buildBom([], [], new Map(), 'en', [], [f])
    expect(bom.connectors.find(r => r.key.startsWith('pull-'))).toMatchObject({ qty: 1, partNumbers: ['F-pull-door.H'] })
  })

  it('places a drawer pull on the shifted stacked front and only drills the outer front', () => {
    const f = door({ kind: 'drawer', height: 240, stacked: { above: true }, handle: { ...door().handle!, x: 0 } })
    const front = frontBoard(f), handle = fittingHandle(f)
    expect(handle.grip.position[1]).toBe(front.position[1] + 25)
    const boards = documentBoards(doc(f))
    expect(boards.filter(b => b.holes.length).map(b => b.boardKey)).toEqual(['front'])
    expect(fittingHandleHoles(f, 'front').map(h => h.y)).toEqual([25, 25])
  })

  it('moves the handle collision envelope with the open rotated assembly', () => {
    const f = door({ open: .5 }), motion = openTransform(f), h = fittingHandle(f).grip
    const expected = new Vector3(...h.position).applyQuaternion(motion.quaternion).add(motion.position)
      .applyQuaternion(new Quaternion(...f.quaternion)).add(new Vector3(...f.position))
    const boxes = fittingBodies(f)
    expect(boxes).toHaveLength(fittingSolids(f).length + 3)
    expect(boxes[1].center.distanceTo(expected)).toBeLessThan(1e-8)
  })

  it('preserves dimensions through JSON and share links and does not invent legacy holes', async () => {
    const f = door()
    expect(parseProjectDocument(serializeProjectDocument(doc(f))).fittings[0].handle).toEqual(f.handle)
    const link = await encodeShareLink(doc(f), 'https://example.com/')
    expect((await decodeShare(link.split('#d=')[1])).fittings[0].handle).toEqual(f.handle)
    const legacy = door({ handle: undefined })
    expect(documentBoards(doc(legacy))[0].holes).toEqual([])
    expect(fittingBodies(legacy)).toHaveLength(1)
    expect(buildBom([], [], new Map(), 'en', [], [legacy]).connectors.some(r => r.key.startsWith('pull-'))).toBe(false)
  })

  it('rejects invalid fields, an out-of-board envelope and bores intersecting edge bands', () => {
    for (const patch of [{ pitch: NaN }, { pitch: 12 }, { thickness: 0 }, { projection: 10 }, { holeDiameter: 14 }, { x: 400 }]) {
      const f = door({ handle: { ...door().handle!, ...patch } })
      expect(validFitting(f)).toBe(false)
      expect(() => parseProjectDocument(doc(f))).toThrow()
    }
    const f = door({ handle: { ...door().handle!, x: 288 }, fabrication: { panel: { grain: 'none', bands: [0, 10, 0, 0] } } })
    expect(handleFitsFront({ ...f, fabrication: undefined })).toBe(true)
    expect(handleFitsFront(f)).toBe(false)
  })

  it.each(['full', 'half', 'inset'] as const)('preserves free-edge setback when splitting %s fronts', overlay => {
    for (const hinge of ['left', 'right'] as const) {
      const f = door({ overlay, hinge, handle: { ...door().handle!, x: hinge === 'left' ? 220 : -220 } })
      const pair = splitDoor(f)!
      expect(canSplitDoor(f)).toBe(true)
      const setback = frontBoard(f).width / 2 - Math.abs(f.handle!.x)
      for (const leaf of pair) expect(frontBoard(leaf).width / 2 - Math.abs(leaf.handle!.x)).toBeCloseTo(setback)
    }
    for (const x of [0, 20, -20]) {
      const f = door({ overlay, handle: { ...door().handle!, x } })
      expect(canSplitDoor(f)).toBe(false)
      expect(splitDoor(f)).toBeNull()
    }
  })

  it('keeps a pull away from the hinge when splitting a door and undoes configuration edits', () => {
    const pair = splitDoor(door())!
    expect(pair).not.toBeNull()
    expect(pair.every(validFitting)).toBe(true)
    expect(pair[0].handle!.x).toBeGreaterThan(0)
    expect(pair[1].handle!.x).toBe(-pair[0].handle!.x)
    useStore.setState({ ...doc(door({ handle: undefined })), past: [], future: [], selectedIds: [] })
    expect(useStore.getState().updateFitting('pull-door', { handle: door().handle }).status).toBe('applied')
    useStore.getState().undo()
    expect(useStore.getState().fittings[0].handle).toBeUndefined()
    useStore.getState().redo()
    expect(useStore.getState().fittings[0].handle).toEqual(door().handle)
  })
})
