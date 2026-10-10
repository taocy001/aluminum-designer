/** Accuride North American 3832E, technical sheet R10-0616, page 1.
 * https://www.accuride.com/media/amasty/amfile/attach/516dd0135bf3d6a5f7d76cafd3f74da0.pdf
 * Specification checks only: no rail CAD, fixing holes or frame load certification.
 */
export const ACCURIDE_3832E = {
  id: 'accuride-3832e', label: 'Accuride 3832E',
  sideClearance: { min: 12.7, max: 13.5, nominal: 13 }, // App nominal within the supplier's range.
  height: 45.7,
  variants: [
    { length: 300, travel: 305, sku: '3832-E12' },
    { length: 350, travel: 356, sku: '3832-E14' },
    { length: 400, travel: 406, sku: '3832-E16' },
    { length: 450, travel: 457, sku: '3832-E18' },
    { length: 500, travel: 508, sku: '3832-E20' },
    { length: 550, travel: 559, sku: '3832-E22' },
    { length: 600, travel: 610, sku: '3832-E24' },
    { length: 650, travel: 660, sku: '3832-E26' },
    { length: 700, travel: 711, sku: '3832-E28' },
  ],
} as const

export const runnerVariant = (length: number | undefined) => ACCURIDE_3832E.variants.find(v => v.length === length)
