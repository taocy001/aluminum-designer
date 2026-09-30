import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { Line } from '@react-three/drei'
import type { FacePoint, ProfileFace } from '../utils/profileFaces'

const ignoreRaycast = () => {}

/** A visible attachment face without introducing a new surface that can capture the pointer. */
export const FacePatch: React.FC<{
  face: ProfileFace
  color?: string
  role?: string
  anchor?: FacePoint
  showNormal?: boolean
  fillOpacity?: number
  lineWidth?: number
  renderOrder?: number
}> = ({
  face, color = '#22d3ee', role = 'target', anchor, showNormal = true,
  fillOpacity = 0.19, lineWidth = 2.5, renderOrder = 25,
}) => {
  const { geometry, border, center, tip } = useMemo(() => {
    const normal = new THREE.Vector3(...face.normal)
    const lift = normal.clone().multiplyScalar(0.35)
    const points = face.corners.map((point) => new THREE.Vector3(...point).add(lift))
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(points.flatMap((point) => point.toArray()), 3))
    geometry.setIndex([0, 1, 2, 0, 2, 3])
    const center = new THREE.Vector3(...(anchor ?? face.center)).add(lift)
    const shortest = Math.min(points[0].distanceTo(points[1]), points[1].distanceTo(points[2]))
    const tip = center.clone().addScaledVector(normal, THREE.MathUtils.clamp(shortest * 0.6, 12, 30))
    return {
      geometry, border: [...points, points[0]].map((point) => point.toArray() as FacePoint),
      center: center.toArray() as FacePoint, tip: tip.toArray() as FacePoint,
    }
  }, [face, anchor])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <group userData={{ snapFace: true, faceRole: role, faceProfileId: face.profileId, faceAxis: face.axis, faceSide: face.side,
      faceAnchor: anchor ?? face.center }}>
      <mesh geometry={geometry} renderOrder={renderOrder} raycast={ignoreRaycast}>
        <meshBasicMaterial color={color} transparent opacity={fillOpacity} side={THREE.DoubleSide} depthTest={false} depthWrite={false} />
      </mesh>
      <Line points={border} color={color} lineWidth={lineWidth} transparent opacity={0.95}
        depthTest={false} depthWrite={false} renderOrder={renderOrder + 1} raycast={ignoreRaycast} />
      {showNormal && <>
        <Line points={[center, tip]} color={color} lineWidth={2} depthTest={false} depthWrite={false}
          renderOrder={renderOrder + 1} raycast={ignoreRaycast} />
        <mesh position={tip} renderOrder={renderOrder + 2} raycast={ignoreRaycast}>
          <sphereGeometry args={[1.8, 8, 6]} />
          <meshBasicMaterial color={color} depthTest={false} depthWrite={false} />
        </mesh>
      </>}
    </group>
  )
}
