import { useMemo } from 'react'
import type { ConnectorData, FittingData, PanelData, ProfileData } from '../store/useStore'
import { connectorOBB, panelOBB, trimmedOBB } from '../utils/analysis'
import type { ProfileTrims } from '../utils/jointUtils'
import { fittingParts, fittingSolids } from '../utils/fittingGeometry'
import { fittingBoardNumber, partNumber } from '../utils/partNumbers'
import TextSprite from './TextSprite'

interface Props {
  profiles: ProfileData[]
  connectors: ConnectorData[]
  panels: PanelData[]
  fittings: FittingData[]
  trims: Map<string, ProfileTrims>
}

/** Labels follow the displayed parts, including moving door and drawer boards. */
export default function PartNumberLabels({ profiles, connectors, panels, fittings, trims }: Props) {
  const labels = useMemo(() => [
    ...profiles.flatMap((p) => {
      const trim = trims.get(p.id)
      return trim ? [{ owner: p.id, text: partNumber('profile', p.id), at: trimmedOBB(p, trim).center }] : []
    }),
    ...connectors.map((c) => ({ owner: c.id, text: partNumber('connector', c.id), at: connectorOBB(c).center })),
    ...panels.map((b) => ({ owner: b.id, text: partNumber('panel', b.id), at: panelOBB(b).center })),
    ...fittings.flatMap((f) => {
      const solids = fittingSolids(f)
      return fittingParts(f).boards.map((b, i) => ({ owner: f.id, text: fittingBoardNumber(f.id, b.key), at: solids[i].center }))
    }),
  ], [profiles, connectors, panels, fittings, trims])
  return <>{labels.map((label) => <TextSprite key={label.text} owner={label.owner} text={label.text}
    position={label.at.toArray()} height={18} priority={2} color="#67e8f9" />)}</>
}
