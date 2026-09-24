import React, { useMemo, useEffect } from 'react'
import * as THREE from 'three'
import { useToolStore } from '../store/useToolStore'
import { useStore } from '../store/useStore'
import { getProfileShape } from '../utils/profileShapes'
import { computeTrims } from '../utils/jointUtils'
import { getProfileEndpoints, getProfileDir } from '../utils/geometryCore'
import SnapMarker from './SnapMarker'
import TextSprite from './TextSprite'

/**
 * The suggested member, drawn where it would go and at the length it would be cut to, in a
 * colour nothing else uses. It is a picture, not a part: it takes no pointer events and
 * carries no part id, so nothing but the suggestion's own click test can find it.
 */
const SuggestionGhost: React.FC = () => {
  const suggestion = useToolStore((s) => s.suggestion)
  const member = suggestion?.cand.member ?? null
  const profiles = useStore((s) => s.profiles)

  const view = useMemo(() => {
    if (!member) return null
    const trims = computeTrims(member, [...profiles, member])
    const quat = new THREE.Quaternion(...member.quaternion).normalize()
    const dir = getProfileDir(member)
    const { start, end } = getProfileEndpoints(member)
    const meshPos = start.clone().addScaledVector(dir, trims.start.trim)
    const cut = Math.max(1, trims.cutLength)
    const joints: THREE.Vector3[] = []
    if (trims.start.partners > 0) joints.push(start)
    if (trims.end.partners > 0) joints.push(end)
    const mid = start.clone().add(end).multiplyScalar(0.5)
    return { quat, meshPos, cut, joints, mid }
  }, [member, profiles])

  const geometry = useMemo(() => {
    if (!member) return null
    return new THREE.ExtrudeGeometry(getProfileShape(member.spec), { depth: 1, bevelEnabled: false })
  }, [member])
  useEffect(() => () => geometry?.dispose(), [geometry])

  if (!member || !view || !geometry) return null
  return (
    <group name="suggestion-ghost">
      <mesh position={view.meshPos} quaternion={view.quat} scale={[1, 1, view.cut]} geometry={geometry} raycast={() => null} renderOrder={10}>
        <meshStandardMaterial color="#34d399" emissive="#065f46" emissiveIntensity={0.6} transparent opacity={0.45} depthWrite={false} />
      </mesh>
      {view.joints.map((p, i) => <SnapMarker key={i} position={p} kind="seat" />)}
      <TextSprite text={`${member.spec} · ${Math.round(view.cut)}`} color="#6ee7b7" throughWalls height={24}
        position={[view.mid.x, view.mid.y + 40, view.mid.z]} priority={3} />
    </group>
  )
}

export default SuggestionGhost
