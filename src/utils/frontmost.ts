import * as THREE from 'three'
import type { ScreenPick } from './screenPick'
import { useToolStore } from '../store/useToolStore'

/** Test whether a point lies on the clipped side of the section plane. */
export function cutAway(v: THREE.Vector3): boolean {
  const s = useToolStore.getState().section
  if (!s) return false
  const at = v[s.axis]
  return s.flip ? at < s.at : at > s.at
}

const raycaster = new THREE.Raycaster()

/** Resolve ordinary meshes and instanced solids to the document part they display. */
export function hitPartId(hit: Pick<THREE.Intersection, 'object' | 'instanceId'>): string | null {
  if (hit.instanceId !== undefined) {
    const id = hit.object.userData.partIds?.[hit.instanceId]
    if (typeof id === 'string') return id
  }
  let object: THREE.Object3D | null = hit.object
  while (object) {
    const d = object.userData
    const id = d.profileId ?? d.panelId ?? d.connectorId ?? d.fittingId ?? d.equipmentId
    if (id) return id
    object = object.parent
  }
  return null
}

/**
 * The nearest visible part mesh, or null for empty space. Wide lines require a camera
 * for raycasting; sectioned-away intersections are excluded.
 */
export function frontmostId(scene: THREE.Object3D, ray: THREE.Ray, camera: THREE.Camera): string | null {
  raycaster.set(ray.origin, ray.direction)
  raycaster.camera = camera
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    if (cutAway(hit.point)) continue
    const id = hitPartId(hit)
    if (id) return id
  }
  return null
}

/** Prefer a direct mesh hit over tolerance matches; preserve the remaining cycling order. */
export function promoteFrontmost(list: ScreenPick[], id: string | null): ScreenPick[] {
  if (!id || list.length < 2 || list[0].id === id) return list
  const i = list.findIndex((p) => p.id === id)
  if (i <= 0) return list
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)]
}
