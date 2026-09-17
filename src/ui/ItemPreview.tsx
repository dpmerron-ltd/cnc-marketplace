import { memo, useEffect, useRef } from 'react'
import { Package } from 'lucide-react'
import type { Part } from '../models/Part'

export const ItemPreview = memo(function ItemPreview({ parts, label }: { parts: Part[]; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const shown = parts.slice(0, 4)
    const columns = shown.length > 1 ? 2 : 1
    const rows = shown.length > 2 ? 2 : 1
    const width = canvas.width / columns, height = canvas.height / rows
    shown.forEach((part, index) => {
      const segments = part.toolpathPreview.filter(segment => segment.type !== 'rapid' && segment.type !== 'transition')
      if (!segments.length) return
      const bounds = segments.reduce((b, segment) => ({ minX: Math.min(b.minX, segment.bounds.minX), minY: Math.min(b.minY, segment.bounds.minY), maxX: Math.max(b.maxX, segment.bounds.maxX), maxY: Math.max(b.maxY, segment.bounds.maxY) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })
      if (!Object.values(bounds).every(Number.isFinite)) return
      const scale = Math.min((width - 48) / Math.max(1, bounds.maxX - bounds.minX), (height - 40) / Math.max(1, bounds.maxY - bounds.minY))
      ctx.save()
      ctx.translate((index % columns) * width + width / 2, Math.floor(index / columns) * height + height / 2)
      ctx.scale(scale, -scale)
      ctx.translate(-(bounds.minX + bounds.maxX) / 2, -(bounds.minY + bounds.maxY) / 2)
      ctx.strokeStyle = ['#177b69', '#326ab5', '#94549a', '#b56c20'][index]
      ctx.lineWidth = 2 / scale
      ctx.lineCap = 'round'
      for (const segment of segments) {
        ctx.beginPath()
        if (segment.type === 'drill') {
          ctx.arc(segment.end.x, segment.end.y, 3 / scale, 0, 2 * Math.PI)
        } else if (segment.center && (segment.type === 'arc-cw' || segment.type === 'arc-ccw')) {
          const radius = Math.hypot(segment.start.x - segment.center.x, segment.start.y - segment.center.y)
          const start = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x)
          let end = Math.atan2(segment.end.y - segment.center.y, segment.end.x - segment.center.x)
          if (Math.hypot(segment.start.x - segment.end.x, segment.start.y - segment.end.y) < 0.0001) end = start + (segment.type === 'arc-cw' ? -1 : 1) * Math.PI * 2
          ctx.arc(segment.center.x, segment.center.y, radius, start, end, segment.type === 'arc-cw')
        } else {
          ctx.moveTo(segment.start.x, segment.start.y)
          ctx.lineTo(segment.end.x, segment.end.y)
        }
        ctx.stroke()
      }
      ctx.restore()
    })
  }, [parts])
  return <div className="items-preview">
    {parts.length ? <canvas ref={ref} width={640} height={320} role="img" aria-label={label} /> : <Package size={32} aria-label="No components" />}
    {parts.length > 4 && <span className="items-preview-extra">+{parts.length - 4}</span>}
  </div>
})
