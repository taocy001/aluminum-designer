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
    : series === 30 ? { width: 16.5, length: 8, neckWidth: 7.9, neckHeight: 1.5, thickness: 6, thread: 6, shoulderDepth: 2.4, holeFromEnd: 4 }
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
  if (spec === '4040-B6') return {
    sku: 'Motedis PTS6B20x20 ×4', sourceUrl: 'https://www.motedis.com/shop/products_files/Motedis_PTS6B20x20.zip',
    descriptionZh: '4040 B6 端面使用四只 2020 B6 原厂端盖，中央销插入四个芯孔，侧卡脚朝外',
    descriptionEn: 'Four original 2020 B6 caps cover a 4040 B6 end; pins enter its four cores and side tabs face outwards',
    mounting: 'press-fit', verified: true, supportedSeries: [20], fasteners: [],
    limitations: ['每个端面采购四只 PTS6B20x20；组合处保留接缝，不是单体 4040 盖，也不构成密封。',
      '仅安装于直切、未被占用的 4040 B6 端面；不能用于 4040 I8。'],
  }
  const sku = ({ '2020': 'PTS6B20x20', '2040': 'PTS6B20x40', '3030': 'PTS8B30x30', '4040': 'PTS8I40x40' } as Partial<Record<ProfileSpec, string>>)[spec]
  return { sku: sku ? `Motedis ${sku}` : '3040 cap: no verified model',
    sourceUrl: sku ? `https://www.motedis.com/shop/products_files/Motedis_${sku}.zip` : 'https://www.motedis.com/en/Covers-Bracket-Covers-Covers-Cap',
    descriptionZh: sku ? `${spec} 截面压入端盖，卡脚来自厂家 STEP` : '3040 端盖未核验',
    descriptionEn: sku ? `${spec} press-fit profile cap, with retention geometry from the manufacturer STEP` : 'No verified 3040 cap',
    mounting: 'press-fit', verified: !!sku, supportedSeries: spec === '3040' ? [] : [Number(spec.slice(0, 2)) as ConnectorSeries], fasteners: [],
    limitations: ['端盖按完整截面及槽系匹配；只安装于未被占用的直切端面。'] }
}

export function accessoryHardwareReference(type: string, series: ConnectorSeries, profileSpec?: ProfileSpec): HardwareReference | undefined {
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
  if (type === 'end-cap') return accessoryCapReference(profileSpec ?? `${series}${series}` as ProfileSpec)
  if (type === 'foot' && series === 20 && profileSpec === '4040-B6') return {
    sku: 'Motedis BD40-8x50 + AP-4040B6-M8',
    sourceUrl: 'https://www.motedis.com/en/Adjustable-feet-D40-M8-L50',
    drawingUrl: '/hardware/ap-4040b6-m8.svg',
    descriptionZh: 'D40 M8 调节脚，配 4040 B6 加工转接板及四颗 M6 沉头螺钉',
    descriptionEn: 'D40 M8 foot with a machined 4040 B6 adapter plate and four M6 countersunk screws',
    mounting: 'end-tapped', verified: true, supportedSeries: [20],
    dimensionsMm: { plateWidth: 40, plateThickness: 8, pitch: 20, mountingHole: 6.6, countersink: 12.8, threadEngagement: 12.1 },
    fasteners: [
      { kind: 'nut', count: 1, thread: 'M8', descriptionZh: '随脚附带锁紧螺母', descriptionEn: 'supplied locknut' },
      { kind: 'other', count: 1, standard: 'AP-4040B6-M8', descriptionZh: '40×40×8 钢制加工板，中心 M8，四个 M6 沉头孔', descriptionEn: '40×40×8 machined steel adapter, central M8 and four M6 countersunk holes' },
      { kind: 'bolt', count: 4, thread: 'M6', length: 20, standard: 'DIN 7991' },
    ],
    machining: ['4040 B6 四个芯孔攻 M6，有效螺纹至少 13 mm，另留入口倒角和丝锥导程余量。转接板按 AP-4040B6-M8 图加工，中心攻 M8 通牙。'],
    limitations: ['AP-4040B6-M8 是加工件，不是 Motedis 现货型号；安装次序为转接板、调节脚、锁紧螺母。',
      '仅适配四芯孔中心距 20 mm 的 4040 B6；不适配 2020/2040。模型从板底旋入 10 mm；转接板增加 8 mm 安装高度。螺纹牙型简化，未给出承载评级。'],
  }
  if (type === 'foot') return {
    sku: 'Motedis BD40-8x50', sourceUrl: 'https://www.motedis.com/en/Adjustable-feet-D40-M8-L50',
    drawingUrl: 'https://www.motedis.com/shop/products_files/BD40-8x50-Drawing.pdf',
    descriptionZh: 'D40 可调脚，M8 螺杆与锁紧螺母', descriptionEn: 'D40 levelling foot with M8 stud and locknut',
    mounting: 'end-tapped', verified: series !== 20, supportedSeries: [30, 40],
    fasteners: [{ kind: 'nut', count: 1, thread: 'M8', descriptionZh: '随脚附带锁紧螺母', descriptionEn: 'supplied locknut' }],
    machining: ['安装端孔须有 M8 内螺纹；孔径不足时需另配匹配截面的转接底板。'],
    dimensionsMm: { diameter: 39.4, height: 78.24, baseHeight: 19.5, threadDiameter: 8, threadLength: 50 },
    limitations: ['外露螺杆高度随旋入深度改变；图中为 10 mm 旋入量。螺纹牙型与底盘圆角简化。'],
  }
  if (type === 'caster-mount') return {
    sku: 'Motedis 10146', sourceUrl: 'https://www.motedis.com/en/Roller-75-single-bolt-hole-without-brake-NEW',
    drawingUrl: 'https://www.motedis.com/shop/products_files/Motedis_10146-Drawing.pdf',
    cadUrl: 'https://www.motedis.com/shop/products_files/Motedis_10146.zip',
    descriptionZh: 'D75 万向脚轮，M8 沉头螺钉从支架下方拧入型材端面芯孔', descriptionEn: 'D75 swivel caster; an M8 countersunk screw enters the tapped profile core from below the swivel head',
    mounting: 'end-tapped', verified: true, supportedSeries: [30, 40],
    fasteners: [{ kind: 'bolt', count: 1, thread: 'M8', length: 25, standard: 'DIN 7991', descriptionZh: '脚轮芯孔安装', descriptionEn: 'caster core mounting' }],
    machining: ['3030 B8 / 4040 I8 的向下正切端面芯孔攻 M8；螺钉旋入约 8.36 mm。'],
    dimensionsMm: { wheelDiameter: 75, wheelWidth: 25, mountingHeight: 99.7, mountingHole: 11, offset: 29.94386, threadEngagement: 8.3609 },
    limitations: ['模型以厂家 10146 STEP 与工程图的 Ø11 孔版本为准；网页文字另列 Ø10，采购时核对图纸版本。',
      '按 Motedis_Wheels.pdf 的芯孔安装方式使用 DIN 7991 M8×25。仅适配 3030 B8、4040 I8；不适配 2020 或 4040 B6。轮体、叉架、轴及转盘保留厂家实体；紧固螺钉省略螺纹牙型。'],
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
      limitations: ['螺母肩部位于槽唇内侧；B 型旋转 90° 锁住槽口，I 型可后装。模型使用厂家 STEP；20 系列以 M5 底孔表示螺纹，30 系列肩深 2.4 mm，圆角抵靠槽唇，40 系列钢珠处于压入 0.65 mm 的安装状态。未附螺栓。'],
    }
  }
  return undefined
}
