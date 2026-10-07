import type { ProfileData } from '../store/useStore'
import type { ProfileTrims } from './jointUtils'
import { profileFace } from './profileFaces'

type Section = { axis: 'x' | 'y' | 'z'; at: number; flip: boolean } | null

/** Whether any of the trimmed member's outside envelope remains in the section view. */
export function connectorSupportVisible(profile: ProfileData, trims: ProfileTrims, section: Section): boolean {
  if (!section) return true
  const axis = section.axis === 'x' ? 0 : section.axis === 'y' ? 1 : 2
  return ([-1, 1] as const).some((side) => profileFace(profile,
    { profileId: profile.id, axis: 2, side }, trims).corners
    .some((point) => section.flip ? point[axis] >= section.at : point[axis] <= section.at))
}
