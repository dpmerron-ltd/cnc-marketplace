import { jsPDF } from 'jspdf'
import { loadLogo } from './labelLogo'

export const packagingLabels = [
  { id: 'fitting-kit', title: 'Fitting Kit', width: 152.4, height: 101.6, size: '6 × 4 inches', instruction: '' },
  { id: 'hardware', title: 'Hardware', width: 50, height: 25, size: '50 × 25 mm', instruction: '' },
  { id: 'drill-guide', title: 'Drill Guide', width: 50, height: 25, size: '50 × 25 mm', instruction: 'Pre-Drill all holes to 2mm' },
] as const
export type PackagingLabel = typeof packagingLabels[number]

export function validateLabelQuantity(quantity: number) {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) throw new Error('Choose a quantity from 1 to 100.')
}

export async function renderPackagingLabel(canvas: HTMLCanvasElement, label: PackagingLabel) {
  const logo = await loadLogo()
  const scale = 300 / 25.4
  canvas.width = Math.round(label.width * scale)
  canvas.height = Math.round(label.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Label preview is unavailable in this browser.')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, label.width, label.height)
  const large = label.id === 'fitting-kit'
  const logoHeight = large ? 25 : 7
  const logoWidth = Math.min(large ? 100 : 32, logoHeight * logo.naturalWidth / logo.naturalHeight)
  const actualHeight = logoWidth * logo.naturalHeight / logo.naturalWidth
  ctx.filter = 'grayscale(1) contrast(2)'
  ctx.drawImage(logo, (label.width - logoWidth) / 2, large ? 16 : 2, logoWidth, actualHeight)
  ctx.filter = 'none'
  ctx.fillStyle = '#000'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `700 ${large ? 15 : 5}px Arial, sans-serif`
  ctx.fillText(label.title, label.width / 2, large ? 65 : 14, label.width - 4)
  if (label.instruction) {
    ctx.font = '700 2.7px Arial, sans-serif'
    ctx.fillText(label.instruction, label.width / 2, 21, label.width - 4)
  }
}

export async function createPackagingLabelPdf(label: PackagingLabel, quantity: number): Promise<Blob> {
  validateLabelQuantity(quantity)
  const canvas = document.createElement('canvas')
  await renderPackagingLabel(canvas, label)
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [label.width, label.height], compress: true })
  pdf.setProperties({ title: `888 Van Racking - ${label.title}` })
  for (let i = 0; i < quantity; i++) {
    if (i) pdf.addPage()
    pdf.addImage(canvas, 'PNG', 0, 0, label.width, label.height, 'label', 'FAST')
  }
  return pdf.output('blob')
}
