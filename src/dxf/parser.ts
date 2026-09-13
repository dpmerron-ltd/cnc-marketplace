export interface DxfOutline {
  source: string
  warnings: string[]
}

export function parseDxfOutline(source: string): DxfOutline {
  return { source, warnings: ['DXF association is stored for this MVP; polygon extraction is reserved for Phase 2.'] }
}
