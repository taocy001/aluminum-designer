import { beforeEach, describe, expect, it } from 'vitest'
import { useViewStore, isObjectVisible } from '../store/useViewStore'
import { projectSession } from '../utils/projectSession'

describe('workspace visibility', () => {
  beforeEach(() => useViewStore.getState().restoreAll())
  it('hides, isolates, reveals and restores objects without changing the assembly', () => {
    const view = useViewStore.getState()
    view.hide(['a', 'a']); expect(isObjectVisible('a')).toBe(false)
    expect(isObjectVisible('b')).toBe(true)
    view.isolate(['b']); expect(isObjectVisible('a')).toBe(false)
    expect(isObjectVisible('b')).toBe(true)
    view.reveal(['a']); expect(isObjectVisible('a')).toBe(true)
    expect(isObjectVisible('c')).toBe(false)
    view.restoreAll(); expect(isObjectVisible('c')).toBe(true)
  })
  it('drops per-document visibility when a different document opens', () => {
    useViewStore.getState().hide(['same-id'])
    projectSession.start({ profiles: [], connectors: [], panels: [], fittings: [], equipment: [], throughRule: 'rails' })
    expect(isObjectVisible('same-id')).toBe(true)
    expect(useViewStore.getState().isolatedIds).toBeNull()
  })
})
