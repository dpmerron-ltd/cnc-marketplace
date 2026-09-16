import { describe, expect, it } from 'vitest'
import { generateJob, parseJobRequest } from './generateJob'
import { validateSheet } from '../gcode/validator'
import { testItem, testParts, testRequest } from '../test/jobFixtures'

describe('automated job generation', () => {
  it('expands item quantities, nests across sheets, preserves numbering and safe Z', async () => {
    const job = await generateJob(parseJobRequest(testRequest), [testItem], testParts)
    expect(job.manifest.cuts).toHaveLength(4)
    expect(job.manifest.sheets).toHaveLength(2)
    expect(job.manifest.cuts.map(cut => cut.partNumber)).toEqual(['P001', 'P002', 'P003', 'P004'])
    expect(validateSheet(job.parts, job.sheet).filter(issue => issue.level === 'error')).toEqual([])
    expect(job.manifest.request.labels).toEqual({ widthMm: 50, heightMm: 25 })
    expect(job.manifest.request.sheet).toMatchObject({ spacingMm: 30, borderMm: 10, screwMarks: true, safeZMm: 20 })
    expect(job.manifest.sheets.every(sheet => sheet.screwMarks > 0)).toBe(true)
    for (const file of job.exported) {
      expect(file.gcode).toContain('G00 Z20')
      expect(file.gcode).toContain('G01 Z-2 F300')
      expect(file.gcode).toContain('F1000')
      expect(file.gcode).toContain('(Screw marks:')
      expect(file.gcode).toContain('M00')
    }
  })
  it('preserves explicit screw marking opt-out and custom spacing', async () => {
    const request = parseJobRequest({ ...testRequest, sheet: { ...testRequest.sheet, spacingMm: 5, borderMm: 15, screwMarks: false } })
    const job = await generateJob(request, [testItem], testParts)
    expect(job.manifest.request.sheet).toMatchObject({ spacingMm: 5, borderMm: 15, screwMarks: false })
    expect(job.manifest.sheets.every(sheet => sheet.screwMarks === 0)).toBe(true)
    for (const file of job.exported) {
      expect(file.gcode).not.toContain('(Screw marks:')
      expect(file.gcode).not.toContain('M00')
    }
  })
  it('combines repeated order lines without duplicating library definitions', async () => {
    const request = parseJobRequest({ ...testRequest, items: [{ itemId: testItem.id, quantity: 1 }, { sku: testItem.sku, quantity: 2 }] })
    const job = await generateJob(request, [testItem], testParts)
    expect(job.manifest.cuts).toHaveLength(6)
    expect(job.manifest.items[0].quantity).toBe(3)
    expect(job.manifest.sources).toHaveLength(2)
  })
  it('rejects missing, ambiguous and empty items', async () => {
    const request = parseJobRequest(testRequest)
    await expect(generateJob(request, [], testParts)).rejects.toThrow('missing')
    await expect(generateJob(request, [testItem, { ...testItem, id: 'other' }], testParts)).rejects.toThrow('ambiguous')
    await expect(generateJob(request, [testItem], [])).rejects.toThrow('no components')
  })
  it('rejects oversized parts and excessive expanded quantities before nesting', async () => {
    await expect(generateJob(parseJobRequest({ ...testRequest, sheet: { ...testRequest.sheet, widthMm: 50, heightMm: 50 } }), [testItem], testParts)).rejects.toThrow('cannot fit')
    await expect(generateJob(parseJobRequest({ ...testRequest, items: [{ sku: 'LOCKER', quantity: 20 }] }), [testItem], testParts)).rejects.toThrow('at most 20')
  })
  it('rejects invalid parameters and machining overrides', () => {
    for (const patch of [{ items: [] }, { ownerId: 'another-account' }, { sheet: { ...testRequest.sheet, safeZMm: 0 } }, { sheet: { ...testRequest.sheet, feed: 100 } }, { items: [{ sku: 'LOCKER', quantity: 1.5 }] }, { items: [{ sku: 'LOCKER', itemId: testItem.id, quantity: 1 }] }]) expect(() => parseJobRequest({ ...testRequest, ...patch })).toThrow('Invalid job')
  })
  it('rejects the expanded program limit before nesting', async () => {
    const oversized = { ...testParts[0], parsed: { ...testParts[0].parsed, lines: Array.from({ length: 2600 }, () => testParts[0].parsed.lines[0]) } }
    await expect(generateJob(parseJobRequest(testRequest), [testItem], [oversized])).rejects.toThrow('5,000 lines')
  })
})
