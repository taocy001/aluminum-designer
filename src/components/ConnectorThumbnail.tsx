import React from 'react'
import type { ConnectorSeries } from '../utils/connectorCatalog'
import manifest from '../assets/connectorThumbnails.json'

const images: Record<string, { file: string }> = manifest.images

/** Pre-rendered from the complete canvas meshes; see scripts/generate-connector-thumbnails.mjs. */
const ConnectorThumbnail: React.FC<{ type: string; series?: ConnectorSeries }> = ({ type, series = 20 }) => {
  const image = images[`${type}:${series}`]
  const source = image ? `${import.meta.env.BASE_URL}connector-thumbnails/${image.file}` : undefined
  return <img src={source} alt="" aria-hidden="true" data-connector-model={type}
    width={168} height={168} className="h-6 w-6 object-contain" draggable={false} />
}

export default React.memo(ConnectorThumbnail)
