export type NumberedPartKind = 'profile' | 'connector' | 'panel' | 'fitting'

const prefixes: Record<NumberedPartKind, string> = { profile: 'P', connector: 'C', panel: 'B', fitting: 'F' }

/** Escape UTF-16 code units so every accepted ID, including lone surrogates, has a unique ASCII form. */
function encoded(value: string): string {
  return value.replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
}

/** Identity-based labels survive reordering, dimension changes, save/load and undo. */
export function partNumber(kind: NumberedPartKind, id: string): string {
  return `${prefixes[kind]}-${encoded(id)}`
}

/** The reserved dot separates the fitting identity from its stable board key. */
export function fittingBoardNumber(id: string, key: string): string {
  return `${partNumber('fitting', id)}.B-${encoded(key)}`
}
