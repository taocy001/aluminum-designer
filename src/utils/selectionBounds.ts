import type { ProjectGeometry } from './document'
import { panelOBB, trimmedOBB } from './analysis'
import { connectorSolidTop } from './connectorGeometry'
import { fittingSolids } from './fittingGeometry'
import { createTrimResolver, type ProfileTrims } from './jointUtils'
import type { OBB } from './obb'
import { equipmentBody } from './equipmentGeometry'

/** Highest point of the actual selected solids, including end cuts and section rotation. */
export function selectedSolidTop(document: ProjectGeometry, selectedIds: readonly string[], trims?: Map<string, ProfileTrims>): number | null {
  const ids = new Set(selectedIds)
  if (!ids.size) return null
  let top = -Infinity
  const consider = (box: OBB) => {
    const extent = box.axes.reduce((sum, axis, i) => sum + Math.abs(axis.y) * box.half.getComponent(i), 0)
    top = Math.max(top, box.center.y + extent)
  }
  let resolve: ReturnType<typeof createTrimResolver> | undefined
  for (const part of document.profiles) if (ids.has(part.id)) {
    const cut = trims?.get(part.id) ?? (resolve ??= createTrimResolver(document.profiles))(part)
    consider(trimmedOBB(part, cut))
  }
  for (const part of document.connectors) if (ids.has(part.id)) top = Math.max(top, connectorSolidTop(part))
  for (const part of document.panels) if (ids.has(part.id)) consider(panelOBB(part))
  for (const part of document.fittings) if (ids.has(part.id)) for (const solid of fittingSolids(part)) consider(solid)
  for (const part of document.equipment ?? []) if (ids.has(part.id)) consider(equipmentBody(part))
  return Number.isFinite(top) ? Math.round(top * 1000) / 1000 : null
}
