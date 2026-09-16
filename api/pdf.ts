import { PDFDocument, rgb, type PDFPage, type PDFFont } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { generateJob } from '../src/jobs/generateJob'
import { JobError } from '../src/jobs/generateJob'

type Generated = Awaited<ReturnType<typeof generateJob>>
const mm = 72 / 25.4
const ink = rgb(0.1, 0.13, 0.16)

async function document(fontBytes: Uint8Array, title: string) {
  const pdf = await PDFDocument.create()
  pdf.registerFontkit(fontkit)
  const font = await pdf.embedFont(fontBytes, { subset: true })
  pdf.setTitle(title)
  pdf.setCreator('CNC Marketplace Jobs API v1')
  return { pdf, font }
}

function singleLine(value: string) { return value.replace(/\s+/g, ' ').trim() }
function fitted(font: PDFFont, text: string, size: number, width: number) {
  const value = singleLine(text)
  if (font.widthOfTextAtSize(value, size) <= width) return value
  return `${value.slice(0, prefixLength(font, value, size, width - font.widthOfTextAtSize('...', size)))}...`
}
function prefixLength(font: PDFFont, value: string, size: number, width: number) {
  let low = 0, high = value.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (font.widthOfTextAtSize(value.slice(0, mid), size) <= width) low = mid
    else high = mid - 1
  }
  return low
}
function wrap(font: PDFFont, value: string, size: number, width: number) {
  const lines: string[] = []
  for (const paragraph of value.split(/\r?\n/)) {
    let line = ''
    for (let word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (line && font.widthOfTextAtSize(candidate, size) > width) { lines.push(line); line = '' }
      while (font.widthOfTextAtSize(word, size) > width) {
        const length = Math.max(1, prefixLength(font, word, size, width))
        lines.push(word.slice(0, length)); word = word.slice(length)
      }
      line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(line)
  }
  return lines
}

export async function jobPdfs(job: Generated, jobId: string, fontBytes: Uint8Array) {
  const { manifest } = job
  const request = manifest.request
  const { pdf, font } = await document(fontBytes, `${request.jobName} - Sheet plan and cutting list`)
  const supported = new Set(font.getCharacterSet())
  const content = [request.jobName, request.orderNumber, request.notes, request.sheet.material, ...manifest.cuts.flatMap(cut => [cut.component, cut.item, cut.sku, cut.sourceFilename])].join('')
  if (Array.from(content).some(char => !/\s/.test(char) && !supported.has(char.codePointAt(0)!))) throw new JobError('Job text contains characters unsupported by the PDF font. Use Latin, Greek or Cyrillic text for this API version.')
  let page!: PDFPage
  let y = 0
  function newPage(title: string) {
    page = pdf.addPage([210 * mm, 297 * mm])
    page.drawText(fitted(font, title, 17, 523), { x: 36, y: 800, size: 17, font, color: ink })
    page.drawText(fitted(font, `${request.jobName} | Order ${request.orderNumber}`, 9, 523), { x: 36, y: 778, size: 9, font, color: ink })
    page.drawText(`Job ${jobId} | Page ${pdf.getPageCount()}`, { x: 36, y: 22, size: 7, font, color: ink })
    y = 752
  }
  function paragraph(value: string, size = 10) {
    for (const line of wrap(font, value, size, 523)) {
      if (y < 48) newPage('Job Details - Continued')
      page.drawText(line, { x: 36, y, size, font, color: ink })
      y -= size + 5
    }
    y -= 6
  }
  newPage('Sheet Plan & Cutting List')
  paragraph('Status at generation: AWAITING REVIEW', 13)
  paragraph(`Job: ${request.jobName}`)
  paragraph(`Order: ${request.orderNumber}`)
  paragraph(`${manifest.sheets.length} sheets | ${manifest.cuts.length} parts | ${request.sheet.widthMm} x ${request.sheet.heightMm} mm stock`)
  paragraph(`Material: ${request.sheet.material}${request.sheet.thicknessMm ? ` | ${request.sheet.thicknessMm} mm thick` : ' | thickness not specified'}`)
  paragraph('Order Contents', 12)
  for (const item of manifest.items) paragraph(`${item.quantity} x ${item.name} [${item.sku}] - ${item.componentsPerItem} components per item`, 9)
  if (request.notes) { paragraph('Order Notes', 12); paragraph(request.notes) }
  paragraph('Setup & Specifics', 12)
  for (const note of manifest.setup) paragraph(note, 9)
  paragraph(`Validation: ${manifest.warnings.length} warning(s); no detected validation errors. This is not a physical machine safety certification.`, 9)
  for (const warning of manifest.warnings) paragraph(warning, 9)

  for (const sheet of manifest.sheets) {
    newPage(`Sheet ${sheet.number} of ${manifest.sheets.length}`)
    paragraph(`${sheet.partCount} parts | Reach X${sheet.maxX.toFixed(2)} Y${sheet.maxY.toFixed(2)} mm | deepest cut ${sheet.deepestCutMm.toFixed(2)} mm`, 9)
    paragraph(`Safe Z ${request.sheet.safeZMm} mm | ${sheet.screwMarks} screw marks | estimated ${Math.ceil(sheet.estimatedSeconds / 60)} minutes (excluding setup)`, 9)
    const scale = Math.min(505 / job.sheet.width, 570 / job.sheet.height)
    const x = 45, bottom = y - job.sheet.height * scale - 15
    page.drawRectangle({ x, y: bottom, width: job.sheet.width * scale, height: job.sheet.height * scale, borderColor: ink, borderWidth: 0.8 })
    const cuts = manifest.cuts.filter(cut => cut.sheetNumber === sheet.number)
    for (const cut of cuts) page.drawRectangle({ x: x + cut.bounds.minX * scale, y: bottom + cut.bounds.minY * scale, width: (cut.bounds.maxX - cut.bounds.minX) * scale, height: (cut.bounds.maxY - cut.bounds.minY) * scale, color: rgb(0.93, 0.95, 0.96) })
    const drawn = new Set<string>()
    for (const move of job.simulations[sheet.number - 1].moves.filter(move => move.type !== 'rapid')) {
      if (move.start.x === move.end.x && move.start.y === move.end.y && move.end.z < move.start.z) {
        const key = `plunge:${move.end.x.toFixed(3)},${move.end.y.toFixed(3)}`
        if (!drawn.has(key)) page.drawCircle({ x: x + move.end.x * scale, y: bottom + move.end.y * scale, size: 1.3, color: rgb(0.12, 0.35, 0.45) })
        drawn.add(key)
      }
      for (let i = 1; i < move.points.length; i++) {
        const a = move.points[i - 1], b = move.points[i]
        const key = `${a.x.toFixed(3)},${a.y.toFixed(3)},${b.x.toFixed(3)},${b.y.toFixed(3)}`
        if (drawn.has(key)) continue
        drawn.add(key)
        page.drawLine({ start: { x: x + a.x * scale, y: bottom + a.y * scale }, end: { x: x + b.x * scale, y: bottom + b.y * scale }, color: rgb(0.12, 0.35, 0.45), thickness: 0.4 })
      }
    }
    for (const cut of cuts) {
      const width = (cut.bounds.maxX - cut.bounds.minX) * scale
      const size = Math.max(2, Math.min(10, width / (cut.partNumber.length * 0.7), (cut.bounds.maxY - cut.bounds.minY) * scale / 2))
      const tx = x + cut.bounds.minX * scale + 1, ty = bottom + cut.bounds.maxY * scale - size - 1
      page.drawRectangle({ x: tx, y: ty - 1, width: font.widthOfTextAtSize(cut.partNumber, size) + 2, height: size + 3, color: rgb(1, 1, 1) })
      page.drawText(cut.partNumber, { x: tx + 1, y: ty, font, size, color: ink })
    }
    page.drawText('X0 Y0 / X right, Y up / Dots: plunge locations / Not to scale', { x, y: bottom - 15, size: 8, font, color: ink })
  }
  newPage('Cutting List')
  paragraph('One row per placed component. Dimensions are unrotated machining footprints.', 9)
  for (const cut of manifest.cuts) {
    if (y < 130) newPage('Cutting List - Continued')
    paragraph(`${cut.partNumber} | Sheet ${cut.sheetNumber} | Job cut ${cut.cutOrder} | ${cut.component}`, 11)
    paragraph(`Item: ${cut.item} | SKU: ${cut.sku}`, 9)
    paragraph(`${cut.widthMm.toFixed(2)} x ${cut.heightMm.toFixed(2)} mm | X${cut.x.toFixed(2)} Y${cut.y.toFixed(2)} | ${cut.rotation} deg | depth ${cut.deepestCutMm.toFixed(2)} mm`, 9)
    paragraph(`Source: ${cut.sourceFilename}`, 8)
  }
  newPage('Source Program Specifics')
  for (const source of manifest.sources) {
    paragraph(source.filename, 11)
    paragraph(`Source feed values (mm/min): ${source.feeds.join(', ') || 'not specified'}`, 9)
    paragraph(`Source spindle values (rpm): ${source.spindleSpeeds.join(', ') || 'not specified'}; job start: 18000 rpm.`, 9)
    paragraph(`SHA-256: ${source.sha256}`, 7)
  }
  const labels = await document(fontBytes, `${request.jobName} - Part labels`)
  for (const cut of manifest.cuts) {
    const width = request.labels.widthMm * mm, height = request.labels.heightMm * mm
    const label = labels.pdf.addPage([width, height])
    const unit = Math.min(1, (request.labels.heightMm - 3) / 22)
    const pad = 1.5 * mm, usable = width - pad * 2
    function line(value: string, top: number, size: number, lineWidth = usable, x = pad) {
      const points = size * mm * unit
      label.drawText(fitted(labels.font, value, points, lineWidth), { x, y: height - pad - top * mm * unit - points, size: points, font: labels.font, color: ink })
    }
    line(cut.partNumber, 0, 4.3, usable * 0.53)
    line(`Sheet ${cut.sheetNumber} / Cut ${cut.cutOrder}`, 1, 2.1, usable * 0.46, pad + usable * 0.54)
    line(cut.component, 4.9, 2.7)
    line(`Job: ${cut.job}`, 8.3, 2.4)
    line(`Order: ${cut.order}`, 11.3, 2.4)
    line(`SKU: ${cut.sku}`, 14.3, 2.2)
    line(cut.material || cut.item, 17.3, 2.2)
    line(`X ${cut.x.toFixed(1)} Y ${cut.y.toFixed(1)} mm / ${cut.rotation} deg`, 20, 1.9)
  }
  return { plan: await pdf.save(), labels: await labels.pdf.save() }
}
