import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { TransformControls } from '@react-three/drei'
import { useStore, type ConnectorData, type ProfileData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { selectionPivot } from '../utils/editOps'
import { lowestPointY } from '../utils/profileFactory'

/**
 * Shared handle state so PointerRouter can tell a press on the rotation handles from a
 * press on the model. `axis` is read straight off the controls at press time — polling a
 * cached flag goes stale as soon as the pointer leaves a handle without another event.
 */
export const gizmoState = {
  busy: false,
  enabled: true,
  instance: null as { axis: string | null } | null,
  /** the gizmo's own pick geometry — PointerRouter ray-tests it instead of trusting event order */
  picker: null as THREE.Object3D | null,
}

/** true when the ray would land on a rotation handle */
export function gizmoOwnsRay(ray: THREE.Ray): boolean {
  if (!gizmoState.enabled || !gizmoState.picker) return false
  const raycaster = new THREE.Raycaster()
  raycaster.ray.copy(ray)
  return raycaster.intersectObject(gizmoState.picker, true).length > 0
}

/**
 * three's rotate gizmo ships an invisible ball ("XYZE"/"E" pickers) for free rotation that
 * covers everything inside the rings. It would swallow every click on the model behind it,
 * so the ball is removed and only the three axis arcs stay grabbable.
 */
function trimFreeRotationPicker(controls: Record<string, any>): void {
  const gizmo = controls._gizmo ?? controls.gizmo
  const rotate = gizmo?.picker?.rotate
  if (!rotate) return
  for (const child of [...rotate.children]) {
    if (child.name === 'XYZE' || child.name === 'E') rotate.remove(child)
  }
  gizmoState.picker = rotate
}

interface Snapshot {
  pivot: THREE.Vector3
  startQuat: THREE.Quaternion
  profiles: ProfileData[]
  connectors: ConnectorData[]
}

/**
 * On-canvas rotation handles for the current selection, the way CAD tools do it:
 * select a part, drag an arc to turn it. Snapping is 5° unless Shift is held.
 */
const RotateGizmo: React.FC = () => {
  const [anchorObj, setAnchorObj] = useState<THREE.Object3D | null>(null)
  const anchor = useRef<THREE.Object3D | null>(null)
  const controls = useRef<{ axis: string | null } | null>(null)
  const snapshot = useRef<Snapshot | null>(null)
  const committed = useRef(false)
  const selectedIds = useStore((s) => s.selectedIds)
  const profiles = useStore((s) => s.profiles)
  const connectors = useStore((s) => s.connectors)
  const viewMode = useToolStore((s) => s.viewMode)
  const selectMode = useToolStore((s) => s.selectMode)
  const isDragging = useToolStore((s) => s.isDragging)
  const showGizmo = useToolStore((s) => s.showGizmo)
  const suppressed = useToolStore((s) => s.gizmoSuppressed)

  const selection = useMemo(() => {
    const ids = new Set(selectedIds)
    return {
      profiles: profiles.filter((p) => ids.has(p.id)),
      connectors: connectors.filter((c) => ids.has(c.id)),
    }
  }, [selectedIds, profiles, connectors])

  const pivot = useMemo(
    () => selectionPivot(selection.profiles, selection.connectors),
    [selection],
  )

  const active = showGizmo && viewMode === 'navigate' && !selectMode && !isDragging && selectedIds.length > 0

  // Holding Ctrl/Cmd is a selection gesture, so the handles step aside and let the click through
  const [modifierHeld, setModifierHeld] = useState(false)
  useEffect(() => {
    const sync = (e: KeyboardEvent) => setModifierHeld(e.ctrlKey || e.metaKey)
    window.addEventListener('keydown', sync)
    window.addEventListener('keyup', sync)
    return () => { window.removeEventListener('keydown', sync); window.removeEventListener('keyup', sync) }
  }, [])
  const handlesLive = !modifierHeld && !suppressed
  useEffect(() => { gizmoState.enabled = handlesLive }, [handlesLive])

  // keep the anchor at the selection centre while idle
  useEffect(() => {
    if (!anchor.current || snapshot.current) return
    anchor.current.position.copy(pivot)
    anchor.current.quaternion.identity()
  }, [pivot, active])

  useEffect(() => {
    if (active) return
    // only clear when the handles are actually gone; the ref callback owns the live values
    gizmoState.busy = false
    gizmoState.instance = null
    gizmoState.picker = null
  }, [active])

  const onMouseDown = useCallback(() => {
    gizmoState.busy = true
    const store = useStore.getState()
    const ids = new Set(store.selectedIds)
    snapshot.current = {
      pivot: pivot.clone(),
      startQuat: anchor.current ? anchor.current.quaternion.clone() : new THREE.Quaternion(),
      profiles: store.profiles.filter((p) => ids.has(p.id)).map((p) => ({ ...p })),
      connectors: store.connectors.filter((c) => ids.has(c.id)).map((c) => ({ ...c })),
    }
    committed.current = false   // history entry waits for the first real turn
  }, [pivot])

  const onObjectChange = useCallback(() => {
    const snap = snapshot.current
    if (!snap || !anchor.current) return
    const delta = anchor.current.quaternion.clone().multiply(snap.startQuat.clone().invert())
    if (Math.abs(delta.w) > 0.999999) return            // the handle was touched but not turned
    if (!committed.current) { committed.current = true; useStore.getState().snapshotHistory() }
    const spin = (pos: [number, number, number], quat: [number, number, number, number]) => {
      const p = new THREE.Vector3(...pos).sub(snap.pivot).applyQuaternion(delta).add(snap.pivot)
      const q = delta.clone().multiply(new THREE.Quaternion(...quat)).normalize()
      return { position: [p.x, p.y, p.z] as [number, number, number], quaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number] }
    }

    const profileUpdates = snap.profiles.map((p) => ({ id: p.id, updates: spin(p.position, p.quaternion) }))
    const connectorUpdates = snap.connectors.map((c) => ({ id: c.id, updates: spin(c.position, c.quaternion) }))

    // never turn the selection into the ground — connectors included
    let sink = 0
    snap.profiles.forEach((p, i) => { sink = Math.min(sink, lowestPointY({ ...p, ...profileUpdates[i].updates })) })
    connectorUpdates.forEach((u) => { sink = Math.min(sink, u.updates.position[1]) })
    if (sink < 0) {
      for (const u of [...profileUpdates, ...connectorUpdates]) u.updates.position[1] -= sink
    }

    const store = useStore.getState()
    store.updateProfiles(profileUpdates)
    for (const u of connectorUpdates) store.updateConnector(u.id, u.updates)
  }, [])

  const onMouseUp = useCallback(() => {
    gizmoState.busy = false
    snapshot.current = null
    const store = useStore.getState()
    const ids = new Set(store.selectedIds)
    if (anchor.current) {
      anchor.current.position.copy(selectionPivot(
        store.profiles.filter((p) => ids.has(p.id)),
        store.connectors.filter((c) => ids.has(c.id)),
      ))
      anchor.current.quaternion.identity()
    }
  }, [])

  return (
    <>
      <object3D ref={(o) => { anchor.current = o; setAnchorObj(o) }} />
      {active && anchorObj && (
        <TransformControls
          ref={(c) => {
            controls.current = c as unknown as { axis: string | null } | null
            gizmoState.instance = controls.current
            if (c) trimFreeRotationPicker(c as unknown as Record<string, any>)
          }}
          object={anchorObj}
          mode="rotate"
          enabled={handlesLive}
          size={0.45}
          rotationSnap={THREE.MathUtils.degToRad(5)}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onObjectChange={onObjectChange}
        />
      )}
    </>
  )
}

export default RotateGizmo
