import { placementObstacles } from '../utils/placementObstacles'
import { obbCorners } from '../utils/obb'
import { Line } from '@react-three/drei'
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
  const doc = useStore()
  const { profiles } = doc
  const viewMode = useToolStore((state) => state.viewMode)
  const isDragging = useToolStore((state) => state.isDragging)
  if (!preview || viewMode || isDragging) return null
  return <group userData={{ connectorEditPreview: true, seatLegs: preview.legs }}>
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
  </group>
}
