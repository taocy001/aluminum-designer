import * as THREE from 'three'
import type { ProfileData, ProfileSpec } from '../store/useStore'
import { buildProfile, nextId } from './profileFactory'

/**
 * Something to start from.
 *
 * An empty canvas is the hardest part of any drawing tool: it asks you to know the answer
 * before you have seen one. These are the shapes people actually build out of extrusion,
 * with the dimensions that matter exposed — change the numbers, get your frame, keep going.
 *
 * They are built from the same `buildProfile` a click builds with, so a template is a
 * drawing like any other from the moment it lands: every member can be moved, re-cut or
 * thrown away, and nothing about it is special afterwards.
 */

export interface TemplateParam {
  key: string
  labelZh: string
  labelEn: string
  value: number
  min: number
  max: number
  step: number
}

export interface Template {
  id: string
  labelZh: string
  labelEn: string
  noteZh: string
  noteEn: string
  params: TemplateParam[]
  build: (p: Record<string, number>) => ProfileData[]
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)

/** A member, or nothing when the two ends are the same point */
function bar(a: THREE.Vector3, b: THREE.Vector3, spec: ProfileSpec): ProfileData | null {
  if (a.distanceTo(b) < 10) return null
  const p = buildProfile(a, b, spec)
  return p ? { ...p, id: nextId('p') } : null
}

const keep = (list: Array<ProfileData | null>): ProfileData[] => list.filter((p): p is ProfileData => p !== null)

/**
 * A rail round the outside of a set of posts, pushed flush with them.
 *
 * A narrower rail centred on a wider post has no line across the joint that is a slot on
 * both — the post's slots are ten either side of its middle and the rail's only slot is down
 * its own middle — so the bracket has nowhere to bite. Flush with the post's outer face, the
 * two line up. It is the rule the tool applies when a member is dropped by hand, and a
 * template that shipped without it would ship sixteen joints nobody can build.
 */
function perimeter(w: number, d: number, y: number, postW: number, railW: number, spec: ProfileSpec): Array<ProfileData | null> {
  const out = (postW - railW) / 2
  return [
    bar(V(0, y, -out), V(w, y, -out), spec),
    bar(V(0, y, d + out), V(w, y, d + out), spec),
    bar(V(-out, y, 0), V(-out, y, d), spec),
    bar(V(w + out, y, 0), V(w + out, y, d), spec),
  ]
}

/** The same member turned a quarter about its own axis: a 2040 on edge becomes one lying flat */
function rolled(p: ProfileData | null): ProfileData | null {
  if (!p) return null
  const quat = new THREE.Quaternion(...p.quaternion).normalize()
  const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(quat).normalize()
  const q = new THREE.Quaternion().setFromAxisAngle(axis, Math.PI / 2).multiply(quat).normalize()
  return { ...p, quaternion: [q.x, q.y, q.z, q.w] }
}

/**
 * Four posts, with the bottom frame standing on the floor beside them and the top frame
 * laid over the top of them.
 *
 * This is one of the ordinary ways to build a carcase, not the only one — a frame can be put
 * together plenty of other ways and the tool has no opinion about it. It is the default here
 * because what was the default before is not one of them.
 *
 * That was posts running the full height with both rings of rails let in between them, and
 * it is awkward in three ways somebody notices the first time they build it. The top is
 * missing a piece at each of the four corners, so a top board will not sit flat without four
 * notches cut out of it. The top rails hang off the posts by their bolts, when the load could
 * simply go down the posts. And the bottom frame hangs too, when the easiest thing available
 * is to stand it on the floor.
 *
 * So: the posts and the bottom frame all start at the floor, and the bottom rails butt in
 * between the posts. The top frame sits on top of the posts and lies flat — twenty
 * millimetres of height rather than forty, and a continuous surface to put something on. The
 * two long rails run the full width, so the outside corners are whole.
 */
function box(w: number, d: number, h: number, spec: ProfileSpec, bottomY = 0): ProfileData[] {
  const side = Number(spec.slice(0, 2)) || 20
  const face = Number(spec.slice(2)) || side
  const lying = Math.min(side, face)      // how tall the top frame is, laid flat
  const standing = Math.max(side, face)   // ...and the bottom frame, on edge
  const postTop = bottomY + h - lying
  const out: Array<ProfileData | null> = []

  for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, bottomY, z), V(x, postTop, z), spec))

  // on the floor, between the posts
  const by = bottomY + standing / 2
  out.push(bar(V(0, by, 0), V(w, by, 0), spec))
  out.push(bar(V(0, by, d), V(w, by, d), spec))
  out.push(bar(V(0, by, 0), V(0, by, d), spec))
  out.push(bar(V(w, by, 0), V(w, by, d), spec))

  // over the top of them, lying flat; the long pair runs the full width
  const ty = postTop + lying / 2
  out.push(rolled(bar(V(0, ty, 0), V(w, ty, 0), spec)))
  out.push(rolled(bar(V(0, ty, d), V(w, ty, d), spec)))
  out.push(rolled(bar(V(0, ty, 0), V(0, ty, d), spec)))
  out.push(rolled(bar(V(w, ty, 0), V(w, ty, d), spec)))
  return keep(out)
}

