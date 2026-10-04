import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import * as THREE from 'three'
import type { ConnectorData, ProfileData } from '../store/useStore'
import { connectorMounts, connectorScale, seriesOf } from '../utils/connectorCatalog'
import { computeAllTrims } from '../utils/jointUtils'
import { profileBodyEndpoints, profileFace } from '../utils/profileFaces'
import { innerInset } from '../utils/bracketSeat'
import { specDims } from '../utils/specUtils'

/** Mark each bolt's actual mounting face and slot, including the two slots of a wide face. */
export default function ConnectorSeatGuides({ connector, legs, profiles }: {
  connector: Pick<ConnectorData, 'type' | 'position' | 'quaternion' | 'series'>
  legs: readonly string[]
  profiles: ProfileData[]
}) {
  const guides = useMemo(() => {
    const q = new THREE.Quaternion(...connector.quaternion).normalize()
    const origin = new THREE.Vector3(...connector.position), scale = connectorScale(connector.series ?? 20)
    const trims = computeAllTrims(profiles)
    return connectorMounts(connector.type, connector.series ?? 20).flatMap((mount) => {
      const along = new THREE.Vector3().setComponent(mount.axis === 'x' ? 0 : mount.axis === 'y' ? 1 : 2, 1).applyQuaternion(q)
      const normal = new THREE.Vector3().setComponent(mount.normal === 'x' ? 0 : mount.normal === 'y' ? 1 : 2, 1).applyQuaternion(q)
      return mount.bolts.flatMap((bolt) => {
        const mountingPoint = new THREE.Vector3(...bolt).multiplyScalar(scale).applyQuaternion(q).add(origin)
        return profiles.filter((profile) => legs.includes(profile.id)).flatMap((profile) => {
          const point = mountingPoint.clone()
          if (connector.type === 'inside-corner') point.addScaledVector(normal, innerInset(seriesOf(profile.spec), mount.normal === 'x' ? 'x' : 'y'))
          const pq = new THREE.Quaternion(...profile.quaternion).normalize(), inverse = pq.clone().invert()
          if (Math.abs(new THREE.Vector3(0, 0, 1).applyQuaternion(pq).dot(along)) < 0.999) return []
          const local = point.clone().sub(new THREE.Vector3(...profile.position)).applyQuaternion(inverse)
          const localNormal = normal.clone().applyQuaternion(inverse), dims = specDims(profile.spec)
          const axis = Math.abs(localNormal.x) > 0.999 ? 0 : Math.abs(localNormal.y) > 0.999 ? 1 : null
          if (axis === null) return []
          const side = localNormal.getComponent(axis) > 0 ? 1 : -1
          if (Math.abs(local.getComponent(axis) - (axis === 0 ? dims.hw : dims.hh) * side) > 1) return []
          const face = profileFace(profile, { profileId: profile.id, axis, side }, trims.get(profile.id))
          const ends = profileBodyEndpoints(profile, trims.get(profile.id))
          const dir = ends.end.clone().sub(ends.start).normalize()
          const from = ends.start.clone().sub(point).dot(dir), to = ends.end.clone().sub(point).dot(dir)
          if (from > 1 || to < -1) return []
          return [{ profileId: profile.id, point, face, line: [point.clone().addScaledVector(dir, from), point.clone().addScaledVector(dir, to)] }]
        })
      })
    })
  }, [connector, legs, profiles])
  return <group>
    {guides.map((guide, index) => <group key={index}
      userData={{ connectorSlotGuide: true, profileId: guide.profileId, point: guide.point.toArray() }}>
      <Line points={[...guide.face.corners, guide.face.corners[0]]} color="#67e8f9" lineWidth={1}
        transparent opacity={0.4} depthTest={false} depthWrite={false} raycast={() => null} />
      <Line points={guide.line} color="#fbbf24" lineWidth={2.5}
        transparent opacity={0.85} depthTest={false} depthWrite={false} raycast={() => null} />
      <mesh position={guide.point} raycast={() => null} renderOrder={10}>
        <sphereGeometry args={[2, 12, 8]} />
        <meshBasicMaterial color="#fef3c7" depthTest={false} depthWrite={false} />
      </mesh>
    </group>)}
  </group>
}
