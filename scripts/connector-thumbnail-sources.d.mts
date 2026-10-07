export function checkThumbnails(): {
  format: number
  width: number
  height: number
  sourceHash: string
  sources: Record<string, string>
  images: Record<string, { file: string; sha256: string }>
}
