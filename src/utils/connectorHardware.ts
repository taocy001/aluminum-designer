import type { ConnectorSeries } from './connectorCatalog'
import { accessoryHardwareReference } from './connectorAccessoryReferences'

export interface HardwareFastener {
  kind: 'bolt' | 'set-screw' | 't-nut' | 'nut' | 'washer' | 'other'
  count: number
  thread?: string
  length?: number
  standard?: string
  descriptionZh?: string
  descriptionEn?: string
}

/** A product reference, not a claim that all parts bearing the series number interchange. */
export interface HardwareReference {
  sku: string
  sourceUrl: string
  drawingUrl?: string
  cadUrl?: string
  descriptionZh: string
  descriptionEn: string
  mounting: 'slot-clamp' | 'slot-face' | 'end-tapped' | 'press-fit' | 'surface' | 'schematic'
  verified: boolean
  supportedSeries: readonly ConnectorSeries[]
  fasteners: readonly HardwareFastener[]
  machining?: readonly string[]
  limitations?: readonly string[]
  dimensionsMm?: Readonly<Record<string, number>>
}

export interface InsideCornerDimensions {
  /** Outside lengths. Origin is the intersection of the two INNER arm surfaces. */
  xLength: number
  yLength: number
  depth: number
  /** Vertical arm thickness (local X); B6 is 4.2 mm, not the horizontal arm's 4.4 mm. */
  xDepth: number
  shoulderWidth: number
  neckWidth: number
  shoulderDepth: number
  neckProjection: number
  verticalNeckProjection: number
  verticalShoulderWidth: number
  /** Horizontal shoulder begins beyond the heel relief, measured from the inner corner. */
  shoulderStart: number
  xScrew: number
  yScrew: number
  screwDiameter: number
}

/** Motedis original STEP: asymmetric arms/shoulders; 30 B8 and 40 I8 use the SAME physical SKU. */
export function insideCornerDimensions(series: ConnectorSeries): InsideCornerDimensions {
  return series === 20
    ? { xLength: 25.5, yLength: 24.85, depth: 4.4, xDepth: 4.2, shoulderWidth: 9.5, neckWidth: 6,
      shoulderDepth: 2.6, neckProjection: 0.9, verticalNeckProjection: 1, verticalShoulderWidth: 9.5,
      shoulderStart: 4.8, xScrew: 15.3, yScrew: 13.45, screwDiameter: 5 }
    : { xLength: 35.25, yLength: 30, depth: 7, xDepth: 7, shoulderWidth: 13.9, neckWidth: 7.4,
      shoulderDepth: 4, neckProjection: 1.5, verticalNeckProjection: 1, verticalShoulderWidth: 14.1,
      shoulderStart: 4.95, xScrew: 18.25, yScrew: 14, screwDiameter: 6 }
}

const inside20: HardwareReference = {
  sku: 'Motedis S6BIBM5', sourceUrl: 'https://www.motedis.com/en/Inner-bracket-20-B-Type-slot-6-M5-Alternative',
  drawingUrl: 'https://www.motedis.com/shop/products_files/Motedis_S6BIBM5-Drawing_2.pdf',
  cadUrl: 'https://www.motedis.com/shop/products_files/Motedis_S6BIBM5_1.zip',
  descriptionZh: 'B 型槽 6 内角码，L 形槽内肩部，两颗 M5×6 紧定螺钉',
  descriptionEn: 'B-type slot 6 inner bracket with shouldered L insert and two M5×6 set screws',
  mounting: 'slot-clamp', verified: true, supportedSeries: [20],
  fasteners: [{ kind: 'set-screw', count: 2, thread: 'M5', length: 6, standard: 'DIN 913' }],
  limitations: ['仅匹配 B 型槽 6；须从开放槽端装入，保留紧定螺钉的扳手通道。'],
}
const inside30And40: HardwareReference = {
  sku: 'Motedis S8IBIBM6', sourceUrl: 'https://www.motedis.com/en/Inner-bracket-zamak-30-B-Type-40-I-Type-Slot-8-M6',
  drawingUrl: 'https://www.motedis.com/shop/products_files/Motedis_S8IBIBM6-Drawing_1.pdf',
  cadUrl: 'https://www.motedis.com/shop/products_files/Motedis_S8IBIBM6_1.zip',
  descriptionZh: '30 B 型／40 I 型槽 8 共用内角码，两颗 M6×8 紧定螺钉',
  descriptionEn: 'One physical inner bracket for 30 B-type / 40 I-type slot 8, two M6×8 set screws',
  mounting: 'slot-clamp', verified: true, supportedSeries: [30, 40],
  fasteners: [{ kind: 'set-screw', count: 2, thread: 'M6', length: 8, standard: 'DIN 913' }],
  limitations: ['30 B8 与 40 I8 共用实物尺寸，但每个插脚须按宿主槽唇分别确定埋深。',
    '不适用于所有称为槽 8 的型材；M6 紧定螺钉省略牙型、端倒角及内六角孔底钻尖。'],
}

export interface BracketDimensions {
  length: number
  width: number
  thickness: number
  slotWidth: number
  slotLength: number
  slotCentre: number
  webThickness: number
}

