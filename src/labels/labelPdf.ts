import { drawPartBarcode, partBarcodeUrl } from './partBarcode'
// Load with the app so an open tab can still print after deployment removes old chunks.
import { jsPDF } from 'jspdf'
import { labelPageLayout, type LabelLayout, type PartLabel } from './partLabels'
import { cutSideLabel } from '../models/cutSide'

// Render at 300 dpi using browser fonts, including Unicode component and job names.
export function renderLabel(canvas: HTMLCanvasElement, label: PartLabel, layout: LabelLayout) {
  labelPageLayout(layout)
  const scale = 300 / 25.4
  canvas.width = Math.round(layout.width * scale)
  canvas.height = Math.round(layout.height * scale)
  const ctx = canvas.getContext('2d')!
  ctx.scale(scale, scale)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, layout.width, layout.height)
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'top'
  const padding = 1.5
  const hasBarcode = Boolean(partBarcodeUrl(label.instanceId))
  const qrSize = Math.min(23, layout.height - 6)
  const width = layout.width - padding * 2 - (hasBarcode ? qrSize + 1 : 0)
  if (hasBarcode) drawPartBarcode(ctx, label.instanceId, layout.width - padding - qrSize, padding, qrSize)
  const unit = Math.min(1, (layout.height - padding * 2) / 22)
  function line(text: string, y: number, size: number, bold = false, maxWidth = width, x = padding) {
    const clean = text.replace(/\s+/g, ' ').trim()
    ctx.font = `${bold ? '700' : '400'} ${size * unit}px Arial, sans-serif`
    let fitted = clean
    while (fitted && ctx.measureText(fitted).width > maxWidth) fitted = fitted.slice(0, -1)
    if (fitted !== clean) {
      while (fitted && ctx.measureText(`${fitted}...`).width > maxWidth) fitted = fitted.slice(0, -1)
      fitted += '...'
    }
    ctx.fillText(fitted, x, padding + y * unit)
  }
  line(`${label.partNumber} · S${label.sheetNumber}`, 0, 3.3, true)
  line(label.component, 4.9, 2.7, true)
  line(`Job: ${label.job}`, 8.3, 2.4)
  line(`Order: ${label.order}`, 11.3, 2.4)
  line(`SKU: ${label.sku}`, 14.3, 2.2)
  line(label.material || label.item || `X ${label.x.toFixed(1)} / Y ${label.y.toFixed(1)} mm`, 17.3, 2.2)
  if (hasBarcode) {
    ctx.font = '1.8px monospace'
    const id = label.instanceId.toUpperCase()
    const size = Math.min(1.8, 1.8 * (layout.width - padding * 2) / Math.max(ctx.measureText(id).width, 1))
    ctx.font = `${size}px monospace`
    ctx.fillText(id, padding, layout.height - 2.5)
  }
  line(label.cutSide && label.cutSide !== 'either' ? cutSideLabel(label.cutSide) : `X ${label.x.toFixed(1)}  Y ${label.y.toFixed(1)} mm / ${label.rotation} deg`, 19.7, 1.4)
}

export async function createLabelPdf(labels: PartLabel[], layout: LabelLayout): Promise<Blob> {
  if (!labels.length) throw new Error('No parts on the selected sheet.')
  const page = labelPageLayout(layout)
  const pdf = new jsPDF({ orientation: page.pageWidth > page.pageHeight ? 'landscape' : 'portrait', unit: 'mm', format: [page.pageWidth, page.pageHeight], compress: true })
  pdf.setProperties({ title: `${labels[0].job} - Part labels` })
  const canvas = document.createElement('canvas')
  for (const [index, label] of labels.entries()) {
    if (index % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0))
    if (index > 0 && index % page.perPage === 0) pdf.addPage()
    const slot = index % page.perPage
    renderLabel(canvas, label, layout)
    pdf.addImage(canvas, 'PNG', page.margin + (slot % page.columns) * (layout.width + 2), page.margin + Math.floor(slot / page.columns) * (layout.height + 2), layout.width, layout.height, undefined, 'FAST')
  }
  return pdf.output('blob')
}
