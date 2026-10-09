import { create } from 'zustand'
import type { ConnectorData } from './useStore'

export type ConnectorEditPreview = Pick<ConnectorData, 'type' | 'series' | 'position' | 'quaternion' | 'panelMount' | 'profileSpec' | 'mountSeries'> & {
  legs: string[]
  allowed: boolean
  conflicts?: string[]
}

/** A temporary installation choice; applying it is a separate document transaction. */
export const useConnectorEditStore = create<{
  slideGuide: { origin: [number, number, number]; axis: [number, number, number]; min: number; max: number } | null
  setSlideGuide: (slideGuide: { origin: [number, number, number]; axis: [number, number, number]; min: number; max: number } | null) => void
  preview: ConnectorEditPreview | null
  setPreview: (preview: ConnectorEditPreview | null) => void
}>((set) => ({ slideGuide: null, setSlideGuide: slideGuide => set({ slideGuide }), preview: null, setPreview: (preview) => set({ preview }) }))
