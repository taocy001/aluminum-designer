import { afterEach, expect, it } from 'vitest'
import * as THREE from 'three'
import { drawingInput, prepareDrawingPreview } from '../utils/drawPreview'
import { buildProfile, prepareProfilePlacement } from '../utils/profileFactory'
import { computeTrims, setThroughRule } from '../utils/jointUtils'
import { profileFaceForWorldAxis } from '../utils/profileFaces'
import { useToolStore } from '../store/useToolStore'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
afterEach(() => { setThroughRule('rails'); useToolStore.getState().putDown() })

it.each([1, -1] as const)('numeric input previews the same actual cut and pose that will be committed on side %s', (side) => {
  setThroughRule('rails')
  const post = buildProfile(V(0, 0, 0), V(0, 800, 0), '4040')!
  const start = V(0, 400, 0), pointer = V(500, 400, 0)
  const faces = { startFace: profileFaceForWorldAxis(post, 2, side)! }
  const ghost = prepareDrawingPreview(start, pointer, '2020', [post], faces, '600')!
  const input = drawingInput(start, pointer, faces, '600')!
  const placed = prepareProfilePlacement(start, input.end, '2020', [post], input.faces)!
  expect(ghost.cutLength).toBe(600)
  expect(placed.profile.position).toEqual(ghost.profile.position)
  expect(placed.profile.quaternion).toEqual(ghost.profile.quaternion)
  expect(computeTrims(placed.profile, [post, placed.profile]).cutLength).toBe(ghost.cutLength)
})

it.each(['5', '-20', 'Infinity', '600x'])('invalid numeric input %s has neither a placement input nor a solid preview', (input) => {
  expect(drawingInput(V(0, 10, 0), V(600, 10, 0), {}, input)).toBeNull()
  expect(prepareDrawingPreview(V(0, 10, 0), V(600, 10, 0), '2020', [], {}, input)).toBeNull()
})

it('an empty input uses the pointer again, and a numeric input still needs a direction', () => {
  const start = V(0, 10, 0), end = V(600, 10, 0)
  expect(drawingInput(start, end, {}, '')?.end).toBe(end)
  expect(drawingInput(start, start, {}, '600')).toBeNull()
})

it('canceling and starting a new line clears the shared numeric preview input', () => {
  const tool = useToolStore.getState()
  tool.beginDraw(V(0, 10, 0))
  tool.setDrawLengthInput('600')
  expect(useToolStore.getState().drawLengthInput).toBe('600')
  tool.cancelDraw()
  expect(useToolStore.getState().drawLengthInput).toBe('')
  tool.setDrawLengthInput('800')
  tool.beginDraw(V(20, 10, 0))
  expect(useToolStore.getState().drawLengthInput).toBe('')
})
