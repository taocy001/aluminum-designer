import type { ConnectorMount, ConnectorSeries } from './connectorCatalog'
import type { HardwareFastener, HardwareReference } from './connectorHardware'
import type { ProfileSpec } from '../store/useStore'

const hingeDrawing = 'https://uk.misumi-ec.com/pdf/fa/p2_0719.pdf'
const seriesIndex = (series: ConnectorSeries) => series === 20 ? 0 : series === 30 ? 1 : 2
const bolts = (count: number, thread: string, length?: number): HardwareFastener[] => [
  { kind: 'bolt', count, thread, ...(length === undefined ? {} : { length }) },
  { kind: 't-nut', count, thread },
]

/** Physical dimensions in mm, independent of the instance's legacy display scale. */
export function accessoryPlateDimensions(type: string, series: ConnectorSeries) {
  const i = seriesIndex(series), pitch = type === 'cross-bracket' && series === 20 ? 30 : series
  const thickness = series === 40 ? 6 : 4
  const width = [18, 27, 39.8][i]
  const hole = type === 'joining-plate' && series === 30 ? 6.3
    : type === 'cross-bracket' ? (series === 40 ? 8.3 : 6.3)
      : type === 't-bracket' && series === 40 ? 8.33
      : [5.56, 6.81, 8.3][i]
  return { pitch, thickness, width, hole }
}

export function accessoryHingeDimensions(series: ConnectorSeries) {
  return series === 20 ? { length: 47, width: 36, alongPitch: 25, acrossPitch: 21, hole: 5.5, sink: 11, thickness: 3.5, axisHeight: 5, barrelRadius: 5 }
    : series === 30 ? { length: 47, width: 48, alongPitch: 30, acrossPitch: 32, hole: 6.5, sink: 13, thickness: 3.5, axisHeight: 5, barrelRadius: 5 }
      : { length: 63, width: 62, alongPitch: 37, acrossPitch: 42, hole: 6.5, sink: 13, thickness: 3.5, axisHeight: 5.5, barrelRadius: 5.5 }
}

export function accessoryNutDimensions(series: ConnectorSeries) {
  return series === 20 ? { width: 11.5, length: 5.7, neckWidth: 5.7, neckHeight: 1, thickness: 4.2, thread: 5, shoulderDepth: 1.5, holeFromEnd: 2.85 }
    : series === 30 ? { width: 16.5, length: 8, neckWidth: 7.9, neckHeight: 1.5, thickness: 6, thread: 6, shoulderDepth: 2.2, holeFromEnd: 4 }
      : { width: 13.5, length: 22, neckWidth: 7.8, neckHeight: .8, thickness: 7.2, thread: 8, shoulderDepth: 4.5, holeFromEnd: 7.5 }
}

/** Each group must be supported by one member; separate groups describe separate members. */
export function accessoryMountPoints(type: string, series: ConnectorSeries): ConnectorMount[] | undefined {
  const { pitch: s } = accessoryPlateDimensions(type, series)
  if (type === 'flat-plate') return [
    { axis: 'x', normal: 'y', bolts: [[-1.5 * s, 0, 0], [-.5 * s, 0, 0]] },
    { axis: 'x', normal: 'y', bolts: [[.5 * s, 0, 0], [1.5 * s, 0, 0]] },
  ]
  if (type === 'joining-plate') return [
    { axis: 'z', normal: 'x', bolts: [[0, 0, -s / 2]] },
    { axis: 'z', normal: 'x', bolts: [[0, 0, s / 2]] },
  ]
  if (type === 't-bracket') return [
    { axis: 'x', normal: 'z', bolts: [[-s, 0, 0], [0, 0, 0], [s, 0, 0]] },
    { axis: 'y', normal: 'z', bolts: [[0, s, 0], [0, 2 * s, 0]] },
  ]
  if (type === 'cross-bracket') return [
    { axis: 'x', normal: 'z', bolts: [-2, -1, 0, 1, 2].map((n) => [n * s, 0, 0]) },
    { axis: 'y', normal: 'z', bolts: [[0, s, 0]] },
    { axis: 'y', normal: 'z', bolts: [[0, -s, 0]] },
  ]
  if (type === 'hinge') {
    const d = accessoryHingeDimensions(series)
    return [-1, 1].map((side) => ({ axis: 'z', normal: 'x',
      bolts: [-1, 1].map((end) => [0, side * d.acrossPitch / 2, end * d.alongPitch / 2]) }))
  }
  if (type === 'pivot') return [{ axis: 'x', normal: 'y', bolts: [[-13, 0, 0], [13, 0, 0]] }]
  if (type === 't-nut') return [{ axis: 'z', normal: 'y', bolts: [[0, 0, 0]] }]
  return undefined
}

