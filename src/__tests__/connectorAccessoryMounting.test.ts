import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { ConnectorData, ProfileSpec } from '../store/useStore'
import { buildProfile } from '../utils/profileFactory'
import { computeAllTrims } from '../utils/jointUtils'
import { trimmedOBB } from '../utils/analysis'
import { connectorHitsBody } from '../utils/connectorCollision'
import { nonCornerSupports } from '../utils/connectorMounting'
import { auditBrackets } from '../utils/bracketSeat'
import { validateConnectorPlacement } from '../utils/connectorPlacement'

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const P = (id: string, a: number[], b: number[], spec: ProfileSpec = '2020') => buildProfile(V(...a as [number, number, number]), V(...b as [number, number, number]), spec, id)!
const C = (type: string, series: 20 | 30 | 40 = 20): ConnectorData => ({ id: type, type, series, position: [0, 0, 0], quaternion: [0, 0, 0, 1] })
const body = (p: ReturnType<typeof P>) => trimmedOBB(p, computeAllTrims([p]).get(p.id)!)

describe('accessory mounting against actual member sections', () => {
  it.each(['2020', '2040', '3030', '4040'] as const)('press-fits a %s cap only into its own aligned end', (spec) => {
    const p = P('host', [0, 0, -150], [0, 0, 0], spec)
    const c = { ...C('end-cap', Number(spec.slice(0, 2)) as 20 | 30 | 40), profileSpec: spec }
    expect(validateConnectorPlacement(c, [p], []).allowed).toBe(true)
    expect(connectorHitsBody(c, body(p), .15, false)).toBe(true)
    expect(connectorHitsBody({ ...c, position: [1, 0, 0] }, body(p))).toBe(true)
    expect(connectorHitsBody({ ...c, position: [0, 0, -1] }, body(p))).toBe(true)
    const obstacle = P('obstacle', [0, 0, -75], [0, 0, 75], spec)
    expect(connectorHitsBody(c, body(obstacle))).toBe(true)
  })

  it('requires the full cap specification and permits a square cut opposite a miter', () => {
    const p = P('host', [0, 0, -150], [0, 0, 0], '2040')
    const c = { ...C('end-cap'), profileSpec: '2040' as const }
    expect(nonCornerSupports(C('end-cap'), [p])).toBeNull()
    p.miterCuts = [{ side: 'start', angle: 45 }]
    expect(nonCornerSupports(c, [p])).toEqual(['host'])
    p.miterCuts = [{ side: 'end', angle: 45 }]
    expect(nonCornerSupports(c, [p])).toBeNull()
    expect(nonCornerSupports({ ...C('end-cap', 30), profileSpec: '3040' }, [P('legacy', [0, 0, -150], [0, 0, 0], '3040')])).toBeNull()
  })

  it.each([30, 40] as const)('seats the fixed M8 foot at a series %s tapped bottom end', (series) => {
    const p = P('post', [0, 0, 0], [0, 150, 0], `${series}${series}` as ProfileSpec), c = C('foot', series)
    expect(validateConnectorPlacement(c, [p], []).allowed).toBe(true)
    expect(connectorHitsBody({ ...c, position: [2, 0, 0] }, body(p))).toBe(true)
    expect(connectorHitsBody(c, body(p), .15, false)).toBe(true)
    expect(nonCornerSupports({ ...c, position: [0, 150, 0] }, [p])).toBeNull()
    expect(nonCornerSupports({ ...c, series: 20 }, [P('small', [0, 0, 0], [0, 150, 0])])).toBeNull()
  })

  it('requires two members for a splice plate, and both holes for the bearing base', () => {
    const left = P('left', [-100, -10, 0], [0, -10, 0]), right = P('right', [0, -10, 0], [100, -10, 0])
    expect(nonCornerSupports(C('flat-plate'), [left, right])).toEqual(['left', 'right'])
    expect(nonCornerSupports(C('flat-plate'), [P('single', [-100, -10, 0], [100, -10, 0])])).toBeNull()
    expect(nonCornerSupports(C('flat-plate'), [left])).toBeNull()
    expect(nonCornerSupports(C('pivot'), [P('base', [-50, -10, 0], [50, -10, 0])])).toEqual(['base'])
    expect(nonCornerSupports(C('pivot'), [P('short', [-20, -10, 0], [0, -10, 0])])).toBeNull()
  })

  it('attaches the hinge leaves to distinct members and rejects an unsupported leaf', () => {
    const a = P('a', [-10, -10.5, -100], [-10, -10.5, 100]), b = P('b', [-10, 10.5, -100], [-10, 10.5, 100])
    const c = C('hinge'), supports = new Map<string, string[]>()
    expect(auditBrackets([a, b], [c], undefined, supports)).toEqual([])
    expect(supports.get(c.id)).toEqual(['a', 'b'])
    expect(auditBrackets([a], [c]).map((f) => f.id)).toEqual([c.id])
    expect(nonCornerSupports({ ...c, position: [0, .7, 0] }, [a, b])).toBeNull()
  })

  it('does not accept an unverified caster or legacy 3040 slot', () => {
    expect(validateConnectorPlacement(C('caster-mount', 30), [P('p', [0, 0, 0], [0, 150, 0], '3030')], []).reason).toBe('unverified')
    expect(nonCornerSupports(C('t-nut', 30), [P('p', [0, -20, -100], [0, -20, 100], '3040')])).toBeNull()
  })
})
