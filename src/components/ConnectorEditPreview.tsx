import { placementObstacles } from '../utils/placementObstacles'
import { obbCorners } from '../utils/obb'
import { Html, Line } from '@react-three/drei'
import * as THREE from 'three'
import { useConnectorEditStore } from '../store/useConnectorEditStore'
import { useStore } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { computeTrims } from '../utils/jointUtils'
import { profileBodyEndpoints } from '../utils/profileFaces'
import Connector from './Connector'
import SnapMarker from './SnapMarker'
import ConnectorSeatGuides from './ConnectorSeatGuides'

export default function ConnectorEditPreview() {
  const preview = useConnectorEditStore((state) => state.preview)
  const guide = useConnectorEditStore(state => state.slideGuide)
  const language = useToolStore(state => state.language)
  const doc = useStore()
  const { profiles } = doc
  const viewMode = useToolStore((state) => state.viewMode)
  const isDragging = useToolStore((state) => state.isDragging)
  if ((!preview && !guide) || viewMode || isDragging) return null
  const at = (distance: number) => new THREE.Vector3(...guide!.origin).addScaledVector(new THREE.Vector3(...guide!.axis), distance)
  return <group userData={{ connectorEditPreview: true, seatLegs: preview?.legs }}>
    {guide && <group>
      <Line points={[at(guide.min), at(guide.max)]} color="#22d3ee" lineWidth={3} depthTest={false} raycast={() => null} />
      <Html position={at(0)} center style={{ pointerEvents: 'none', whiteSpace: 'nowrap', transform: 'translateY(-24px)' }}>
        <span className="rounded bg-slate-950/90 px-2 py-1 text-xs text-cyan-200">{language === 'zh' ? '沿槽' : 'Slot'}: {guide.min.toFixed(1)} … +{guide.max.toFixed(1)} mm</span>
      </Html>
      <Html position={at(guide.max)} center style={{ pointerEvents: 'none' }}><span className="rounded bg-cyan-950 px-1 text-cyan-200">+</span></Html>
      <Html position={at(guide.min)} center style={{ pointerEvents: 'none' }}><span className="rounded bg-cyan-950 px-1 text-cyan-200">−</span></Html>
    </group>}
    {preview && <>
    <Connector {...preview} preview previewState={preview.allowed ? 'valid' : 'blocked'} />
    {!!preview.conflicts?.length && placementObstacles({ id: '__preview__', ...preview }, doc)
      .filter(o => preview.conflicts!.includes(o.id)).map((o, i) => {
        const points = obbCorners(o.body)
        return <group key={`${o.id}-${i}`} userData={{ obstruction: o.id }}>{points.flatMap((p, j) => points.slice(j + 1).flatMap((q, k) => {
          const difference = j ^ (j + k + 1)
          return (difference & (difference - 1)) === 0 ? <Line key={`${j}-${k}`} points={[p, q]} color="#fb7185" lineWidth={2} depthTest={false} raycast={() => null} /> : []
        }))}</group>
      })}
    <SnapMarker position={preview.position} kind={preview.allowed ? 'seat' : 'loose'} size={0.055} />
    <ConnectorSeatGuides connector={preview} legs={preview.legs} profiles={profiles} />
    {preview.legs.map((id) => {
      const profile = profiles.find((part) => part.id === id)
      if (!profile) return null
      const ends = profileBodyEndpoints(profile, computeTrims(profile, profiles))
      return <Line key={id} points={[ends.start, ends.end]} color="#67e8f9" lineWidth={3}
        transparent opacity={0.65} depthTest={false} depthWrite={false} raycast={() => null} />
    })}
    </>}
  </group>
}
