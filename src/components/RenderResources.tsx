import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { RenderResources, type StandardLook } from '../utils/renderResources'

const Context = createContext<RenderResources | null>(null)

export function RenderResourceProvider({ children }: { children: ReactNode }) {
  const [resources] = useState(() => new RenderResources())
  useEffect(() => () => resources.dispose(), [resources])
  return <Context.Provider value={resources}>{children}</Context.Provider>
}

export function useRenderResources(): RenderResources {
  const resources = useContext(Context)
  if (!resources) throw new Error('Scene resources require RenderResourceProvider')
  return resources
}

export function SharedStandardMaterial(look: StandardLook) {
  return <primitive attach="material" object={useRenderResources().standard(look)} />
}

export function SharedLineMaterial({ color, opacity }: { color: string; opacity: number }) {
  return <primitive attach="material" object={useRenderResources().line(color, opacity)} />
}
