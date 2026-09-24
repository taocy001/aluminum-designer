import * as THREE from 'three'
import type { ScreenPick } from './screenPick'
import { useToolStore } from '../store/useToolStore'

/**
 * Is this point on the side of the cut that has been taken away?
 *
 * A part that has been cut out of the picture must not be clickable where it used to be.
 * Otherwise the section view is a trap: you look inside a cabinet, click what you can see,
 * and get the door that is no longer drawn.
 */
export function cutAway(v: THREE.Vector3): boolean {
  const s = useToolStore.getState().section
  if (!s) return false
  const at = v[s.axis]
  return s.flip ? at < s.at : at > s.at
}

/**
 * What is actually drawn at a pixel.
 *
 * The screen-space picker is a set of generous radii, and it has to be: a member twenty
 * millimetres across is a couple of pixels at any useful zoom, and asking for that kind of
 * precision is asking for a bad afternoon. But a heuristic that is generous about near misses
 * must not then contradict a direct hit — if a door is drawn at that pixel, clicking there is
 * clicking the door, whatever the ordering would otherwise have preferred.
 *
 * So the real geometry is asked as well, and when it answers with something the picker also
 * found, that answer goes first. The radii still carry every case where nothing was hit
 * squarely, which is most of them.
 */

const raycaster = new THREE.Raycaster()

/**
 * The id of the part whose mesh the ray hits first, or null for empty space.
 *
 * The camera goes in because a fat line — the kind drei draws for guides and dimensions —
 * measures its own thickness in screen space and cannot be intersected without one.
 */
export function frontmostId(scene: THREE.Object3D, ray: THREE.Ray, camera: THREE.Camera): string | null {
  raycaster.set(ray.origin, ray.direction)
  raycaster.camera = camera
  for (const hit of raycaster.intersectObjects(scene.children, true)) {
    if (cutAway(hit.point)) continue
    let o: THREE.Object3D | null = hit.object
    while (o) {
      const d = o.userData as Record<string, string | undefined>
      const id = d.profileId ?? d.panelId ?? d.connectorId ?? d.fittingId
      if (id) return id
      o = o.parent
    }
  }
  return null
}

/** Move the part that is actually drawn at the pixel to the front of the list */
export function promoteFrontmost(list: ScreenPick[], id: string | null): ScreenPick[] {
  if (!id || list.length < 2 || list[0].id === id) return list
  const i = list.findIndex((p) => p.id === id)
  if (i <= 0) return list
  return [list[i], ...list.slice(0, i), ...list.slice(i + 1)]
}
