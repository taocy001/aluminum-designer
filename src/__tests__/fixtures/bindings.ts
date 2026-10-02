import type { ProjectDocument } from '../../utils/document'
import type { OpeningRef } from '../../utils/openingBindings'
import type { ProfileData } from '../../store/useStore'

export const identity = [0, 0, 0, 1] as [number, number, number, number]
export const openingRef = (): OpeningRef => ({
  left: { profileId: 'left', axis: 0, side: 1 },
  right: { profileId: 'right', axis: 0, side: -1 },
  bottom: { profileId: 'bottom', axis: 1, side: 1 },
  top: { profileId: 'top', axis: 1, side: -1 },
  front: { profileId: 'left', axis: 1, side: 1 },
  back: { profileId: 'back', axis: 0, side: -1 },
})

/** A 500 × 560 × 480 mm opening, with a drawer, door, panel and attached support. */
export function boundProject(): ProjectDocument {
  const post: ProfileData['quaternion'] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]
  const cross: ProfileData['quaternion'] = [0, Math.SQRT1_2, 0, Math.SQRT1_2]
  const member = (id: string, position: ProfileData['position'], quaternion: ProfileData['quaternion'], length: number): ProfileData => ({
    id, position, quaternion, length, spec: '2020', fixedTrims: { start: 0, end: 0 }, miterCuts: [], holes: [],
  })
  return {
    throughRule: 'rails',
    profiles: [
      member('left', [-260, 0, 0], post, 600),
      member('right', [260, 0, 0], post, 600),
      member('bottom', [-250, 10, 0], cross, 500),
      member('top', [-250, 590, 0], cross, 500),
      member('back', [-250, 10, -500], cross, 500),
      { ...member('runner', [-260, 200, -470], identity, 480),
        runnerBinding: { fittingId: 'drawer', side: 'left', backOffset: 20, frontOffset: 20 } },
    ],
    fittings: [
      { id: 'drawer', kind: 'drawer', width: 500, height: 200, depth: 480, frame: 20, material: 'ply', open: 0,
        position: [0, 120, -250], quaternion: identity,
        drawer: { boxThickness: 18, runnerLength: 400, runnerTravel: 380 },
        openingBinding: { opening: openingRef(), mode: 'drawer', bottomOffset: 0 } },
      { id: 'door', kind: 'door', width: 150, height: 560, depth: 480, frame: 20, material: 'mdf', open: 0,
        position: [-125, 300, -250], quaternion: identity, hinge: 'left', meeting: 'right',
        openingBinding: { opening: openingRef(), mode: 'door', start: 0.1, end: 0.4 } },
    ],
    panels: [{ id: 'panel', width: 493, height: 557, thickness: 18, material: 'ply', position: [-1.5, 300.5, -12],
      quaternion: identity, openingBinding: { opening: openingRef(), mode: 'front',
        margins: { left: 2, right: 5, bottom: 2, top: 1 }, normalOffset: -2 } }],
    connectors: [{ id: 'support', type: 'bracket', series: 20, position: [-258, 203, -6], quaternion: identity,
      supportBinding: { profileId: 'runner', end: 'end', localPosition: [2, 3, -16], localQuaternion: identity } }],
  }
}
