import React, { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { EquipmentData } from '../store/useStore'
import { useToolStore } from '../store/useToolStore'
import { equipmentBody, equipmentClearance } from '../utils/equipmentGeometry'
import type { EquipmentConflict } from '../utils/equipmentChecks'

/** Transparent equipment body with a non-pickable clearance outline. */
const Equipment: React.FC<EquipmentData & { isSelected?: boolean; conflict?: EquipmentConflict['kind'] }> = (props) => {
  const { id, locked, isSelected = false, conflict } = props
  const hovered = useToolStore((s) => !s.isDragging && s.hoverPartId === id)
  const body = useMemo(() => equipmentBody(props), [props.width, props.height, props.depth, props.position, props.quaternion])
  const reserved = useMemo(() => equipmentClearance(props), [props.width, props.height, props.depth, props.position, props.quaternion, props.clearance])
  const quaternion = useMemo(() => new THREE.Quaternion(...props.quaternion).normalize(), [props.quaternion])
  const geometry = useMemo(() => {
    const box = new THREE.BoxGeometry(body.half.x * 2, body.half.y * 2, body.half.z * 2)
    const clearanceBox = new THREE.BoxGeometry(reserved.half.x * 2, reserved.half.y * 2, reserved.half.z * 2)
    const clearanceEdges = new THREE.EdgesGeometry(clearanceBox)
    clearanceBox.dispose()
    return { box, edges: new THREE.EdgesGeometry(box), clearanceEdges }
  }, [body.half.x, body.half.y, body.half.z, reserved.half.x, reserved.half.y, reserved.half.z])
  useEffect(() => () => { geometry.box.dispose(); geometry.edges.dispose(); geometry.clearanceEdges.dispose() }, [geometry])
  const color = conflict === 'equipment-body' ? '#ef4444' : conflict === 'equipment-clearance' ? '#f59e0b'
    : isSelected ? '#60a5fa' : hovered ? '#99f6e4' : locked ? '#94a3b8' : '#2dd4bf'
  return <>
    <group position={body.center} quaternion={quaternion} userData={{ equipmentId: id }} name={`equipment-${id}`}>
      <mesh geometry={geometry.box} userData={{ labelOccluder: false }}>
        <meshStandardMaterial color={color} transparent opacity={isSelected ? 0.28 : 0.16} depthWrite={false} roughness={0.7} />
      </mesh>
      <lineSegments geometry={geometry.edges} raycast={() => null}>
        <lineBasicMaterial color={color} transparent opacity={0.95} />
      </lineSegments>
    </group>
    {Object.values(props.clearance).some((v) => v > 0) &&
      <lineSegments name={`equipment-clearance-${id}`} position={reserved.center} quaternion={quaternion}
        geometry={geometry.clearanceEdges} raycast={() => null}>
        <lineBasicMaterial color={conflict === 'equipment-clearance' ? '#f59e0b' : '#5eead4'} transparent opacity={0.5} />
      </lineSegments>}
  </>
}

export default React.memo(Equipment)
