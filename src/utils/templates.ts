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

/** four posts and a rectangle of rails top and bottom — the shape nearly everything starts as */
function box(w: number, d: number, h: number, spec: ProfileSpec, bottomY = 0): ProfileData[] {
  const out: Array<ProfileData | null> = []
  for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, bottomY, z), V(x, bottomY + h, z), spec))
  for (const y of [bottomY, bottomY + h]) {
    out.push(bar(V(0, y, 0), V(w, y, 0), spec))
    out.push(bar(V(0, y, d), V(w, y, d), spec))
    out.push(bar(V(0, y, 0), V(0, y, d), spec))
    out.push(bar(V(w, y, 0), V(w, y, d), spec))
  }
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
      for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, 0, z), V(x, h, z), '4040'))
      for (const y of [40, h]) out.push(...perimeter(w, d, y, 40, 20, '2040'))
      // one rail across the middle so a long top does not sag
      if (w > 1200) out.push(bar(V(w / 2, h, 0), V(w / 2, h, d), '2040'))
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
      const h = pitch * (n - 1) + 40
      const out: Array<ProfileData | null> = []
      for (const x of [0, w]) for (const z of [0, d]) out.push(bar(V(x, 0, z), V(x, h, z), '2020'))
      for (let i = 0; i < n; i++) {
        const y = 40 + i * pitch
        out.push(bar(V(0, y, 0), V(w, y, 0), '2020'))
        out.push(bar(V(0, y, d), V(w, y, d), '2020'))
        out.push(bar(V(0, y, 0), V(0, y, d), '2020'))
        out.push(bar(V(w, y, 0), V(w, y, d), '2020'))
      }
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
