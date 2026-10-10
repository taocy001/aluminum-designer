import * as THREE from 'three'
import { getProfileShape, type ProfileSpec } from './profileShapes'

export interface StandardLook {
  color: string
  metalness: number
  roughness: number
  emissive?: string
  emissiveIntensity?: number
  opacity?: number
  transparent?: boolean
}

/** Scene-owned resources. Callers select a look rather than mutate a shared material. */
export class RenderResources {
  private profiles = new Map<ProfileSpec, THREE.ExtrudeGeometry>()
  private standards = new Map<string, THREE.MeshStandardMaterial>()
  private lines = new Map<string, THREE.LineBasicMaterial>()

  profile(spec: ProfileSpec): THREE.ExtrudeGeometry {
    let geometry = this.profiles.get(spec)
    if (!geometry) {
      geometry = new THREE.ExtrudeGeometry(getProfileShape(spec), { depth: 1, bevelEnabled: false })
      geometry.computeVertexNormals()
      this.profiles.set(spec, geometry)
    }
    return geometry
  }

  standard(look: StandardLook): THREE.MeshStandardMaterial {
    const { color, metalness, roughness, emissive = '#000000', emissiveIntensity = 1,
      opacity = 1, transparent = false } = look
    const key = JSON.stringify([color, metalness, roughness, emissive, emissiveIntensity, opacity, transparent])
    let material = this.standards.get(key)
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, metalness, roughness, emissive, emissiveIntensity, opacity, transparent })
      this.standards.set(key, material)
    }
    return material
  }

  line(color: string, opacity: number): THREE.LineBasicMaterial {
    const key = JSON.stringify([color, opacity])
    let material = this.lines.get(key)
    if (!material) {
      material = new THREE.LineBasicMaterial({ color, opacity, transparent: true })
      this.lines.set(key, material)
    }
    return material
  }

  dispose(): void {
    // Keep CPU objects valid for React StrictMode's effect restart; Three uploads them again on reuse.
    for (const resource of [...this.profiles.values(), ...this.standards.values(), ...this.lines.values()]) resource.dispose()
  }
}
