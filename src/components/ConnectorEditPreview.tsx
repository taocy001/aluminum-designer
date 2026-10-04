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
  const profiles = useStore((state) => state.profiles)
  const viewMode = useToolStore((state) => state.viewMode)
  const isDragging = useToolStore((state) => state.isDragging)
  if (!preview || viewMode || isDragging) return null
  return <group userData={{ connectorEditPreview: true, seatLegs: preview.legs }}>
    <Connector {...preview} preview />
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
