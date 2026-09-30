import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { Html, Line } from '@react-three/drei'
import type { Language } from '../store/useToolStore'
import type { DrawingContact } from '../utils/drawContacts'
import type { FacePoint } from '../utils/profileFaces'
import { FacePatch } from './SnapFaces'
import SnapMarker from './SnapMarker'

const MEMBER_COLOR = '#fbbf24'
const REFERENCE_COLOR = '#22d3ee'
const REJECTED_COLOR = '#fb7185'
const ignoreRaycast = () => {}

/** The finite area shared by the two solids, separate from the complete face outlines. */
const ContactPatch: React.FC<{ points: FacePoint[]; normal: FacePoint }> = ({ points, normal }) => {
  const { geometry, border } = useMemo(() => {
    const lift = new THREE.Vector3(...normal).multiplyScalar(0.5)
    const vertices = points.map((point) => new THREE.Vector3(...point).add(lift).toArray() as FacePoint)
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3))
    const triangles: number[] = []
    for (let i = 1; i < vertices.length - 1; i++) triangles.push(0, i, i + 1)
    geometry.setIndex(triangles)
    return { geometry, border: [...vertices, vertices[0]] }
  }, [points, normal])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <group userData={{ drawingContactPatch: true, contactPolygon: points }}>
    <mesh geometry={geometry} renderOrder={32} raycast={ignoreRaycast}>
      <meshBasicMaterial color={MEMBER_COLOR} transparent opacity={0.25}
        side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
    </mesh>
    <Line points={border} color={REFERENCE_COLOR} lineWidth={4} renderOrder={33}
      depthTest={false} depthWrite={false} raycast={ignoreRaycast} />
    <Line points={border} color={MEMBER_COLOR} lineWidth={1.8} renderOrder={34}
      depthTest={false} depthWrite={false} raycast={ignoreRaycast} />
  </group>
}

/** Match drag feedback: the new member is amber, the existing reference is cyan. */
export const DrawContactGuides: React.FC<{ contacts: DrawingContact[]; language: Language }> = ({ contacts, language }) => <>
  {contacts.map((contact) => {
    const { end, kind, referenceFace, memberFace, referenceAnchor, memberAnchor, patch } = contact
    const rejected = kind === 'rejected'
    const touching = kind === 'contact'
    const anchor = rejected ? referenceAnchor : memberAnchor
    const label = language === 'zh' ? (end === 'start' ? '起' : '终') : (end === 'start' ? 'Start' : 'End')
    const color = rejected ? REJECTED_COLOR : MEMBER_COLOR
    const hasSpan = new THREE.Vector3(...referenceAnchor).distanceToSquared(new THREE.Vector3(...memberAnchor)) > 1e-6
    return <group key={`${end}-${referenceFace.profileId}-${kind}`} userData={{
      drawingContact: true, end, kind, referenceAnchor, memberAnchor,
      referenceFace: { profileId: referenceFace.profileId, axis: referenceFace.axis, side: referenceFace.side },
      memberFace: memberFace && { profileId: memberFace.profileId, axis: memberFace.axis, side: memberFace.side },
      patch,
    }}>
      <FacePatch face={referenceFace} anchor={referenceAnchor} color={rejected ? REJECTED_COLOR : REFERENCE_COLOR}
        role={rejected ? 'rejected' : 'target'} showNormal={kind !== 'align'} fillOpacity={0.09}
        lineWidth={4} renderOrder={25} />
      {/* The wider cyan outline remains visible around amber even when both faces coincide. */}
      {!rejected && memberFace && <FacePatch face={memberFace} anchor={memberAnchor} color={MEMBER_COLOR}
        role="moving" showNormal={kind !== 'align'} fillOpacity={0.09} lineWidth={1.8} renderOrder={28} />}
      {!rejected && !touching && hasSpan && <Line points={[referenceAnchor, memberAnchor]}
        color={REFERENCE_COLOR} lineWidth={1.5} dashed dashSize={8} gapSize={5}
        depthTest={false} depthWrite={false} renderOrder={31} raycast={ignoreRaycast} />}
      {touching && patch && patch.length >= 3 && <ContactPatch points={patch} normal={referenceFace.normal} />}
      {touching && <SnapMarker position={memberAnchor} kind="contact" size={0.022} />}
      <Html position={anchor} zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
        <div data-testid={`draw-contact-${end}`} data-kind={kind}
          style={{ color, borderColor: `${color}66`, transform: end === 'start' ? 'translate(calc(-100% - 12px), -50%)' : 'translate(12px, -50%)' }}
          className="pointer-events-none select-none whitespace-nowrap rounded border bg-slate-900/85 px-1.5 py-0.5 text-[10px] font-bold leading-tight">
          {label}
        </div>
      </Html>
    </group>
  })}
</>

export default DrawContactGuides
