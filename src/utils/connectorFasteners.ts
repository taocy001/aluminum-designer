import type { HardwareFastener } from './connectorHardware'

/** A screw's thread does not determine its head, length or matching slot nut. */
export function hardwareFastenerLabel(f: HardwareFastener, language: 'zh' | 'en'): string {
  const zh = language === 'zh'
  const names = { bolt: zh ? '螺钉' : 'screw', 'set-screw': zh ? '紧定螺钉' : 'set screw',
    't-nut': zh ? 'T 槽螺母' : 'T-slot nut', nut: zh ? '螺母' : 'nut', washer: zh ? '垫圈' : 'washer', other: zh ? '配件' : 'accessory' }
  const size = `${f.thread ?? ''}${f.length === undefined ? '' : `×${f.length}`}`
  const standard = f.standard === 'flat-head' ? (zh ? '沉头' : 'countersunk') : f.standard
  const detail = zh ? f.descriptionZh : f.descriptionEn
  return [size, standard, names[f.kind], detail ? `(${detail})` : ''].filter(Boolean).join(' ')
}

export function hardwareFastenerKey(f: HardwareFastener, series: number): string {
  return [f.kind, f.thread ?? '', f.length ?? 'unspecified', f.standard ?? '',
    f.kind === 't-nut' ? series : '', f.descriptionEn ?? f.descriptionZh ?? ''].join(':')
}
