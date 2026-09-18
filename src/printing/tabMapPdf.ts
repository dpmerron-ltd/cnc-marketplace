import { PDFDocument, rgb, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Bounds, Point } from '../models/geometry'
import type { TabMap, TabMapPart } from './tabMap'

const black = rgb(0.08, 0.1, 0.12), grey = rgb(0.6, 0.63, 0.66), white = rgb(1, 1, 1), gold = rgb(0.96, 0.78, 0.3)
const pageWidth = 595.28, pageHeight = 841.89

export async function createTabMapPdf(map: TabMap, fontBytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  const supported = new Set(font.getCharacterSet())
  const content = [map.name, map.order, ...map.parts.flatMap(part => [part.name, ...part.tabs.map(tab => tab.operation)])].join('')
  if (Array.from(content).some(char => !/\s/.test(char) && !supported.has(char.codePointAt(0)!))) throw new Error('Tab map text contains characters unsupported by the PDF font.')
  pdf.setTitle(`${map.name} - Tab removal map`)
  pdf.setCreator('CNC Marketplace')
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
  function text(page: PDFPage, value: string, x: number, y: number, size = 9, width = 523) {
    let label = clean(value)
    if (font.widthOfTextAtSize(label, size) > width) {
      while (label && font.widthOfTextAtSize(`${label}...`, size) > width) label = label.slice(0, -1)
      label += '...'
    }
    page.drawText(label, { x, y, size, font, color: black })
  }
  function page(title: string, subtitle: string) {
    const result = pdf.addPage([pageWidth, pageHeight])
    text(result, title, 36, 801, 19)
    text(result, `${map.name} | Order ${map.order}`, 36, 778, 10)
    text(result, subtitle, 36, 758, 9)
    result.drawLine({ start: { x: 36, y: 745 }, end: { x: 559, y: 745 }, thickness: 0.6, color: grey })
    return result
  }
  function drawing(page: PDFPage, parts: TabMapPart[], bounds: Bounds, box: { x: number; y: number; width: number; height: number }, details: boolean) {
    const width = Math.max(bounds.maxX - bounds.minX, 1), height = Math.max(bounds.maxY - bounds.minY, 1)
    const scale = Math.min((box.width - 36) / width, (box.height - 36) / height)
    const x = box.x + (box.width - width * scale) / 2, y = box.y + (box.height - height * scale) / 2
    const place = (p: Point) => ({ x: x + (p.x - bounds.minX) * scale, y: y + (p.y - bounds.minY) * scale })
    const stroke = (points: Point[], thickness: number, color: ReturnType<typeof rgb>) => {
      for (let i = 1; i < points.length; i++) page.drawLine({ start: place(points[i - 1]), end: place(points[i]), thickness, color })
    }
    if (!details) page.drawRectangle({ x, y, width: width * scale, height: height * scale, borderWidth: 0.7, borderColor: black })
    for (const part of parts) for (const path of part.paths) {
      if (path.length > 1 && path.every(p => Math.hypot(p.x - path[0].x, p.y - path[0].y) < 0.001)) page.drawCircle({ ...place(path[0]), size: 1.1, color: grey })
      else stroke(path, 0.4, grey)
    }
    for (const part of parts) for (const tab of part.tabs) {
      stroke(tab.points, 3.3, black)
      stroke(tab.points, 1.7, gold)
      page.drawCircle({ ...place(tab.center), size: 2.4, color: gold, borderColor: black, borderWidth: 0.7 })
    }
    const occupied: Array<{ x: number; y: number; width: number; height: number }> = []
    function badge(label: string, anchor: Point) {
      const p = place(anchor), width = font.widthOfTextAtSize(label, 8) + 8, height = 13
      let best = { x: p.x + 8, y: p.y + 6, width, height }, score = Infinity
      for (const radius of [14, 28, 42, 56, 84, 112]) for (let angle = 0; angle < 8; angle++) {
        const candidate = { x: Math.min(box.x + box.width - width, Math.max(box.x, p.x + Math.cos(angle * Math.PI / 4) * radius - width / 2)), y: Math.min(box.y + box.height - height, Math.max(box.y, p.y + Math.sin(angle * Math.PI / 4) * radius - height / 2)), width, height }
        const collisions = occupied.filter(other => candidate.x < other.x + other.width + 2 && candidate.x + width + 2 > other.x && candidate.y < other.y + other.height + 2 && candidate.y + height + 2 > other.y).length
        const cost = collisions * 10000 + radius
        if (cost < score) { best = candidate; score = cost }
      }
      occupied.push(best)
      page.drawLine({ start: p, end: { x: best.x + width / 2, y: best.y + height / 2 }, thickness: 0.45, color: black })
      page.drawRectangle({ x: best.x, y: best.y, width, height, color: white, borderColor: black, borderWidth: 0.5 })
      text(page, label, best.x + 4, best.y + 3, 8, width - 8)
    }
    for (const part of parts) {
      if (details) part.tabs.forEach((tab, index) => badge(`T${index + 1}`, tab.center))
      else badge(part.number, { x: (part.bounds.minX + part.bounds.maxX) / 2, y: (part.bounds.minY + part.bounds.maxY) / 2 })
    }
    text(page, details ? 'Same orientation as the sheet / X right, Y up' : 'X0 Y0 at bottom-left / X right, Y up', box.x, box.y - 15, 8)
  }
  for (let sheetIndex = 0; sheetIndex < map.sheetCount; sheetIndex++) {
    const parts = map.parts.filter(part => part.sheetIndex === sheetIndex)
    const count = parts.reduce((total, part) => total + part.tabs.length, 0)
    const overview = page(`Tab map | Sheet ${sheetIndex + 1} of ${map.sheetCount}`, `${map.width} x ${map.height} mm stock | ${parts.length} part${parts.length === 1 ? '' : 's'} | ${count} detected tab locations`)
    drawing(overview, parts, { minX: 0, minY: 0, maxX: map.width, maxY: map.height }, { x: 36, y: 155, width: 523, height: 570 }, false)
    text(overview, 'Heavy outlined spans and dots: tab locations. Enlarged part maps follow.', 36, 105, 9)
    text(overview, 'Part numbers match the sheet labels. This is a location guide, not a cutting template.', 36, 88, 8)
    text(overview, 'Check the actual parts before removal; stop the machine and cutter first.', 36, 71, 8)
    for (const part of parts) {
      let detail = page(`${part.number} | Tab locations`, `Sheet ${sheetIndex + 1} | ${part.tabs.length} detected locations | Rotation ${part.rotation} deg`)
      text(detail, part.name, 36, 725, 11)
      drawing(detail, [part], part.bounds, { x: 36, y: 344, width: 523, height: 358 }, true)
      let y = 302
      function tableHeader() {
        for (const [label, x] of [['Tab', 36], ['Sheet X (mm)', 81], ['Sheet Y (mm)', 175], ['Tab Z (mm)', 269], ['Source / operation', 355]] as const) text(detail, label, x, y, 8)
        detail.drawLine({ start: { x: 36, y: y - 7 }, end: { x: 559, y: y - 7 }, thickness: 0.5, color: grey })
        y -= 25
      }
      if (part.tabs.length) tableHeader()
      for (const [index, tab] of part.tabs.entries()) {
        if (y < 115) { detail = page(`${part.number} | Tab positions continued`, `Sheet ${sheetIndex + 1} | ${part.name}`); y = 714; tableHeader() }
        text(detail, `T${index + 1}`, 36, y, 9, 40)
        text(detail, tab.center.x.toFixed(2), 81, y, 9, 90)
        text(detail, tab.center.y.toFixed(2), 175, y, 9, 90)
        text(detail, tab.z.toFixed(2), 269, y, 9, 80)
        text(detail, `${tab.inferred ? 'Inferred' : 'Marked'} / ${tab.operation}`, 355, y, 8, 204)
        y -= 18
      }
      for (const warning of part.warnings) {
        if (y < 110) { detail = page(`${part.number} | Notes`, `Sheet ${sheetIndex + 1} | ${part.name}`); y = 715 }
        // Notes are deliberately short enough to retain their safety meaning without truncation.
        const words = warning.split(' ')
        let line = ''
        for (const word of words) {
          if (font.widthOfTextAtSize(`${line} ${word}`, 9) > 523) { text(detail, line, 36, y); y -= 14; line = '' }
          line = line ? `${line} ${word}` : word
        }
        text(detail, line, 36, y); y -= 24
      }
      text(detail, 'Coordinates: tab-span centre in sheet coordinates. Z is below the material surface.', 36, 78, 8)
      text(detail, 'Highlighted spans are cutter-centre paths; marks are enlarged for visibility.', 36, 62, 8)
    }
  }
  pdf.getPages().forEach((page, index) => text(page, `TAB REMOVAL MAP  |  Not to scale  |  Page ${index + 1} of ${pdf.getPageCount()}`, 36, 27, 8))
  return pdf.save()
}
