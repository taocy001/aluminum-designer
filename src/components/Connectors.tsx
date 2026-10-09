import React, { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useToolStore } from '../store/useToolStore'
import type { ConnectorData } from '../store/useStore'
import { connectorScale } from '../utils/connectorCatalog'
import { connectorMeshes } from '../utils/connectorGeometry'
import { connectorRenderMeshes } from '../utils/connectorRenderGeometry'

type Batch = {
  key: string
  geometry: THREE.BufferGeometry
  color: string
  glow: string
  polished: boolean
  parts: ConnectorData[]
}

function Instances({ batch }: { batch: Batch }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = ref.current!
    const pose = new THREE.Object3D()
    batch.parts.forEach((part, i) => {
      pose.position.set(...part.position)
      pose.quaternion.set(...(part.quaternion ?? [0, 0, 0, 1])).normalize()
      pose.scale.setScalar(connectorScale(part.series ?? 20))
      pose.updateMatrix()
      mesh.setMatrixAt(i, pose.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingBox()
    mesh.computeBoundingSphere()
  }, [batch])
  return <instancedMesh ref={ref} args={[undefined, undefined, batch.parts.length]}
    userData={{ partIds: batch.parts.map(p => p.id) }}>
    <primitive object={batch.geometry} attach="geometry" />
    <meshStandardMaterial color={batch.color} emissive={batch.glow}
      emissiveIntensity={batch.glow === '#000000' ? 0 : 0.9}
      metalness={batch.polished ? 0.8 : 0.3} roughness={batch.polished ? 0.2 : 0.55} />
  </instancedMesh>
}

/** Identical connector solids share a draw call; each instance keeps its own pick identity. */
function Connectors({ parts, selectedIds }: { parts: ConnectorData[]; selectedIds: string[] }) {
  const hover = useToolStore(s => s.isDragging ? null : s.hoverPartId)
  const batches = useMemo(() => {
    const groups = new Map<string, Batch>()
    const selected = new Set(selectedIds)
    for (const part of parts) {
      const state = selected.has(part.id) ? 'selected' : hover === part.id ? 'hover' : 'normal'
      for (const solid of connectorRenderMeshes(connectorMeshes(part.type, part.series ?? 20, part.profileSpec, part.mountSeries, part.panelMount))) {
        const key = `${solid.geometry.uuid}:${state}:${!!solid.dark}:${!!solid.polished}`
        let group = groups.get(key)
        if (!group) {
          group = { key, geometry: solid.geometry, polished: !!solid.polished, parts: [],
            color: state === 'selected' ? '#60a5fa' : state === 'hover' ? '#fbbf24' : solid.dark ? '#1e293b' : '#94a3b8',
            glow: state === 'selected' ? '#1d4ed8' : state === 'hover' ? '#a16207' : '#000000' }
          groups.set(key, group)
        }
        group.parts.push(part)
      }
    }
    return [...groups.values()]
  }, [parts, selectedIds, hover])
  return <>{batches.map(batch => <Instances key={`${batch.key}:${batch.parts.length}`} batch={batch} />)}</>
}

export default React.memo(Connectors)
