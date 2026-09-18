// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createTabMapPdf } from './tabMapPdf'
import type { TabMap } from './tabMap'

const font = () => readFile(new URL('../../api/assets/NotoSans-Regular.ttf', import.meta.url))
const bounds = { minX: 20, minY: 30, maxX: 300, maxY: 200 }
const tab = { points: [{ x: 20, y: 60 }, { x: 20, y: 76 }], center: { x: 20, y: 68 }, z: -12.4, operation: 'Outer', inferred: false }
const map: TabMap = { name: 'Test job', order: 'ORDER-42', width: 1220, height: 2440, sheetCount: 2, parts: [0, 1].map(sheetIndex => ({ number: `P00${sheetIndex + 1}`, name: 'Long component name '.repeat(20), sheetIndex, bounds, rotation: 0, paths: [[{ x: 20, y: 30 }, { x: 300, y: 200 }]], tabs: [tab], warnings: [] })) }

describe('Tab map PDF', () => {
  it('creates A4 overview and part pages for each physical sheet', async () => {
    const pdf = await PDFDocument.load(await createTabMapPdf(map, await font()))
    expect(pdf.getPageCount()).toBe(4)
    expect(pdf.getTitle()).toBe('Test job - Tab removal map')
    for (const page of pdf.getPages()) {
      expect(page.getWidth()).toBeCloseTo(595.28)
      expect(page.getHeight()).toBeCloseTo(841.89)
    }
  })
  it('paginates large tab tables and handles no-tab parts', async () => {
    const tabs = Array.from({ length: 80 }, () => tab)
    const pdf = await PDFDocument.load(await createTabMapPdf({ ...map, parts: [{ ...map.parts[0], tabs }, { ...map.parts[1], tabs: [], warnings: ['No tab locations identified. Check source machining.'] }] }, await font()))
    expect(pdf.getPageCount()).toBeGreaterThan(5)
  })
})