export const TEMPLATES: Template[] = [
  {
    id: 'bench',
    labelZh: '工作台', labelEn: 'Workbench',
    noteZh: '四角 4040 承重，台面高 900，下方一道中撑',
    noteEn: '4040 corner posts, 900 worktop, one mid rail',
    params: [
      { key: 'w', labelZh: '长', labelEn: 'Length', value: 1500, min: 400, max: 6000, step: 100 },
      { key: 'd', labelZh: '深', labelEn: 'Depth', value: 700, min: 300, max: 1200, step: 50 },
      { key: 'h', labelZh: '高', labelEn: 'Height', value: 900, min: 400, max: 1200, step: 50 },
    ],
    build: ({ w, d, h }) => {
      const out: Array<ProfileData | null> = []
      // the legs carry the top rather than hanging off it, so they stop under it
      const legTop = h - 20
      for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, 0, z), V(x, legTop, z), '4040'))
      // the lower rails are let in between the legs, so they are pushed flush with them; the
      // top frame is laid over the legs and touches them only from above, so it is not
      const ty = legTop + 10
      out.push(...perimeter(w, d, 20, 40, 20, '2040'))
      for (const [a, b] of [[V(0, ty, 0), V(w, ty, 0)], [V(0, ty, d), V(w, ty, d)],
        [V(0, ty, 0), V(0, ty, d)], [V(w, ty, 0), V(w, ty, d)]]) out.push(rolled(bar(a, b, '2040')))
      // one rail across the middle so a long top does not sag
      if (w > 1200) out.push(rolled(bar(V(w / 2, ty, 0), V(w / 2, ty, d), '2040')))
      return keep(out)
    },
  },
  {
    id: 'shelving',
    labelZh: '置物架', labelEn: 'Shelving',
    noteZh: '层数与层高可调，每层四周一圈横梁',
    noteEn: 'Any number of shelves, a rail round each',
    params: [
      { key: 'w', labelZh: '宽', labelEn: 'Width', value: 900, min: 300, max: 3000, step: 50 },
      { key: 'd', labelZh: '深', labelEn: 'Depth', value: 400, min: 200, max: 900, step: 50 },
      { key: 'shelves', labelZh: '层数', labelEn: 'Shelves', value: 4, min: 2, max: 10, step: 1 },
      { key: 'pitch', labelZh: '层高', labelEn: 'Spacing', value: 400, min: 150, max: 800, step: 25 },
    ],
    build: ({ w, d, shelves, pitch }) => {
      const n = Math.max(2, Math.round(shelves))
      const out: Array<ProfileData | null> = []
      // the lowest ring on the floor, the highest one laid over the posts, the rest let in
      const ring = (y: number, flat = false) => {
        const four = [
          bar(V(0, y, 0), V(w, y, 0), '2020'),
          bar(V(0, y, d), V(w, y, d), '2020'),
          bar(V(0, y, 0), V(0, y, d), '2020'),
          bar(V(w, y, 0), V(w, y, d), '2020'),
        ]
        out.push(...(flat ? four.map(rolled) : four))
      }
      const top = 10 + (n - 1) * pitch
      for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, 0, z), V(x, top, z), '2020'))
      for (let i = 0; i < n - 1; i++) ring(10 + i * pitch)
      ring(top + 10, true)
      return keep(out)
    },
  },
  {
    id: 'cabinet',
    labelZh: '单门柜', labelEn: 'Cabinet',
    noteZh: '一个柜位，配一扇门或几个抽屉都合适',
    noteEn: 'One bay, ready for a door or a stack of drawers',
    params: [
      { key: 'w', labelZh: '宽', labelEn: 'Width', value: 600, min: 300, max: 1200, step: 50 },
      { key: 'd', labelZh: '深', labelEn: 'Depth', value: 600, min: 300, max: 900, step: 50 },
      { key: 'h', labelZh: '高', labelEn: 'Height', value: 800, min: 300, max: 2400, step: 50 },
    ],
    build: ({ w, d, h }) => box(w, d, h, '2020'),
  },
  {
    id: 'rack',
    labelZh: '设备机柜', labelEn: 'Equipment rack',
    noteZh: '19 寸机架宽度，前后各一对立柱',
    noteEn: '19-inch rack width, a pair of posts front and back',
    params: [
      { key: 'u', labelZh: 'U 数', labelEn: 'Units', value: 12, min: 2, max: 47, step: 1 },
      { key: 'd', labelZh: '深', labelEn: 'Depth', value: 600, min: 300, max: 1200, step: 50 },
    ],
    build: ({ u, d }) => {
      const w = 540                      // 19in opening plus the posts either side
      const h = Math.round(u) * 44.45 + 80
      return box(w, d, h, '4040')
    },
  },
  {
    id: 'table',
    labelZh: '桌腿框架', labelEn: 'Table frame',
    noteZh: '只有腿和围框，台面自己配',
    noteEn: 'Legs and an apron; bring your own top',
    params: [
      { key: 'w', labelZh: '长', labelEn: 'Length', value: 1200, min: 400, max: 3000, step: 50 },
      { key: 'd', labelZh: '深', labelEn: 'Depth', value: 600, min: 300, max: 1200, step: 50 },
      { key: 'h', labelZh: '高', labelEn: 'Height', value: 740, min: 400, max: 1100, step: 10 },
    ],
    build: ({ w, d, h }) => {
      const out: Array<ProfileData | null> = []
      for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, 0, z), V(x, h, z), '4040'))
      out.push(...perimeter(w, d, h, 40, 20, '2040'))
      return keep(out)
    },
  },
]

export function templateById(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id)
}