export function accessoryCapReference(spec: ProfileSpec): HardwareReference {
  const sku = ({ '2020': 'PTS6B20x20', '2040': 'PTS6B20x40', '3030': 'PTS8B30x30', '4040': 'PTS8I40x40' } as Partial<Record<ProfileSpec, string>>)[spec]
  return { sku: sku ? `Motedis ${sku}` : '3040 cap: no verified model',
    sourceUrl: sku ? `https://www.motedis.com/shop/products_files/Motedis_${sku}.zip` : 'https://www.motedis.com/en/Covers-Bracket-Covers-Covers-Cap',
    descriptionZh: sku ? `${spec} 截面压入端盖，卡脚来自厂家 STEP` : '3040 端盖未核验',
    descriptionEn: sku ? `${spec} press-fit profile cap, with retention geometry from the manufacturer STEP` : 'No verified 3040 cap',
    mounting: 'press-fit', verified: !!sku, supportedSeries: spec === '3040' ? [] : [Number(spec.slice(0, 2)) as ConnectorSeries], fasteners: [],
    limitations: ['端盖按完整截面及槽系匹配；只安装于未被占用的直切端面。'] }
}

export function accessoryHardwareReference(type: string, series: ConnectorSeries): HardwareReference | undefined {
  const i = seriesIndex(series), thread = ['M5', 'M6', 'M8'][i], length = [10, 12, 16][i]
  if (['flat-plate', 'joining-plate', 't-bracket', 'cross-bracket'].includes(type)) {
    const codes = type === 'flat-plate' ? ['20-4117', '30-4305', '40-4305']
      : type === 'joining-plate' ? ['20-4107', '30-4307', '40-4307']
        : type === 't-bracket' ? ['20-4080', '30-4480', '40-4480'] : ['30-4335-black', '30-4335-black', '40-4335']
    const sku = codes[i], count = type === 'flat-plate' ? 4 : type === 'joining-plate' ? 2 : type === 't-bracket' ? 5 : 7
    const d = accessoryPlateDimensions(type, series), verified = type !== 'cross-bracket' || series !== 20
    return { sku: `80/20 ${sku}`, sourceUrl: `https://8020.net/${sku}.html`,
      descriptionZh: `${count} 孔外贴连接板`, descriptionEn: `${count}-hole external joining plate`,
      mounting: 'slot-face', verified, supportedSeries: verified ? [series] : [30],
      fasteners: verified ? [...bolts(count, thread, length), ...(series === 20 ? [{ kind: 'washer' as const, count, thread: 'M5', standard: 'ISO 7089', descriptionZh: '1 mm 厚垫圈，避免螺钉顶住槽底', descriptionEn: '1 mm washer for slot-floor clearance' }] : [])] : [], dimensionsMm: d,
      limitations: ['所有安装孔须落在对应型材槽线上，板底贴合共面外表面；不能嵌入槽腔。',
        ...(verified ? [] : ['20 系列没有已核验型号，显示 30 系列参考件的实际尺寸。'])] }
  }
  if (type === 'hinge') return {
    sku: `MISUMI HHPSN${[5, 6, 8][i]}`, sourceUrl: hingeDrawing, drawingUrl: hingeDrawing,
    descriptionZh: '两叶铝合页，四个沉头安装孔，铰轴平行安装面',
    descriptionEn: 'Two-leaf aluminium hinge, four countersunk mounting holes, pin parallel to the mounting face',
    mounting: 'slot-face', verified: true, supportedSeries: [series], dimensionsMm: accessoryHingeDimensions(series),
    fasteners: bolts(4, series === 20 ? 'M5' : 'M6', [8, 10, 12][i]).map((f) => f.kind === 'bolt' ? { ...f, standard: 'flat-head' } : f),
    limitations: ['每片合页叶的两个孔连接各自构件；40 系列也使用 M6 螺钉。', '螺母须匹配实际槽系；参考图的 HNTT8 槽 10 螺母不适配槽 8。'],
  }
  if (type === 'end-cap') return accessoryCapReference(`${series}${series}` as ProfileSpec)
  if (type === 'foot') return {
    sku: 'Motedis BD40-8x50', sourceUrl: 'https://www.motedis.com/en/Adjustable-feet-D40-M8-L50',
    drawingUrl: 'https://www.motedis.com/shop/products_files/BD40-8x50-Drawing.pdf',
    descriptionZh: 'D40 可调脚，M8 螺杆与锁紧螺母', descriptionEn: 'D40 levelling foot with M8 stud and locknut',
    mounting: 'end-tapped', verified: true, supportedSeries: [30, 40],
    fasteners: [{ kind: 'nut', count: 1, thread: 'M8', descriptionZh: '随脚附带锁紧螺母', descriptionEn: 'supplied locknut' }],
    machining: ['安装端孔须有 M8 内螺纹；孔径不足时需另配匹配截面的转接底板。'],
    dimensionsMm: { diameter: 39.4, height: 78.24, baseHeight: 19.5, threadDiameter: 8, threadLength: 50 },
    limitations: ['外露螺杆高度随旋入深度改变；图中为 10 mm 旋入量。螺纹牙型与底盘圆角简化。'],
  }
  if (type === 'caster-mount') return {
    sku: 'Motedis 963', sourceUrl: 'https://www.motedis.com/en/Roller-50-single-bolt-hole-without-brake',
    drawingUrl: 'https://www.motedis.com/shop/products_files/Motedis_963-Drawing.pdf',
    descriptionZh: 'D50 万向脚轮，完整支架、转盘与轮轴来自厂家 STEP', descriptionEn: 'D50 swivel caster, including the manufacturer STEP fork, swivel and axle',
    mounting: 'surface', verified: false, supportedSeries: [], fasteners: [],
    dimensionsMm: { wheelDiameter: 50, mountingHeight: 74.2, mountingHole: 11, offset: 19.5 },
    limitations: ['厂家图纸及 STEP 为 Ø11 安装孔、74.2 mm 总高，产品网页另标 Ø6.5、71 mm；模型使用图纸及 STEP。安装转接件未核定，不提供直接安装或紧固件配方。'],
  }
  if (type === 'pivot') return {
    sku: 'igus ESTM-10', sourceUrl: 'https://www.igus.com/product/igubal-ESTM', drawingUrl: 'https://www.igus.com/us/pdf/igubal.pdf',
    descriptionZh: '10 mm 孔径立式轴承座，轴线平行底面', descriptionEn: '10 mm pillow-block bearing with shaft axis parallel to its mounting base',
    mounting: 'surface', verified: true, supportedSeries: [20, 30, 40], fasteners: bolts(2, 'M5'),
    dimensionsMm: { bore: 10, height: 22, shaftHeight: 11, length: 36, pitch: 26, width: 10, mountingHole: 5.5 },
    limitations: ['紧固螺钉长度须按底脚厚度及所用螺母确定；不随型材系列放大轴孔。轴承球面和圆角简化。'],
  }
  if (type === 't-nut') {
    const sku = ['S6BHASNM5', 'S8BHASNM6', 'S8ISMONM8'][i]
    const path = ['T-nut-B-type-slot-6-M5', 'T-nut-B-type-slot-8-M6', 'T-nut-guided-I-type-slot-8-M8'][i]
    const drawing = ['Motedis_S6BHASNMX-Drawing_3.pdf', 'Motedis_S8BHASNM6-Drawing_1.pdf', 'Motedis_S8ISMONM8-Drawing_1.pdf'][i]
    return { sku: `Motedis ${sku}`, sourceUrl: `https://www.motedis.com/en/${path}`,
      drawingUrl: `https://www.motedis.com/shop/products_files/${drawing}`,
      descriptionZh: `${series === 20 ? 'B 型槽 6' : series === 30 ? 'B 型槽 8' : 'I 型槽 8'}槽螺母，${thread} 通螺纹孔`,
      descriptionEn: `${series === 20 ? 'B-type slot 6' : series === 30 ? 'B-type slot 8' : 'I-type slot 8'} nut, ${thread} through thread`,
      mounting: 'slot-clamp', verified: true, supportedSeries: [series], fasteners: [],
      dimensionsMm: accessoryNutDimensions(series),
      limitations: ['螺母肩部位于槽唇内侧；B 型旋转 90° 锁住槽口，I 型可后装。模型使用厂家 STEP；20 系列以 M5 底孔表示螺纹，40 系列钢珠处于压入 0.65 mm 的安装状态。未附螺栓。'],
    }
  }
  return undefined
}
