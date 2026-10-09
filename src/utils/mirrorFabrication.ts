import { Quaternion, Vector3 } from 'three'
import type { FittingData } from '../store/useStore'
import type { BoardFabrication } from './boardFabrication'
import { fittingParts } from './fittingGeometry'

export function mirrorBoardFabrication(value?: BoardFabrication, x = true, y = false): BoardFabrication | undefined {
  if (!value) return undefined
  const [left, right, bottom, top] = value.bands
  return { grain: value.grain, bands: [x ? right : left, x ? left : right, y ? top : bottom, y ? bottom : top] }
}

/** Mirroring the assembly reverses its local X; side boards exchange places. */
export function mirrorFittingFabrication(before: FittingData, after: FittingData): FittingData['fabrication'] {
  if (!before.fabrication) return undefined
  const oldBoards = fittingParts({ ...before, open: 0 }).boards
  const newBoards = fittingParts({ ...after, open: 0 }).boards
  const result: NonNullable<FittingData['fabrication']> = {}
  for (const b of oldBoards) {
    const value = before.fabrication[b.key]
    if (!value) continue
    const at = new Vector3(...b.position); at.x *= -1
    const match = newBoards.find(n => n.role === b.role && new Vector3(...n.position).distanceTo(at) < 1e-5)
    if (!match) continue
    const reverse = (axis: Vector3) => {
      const source = axis.clone().applyQuaternion(new Quaternion(...b.quaternion)); source.x *= -1
      return source.dot(axis.clone().applyQuaternion(new Quaternion(...match.quaternion))) < 0
    }
    result[match.key] = mirrorBoardFabrication(value, reverse(new Vector3(1, 0, 0)), reverse(new Vector3(0, 1, 0)))!
  }
  return result
}
