import { ACCURIDE_3832E, runnerVariant } from './drawerRunnerCatalog'
import type { DrawerConfig, DrawerReinforcement, FittingData } from '../store/useStore'

export const RUNNER_CLEARANCE = 12.5
export const FRONT_GAP = 3
export const BOX_BOARD = 15
export const DRAWER_REAR_CLEARANCE = 20
export const FRONT_BOARD = 18
export const DEFAULT_REINFORCEMENT: DrawerReinforcement = { count: 0, width: 40, height: 20 }

type DrawerOpening = Pick<FittingData, 'width' | 'height' | 'depth' | 'frame' | 'overlay' | 'drawer'>
export type ResolvedDrawerConfig = Required<Omit<DrawerConfig, 'reinforcement'>> & { reinforcement: DrawerReinforcement }

/** Shared closed-box dimensions and runner envelope, in the opening's local frame. */
export function drawerLayout(f: DrawerOpening) {
  const input = f.drawer ?? {}
  const runnerModel = input.runnerModel ?? 'custom'
  const catalog = runnerModel === ACCURIDE_3832E.id
  const sideClearance = input.sideClearance ?? (catalog ? ACCURIDE_3832E.sideClearance.nominal : RUNNER_CLEARANCE)
  const boxThickness = input.boxThickness ?? BOX_BOARD
  const bottomThickness = input.bottomThickness ?? BOX_BOARD
  const rearClearance = input.rearClearance ?? DRAWER_REAR_CLEARANCE
  const reinforcement = { ...DEFAULT_REINFORCEMENT, ...input.reinforcement }
  const boxWidth = f.width - 2 * sideClearance
  const boxHeight = Math.max(40, f.height - 2 * FRONT_GAP - 20)
  const backZ = -f.depth / 2 + rearClearance
  const frontZ = f.depth / 2 + (f.frame ?? 0) - (f.overlay === 'inset' ? FRONT_BOARD : 0)
  const boxDepth = frontZ - backZ
  const runnerLength = input.runnerLength ?? Math.min(f.depth, boxDepth)
  const legacyTravel = Math.max(0, f.depth - 30)
  const changesRunner = input.runnerLength !== undefined || rearClearance !== DRAWER_REAR_CLEARANCE
  const runnerTravel = catalog ? (runnerVariant(input.runnerLength)?.travel ?? 0)
    : input.runnerTravel ?? (changesRunner ? Math.min(legacyTravel, runnerLength) : legacyTravel)
  const config: ResolvedDrawerConfig = { runnerModel, sideClearance, boxThickness, bottomThickness, rearClearance,
    runnerLength, runnerTravel, reinforcement }
  const boxBottom = -f.height / 2
  const baseBottom = boxBottom + (reinforcement.count ? reinforcement.height : 0)
  const runnerFront = Math.min(frontZ - (catalog && f.overlay === 'inset' ? 3.2 : 0), f.depth / 2)
  return { config, boxWidth, boxHeight, boxDepth, innerWidth: boxWidth - boxThickness * 2,
    innerDepth: boxDepth - boxThickness * 2, innerHeight: boxBottom + boxHeight - baseBottom - bottomThickness,
    boxBottom, baseBottom, boxY: boxBottom + boxHeight / 2, boxZ: backZ + boxDepth / 2, backZ, frontZ,
    runnerLength, travel: runnerTravel, runnerFront, availableRunnerDepth: runnerFront - Math.max(backZ, -f.depth / 2), runnerBack: runnerFront - runnerLength }
}