/** Physical dimensions from the manufacturer's original STEP in all three series. */
export function bracketDimensions(series: ConnectorSeries): BracketDimensions {
  if (series === 20) return { length: 18, width: 18, thickness: 3, slotWidth: 5.2,
    slotLength: 7, slotCentre: 10.5, webThickness: 1.9 }
  if (series === 30) return { length: 27, width: 28, thickness: 6, slotWidth: 6.4,
    slotLength: 9.5, slotCentre: 16.95, webThickness: 3.01 }
  return { length: 36, width: 38, thickness: 5.5, slotWidth: 9, slotLength: 20.5,
    slotCentre: 19.25, webThickness: 3 }
}

function bracketReference(series: ConnectorSeries): HardwareReference {
  const forty = series === 40
  return {
    sku: forty ? 'Motedis S8IBR40' : series === 30 ? 'Motedis S8BBR30' : 'Motedis S6BBR20',
    sourceUrl: forty ? 'https://www.motedis.com/en/Bracket-40-I-Type-slot-8'
      : series === 30 ? 'https://www.motedis.com/en/Bracket-30-B-Type-slot-8'
        : 'https://www.motedis.com/en/Bracket-20x20-B-type-slot-6',
    drawingUrl: forty ? 'https://www.motedis.com/shop/products_files/Motedis_S8IBR40_1.zip'
      : series === 30 ? 'https://www.motedis.com/shop/products_files/Motedis_S8BBR30.zip'
        : 'https://www.motedis.com/shop/products_files/Motedis_S6BBR20_1.zip',
    descriptionZh: `${series} 系列外置直角支架，模型直接采自厂家 STEP，含定位凸台与真实安装孔`,
    descriptionEn: `${series}-series external angle bracket tessellated from the manufacturer's STEP, with locating tabs and real mounting holes`,
    mounting: 'slot-face', verified: true, supportedSeries: [series],
    fasteners: [
      { kind: 'bolt', count: 2, thread: forty ? 'M8' : series === 30 ? 'M6' : 'M4',
        length: forty ? 16 : series === 30 ? 12 : 8, standard: forty ? 'DIN 912' : 'DIN 7984' },
      { kind: 't-nut', count: 2, thread: forty ? 'M8' : series === 30 ? 'M6' : 'M4' },
    ],
    limitations: ['应使用与对应型材槽系匹配的 T 型螺母；定位凸台跨槽安装时须按厂家说明去除。'],
  }
}

const corner40: HardwareReference = {
  sku: '80/20 14173', sourceUrl: 'https://8020.net/14173.html',
  drawingUrl: 'https://8020.net/media/catalog/product/1/4/14173_dimensional_1.png',
  descriptionZh: '40 系列三向端面角块，三根型材端孔攻牙后使用沉头螺钉连接',
  descriptionEn: '40-series three-way end connector with three tapped profile ends and flat-head screws',
  mounting: 'end-tapped', verified: true, supportedSeries: [40],
  fasteners: [{ kind: 'bolt', count: 3, thread: 'M8', length: 20, standard: 'FHSCS' }],
  machining: ['三根连接型材端部中心孔均需 M8 攻牙。'],
  limitations: ['角块占据 40 mm 节点空间；三根型材均须以端面接入。',
    '模型保留外形及安装/工具孔；内部压铸凹腔、圆角和可拆盖帽简化。'],
  dimensionsMm: { size: 40, boreDiameter: 8.5, accessDiameter: 23.7 },
}

const gusset40: HardwareReference = {
  sku: '80/20 40-4332', sourceUrl: 'https://8020.net/40-4332.html',
  drawingUrl: 'https://8020.net/media/catalog/product/4/0/40-4332_dimensional_1.png',
  descriptionZh: '40 系列中空三角加强角码，两个垂直安装面及斜面工具孔',
  descriptionEn: '40-series hollow triangular gusseted angle bracket, perpendicular mounting faces and tool access bores',
  mounting: 'slot-face', verified: true, supportedSeries: [40],
  fasteners: [{ kind: 'bolt', count: 2, thread: 'M8', length: 16, standard: 'BHSCS' },
    { kind: 't-nut', count: 2, thread: 'M8', descriptionZh: '偏置螺纹滑入式 T 型螺母', descriptionEn: 'Offset-thread slide-in T-nut' }],
  dimensionsMm: { length: 40, width: 36, wall: 6, boltOffset: 20, holeDiameter: 8.3, counterboreDiameter: 20 },
  limitations: ['对应 80/20 40 系列；槽内紧固件须核验所用型材的槽系。模型省略铸件圆角及 2° 锁紧微倾角。'],
}

/** Unknown series keep the documented part at its real size and disable automatic installation. */
function unverifiedSeries(reference: HardwareReference, series: ConnectorSeries): HardwareReference {
  return { ...reference, verified: false,
    descriptionZh: `${reference.descriptionZh}；未核验 ${series} 系列对应型号`,
    descriptionEn: `${reference.descriptionEn}; no verified ${series}-series variant`,
    limitations: [...(reference.limitations ?? []), '仅展示所引用实物的尺寸，不能按系列比例推定可安装。'] }
}

export function hardwareReference(type: string, series: ConnectorSeries = 20): HardwareReference | undefined {
  if (type === 'inside-corner') return series === 20 ? inside20 : inside30And40
  if (type === 'bracket') return bracketReference(series)
  if (type === 'gusset') return series === 40 ? gusset40 : unverifiedSeries(gusset40, series)
  if (type === 'corner-3way') return series === 40 ? corner40 : unverifiedSeries(corner40, series)
  return accessoryHardwareReference(type, series)
}
