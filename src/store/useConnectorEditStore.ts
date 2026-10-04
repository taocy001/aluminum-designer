import { create } from 'zustand'
import type { ConnectorData } from './useStore'

export type ConnectorEditPreview = Pick<ConnectorData, 'type' | 'series' | 'position' | 'quaternion'> & {
  legs: string[]
  allowed: boolean
}

/** A temporary installation choice; applying it is a separate document transaction. */
export const useConnectorEditStore = create<{
  preview: ConnectorEditPreview | null
  setPreview: (preview: ConnectorEditPreview | null) => void
}>((set) => ({ preview: null, setPreview: (preview) => set({ preview }) }))
