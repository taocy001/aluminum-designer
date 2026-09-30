import React, { useEffect, useMemo, useState } from 'react'
import { Line } from '@react-three/drei'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { editAlignments } from '../utils/editAlignment'
import type { Axis3 } from '../utils/dragSnap'
import type { ProfileTrims } from '../utils/jointUtils'
import type { ProfileFace } from '../utils/profileFaces'
import { FacePatch } from './SnapFaces'

/** The same final-solid references for a body move, axis arrow, or grabbed cut end. */
const EditAlignmentGuides: React.FC<{ trims: Map<string, ProfileTrims> }> = ({ trims }) => {
  const profiles = useStore((s) => s.profiles)
  const { isDragging, dragProfileId, dragGroupOrigins, dragAxis, dragVertical, dragFree,
    dragMoved, resize, snapGuides, viewMode, held, selectMode, measuring } = useToolStore()
  const [shiftHeld, setShiftHeld] = useState(false)
  useEffect(() => {
    const keyDown = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true) }
    const keyUp = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false) }
    const blur = () => setShiftHeld(false)
    window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur)
    }
  }, [])
  const active = dragMoved && (isDragging || !!resize) && !dragFree && !shiftHeld && !viewMode
    && held !== 'connector' && !selectMode && !measuring
  const relations = useMemo(() => {
    if (!active) return []
    const movingIds = resize ? [resize.id] : Object.keys(dragGroupOrigins)
    if (!movingIds.length && dragProfileId) movingIds.push(dragProfileId)
    const axes: Axis3[] = dragAxis ? [{ x: 0, y: 1, z: 2 }[dragAxis] as Axis3] : dragVertical ? [1] : [0, 2]
    return editAlignments(profiles, trims, { movingIds, axes, guides: snapGuides, resize })
  }, [active, profiles, trims, resize, dragProfileId, dragGroupOrigins, dragAxis, dragVertical, snapGuides])
  if (!relations.length) return null
  const faces = new Map<string, { face: ProfileFace; moving: boolean }>()
  for (const relation of relations) for (const [face, moving] of [[relation.movingFace, true], [relation.referenceFace, false]] as const) {
    if (face) faces.set(`${face.profileId}-${face.axis}-${face.side}`, { face, moving })
  }
  return <>
    {relations.map((relation, i) => <group key={`${relation.axis}-${relation.movingId}-${relation.refId}-${i}`}
      userData={{ editAlignment: true, gesture: resize ? 'resize' : 'move', alignmentKind: relation.kind,
        movingId: relation.movingId, refId: relation.refId, from: relation.from, to: relation.to,
        alignmentLine: relation.line }}>
      <Line points={relation.line} color="#c084fc" lineWidth={1.8} dashed dashSize={8} gapSize={5}
        renderOrder={30} depthTest={false} depthWrite={false} raycast={() => {}} />
    </group>)}
    {[...faces].map(([key, { face, moving }]) => <FacePatch key={key} face={face}
      color={moving ? '#fbbf24' : '#22d3ee'} role={moving ? 'moving' : 'target'} />)}
  </>
}

export default EditAlignmentGuides
