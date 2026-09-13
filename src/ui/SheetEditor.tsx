import { useMemo, useState } from 'react'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { rectsOverlap } from '../models/geometry'
import { instanceBounds, transformPartProgram } from '../gcode/transform'
import type { ToolpathSegment } from '../gcode/types'

interface SheetEditorProps {
  parts: Part[]
  sheet: Sheet
  selectedId?: string
  onAddPart: (partId: string, x: number, y: number) => void
  onSelect: (instanceId: string) => void
  onUpdateInstance: (instanceId: string, patch: Partial<PartInstance>) => void
}

const viewPadding = 34
const twoPi = Math.PI * 2

function normalizeAngle(angle: number): number {
  return ((angle % twoPi) + twoPi) % twoPi
}

function arcPolylinePoints(segment: ToolpathSegment): string {
  if (!segment.center || (segment.type !== 'arc-cw' && segment.type !== 'arc-ccw')) {
    return `${segment.start.x},${segment.start.y} ${segment.end.x},${segment.end.y}`
  }

  const radius = Math.hypot(segment.start.x - segment.center.x, segment.start.y - segment.center.y)
  if (radius < 0.001) {
    return `${segment.start.x},${segment.start.y} ${segment.end.x},${segment.end.y}`
  }

  const startAngle = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x)
  const endAngle = Math.atan2(segment.end.y - segment.center.y, segment.end.x - segment.center.x)
  const sameEndpoint = Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) < 0.001
  const sweep =
    segment.type === 'arc-cw'
      ? sameEndpoint
        ? twoPi
        : normalizeAngle(startAngle - endAngle)
      : sameEndpoint
        ? twoPi
        : normalizeAngle(endAngle - startAngle)
  const steps = Math.max(16, Math.min(160, Math.ceil((radius * sweep) / 4)))
  const points: string[] = []

  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps
    const angle = segment.type === 'arc-cw' ? startAngle - sweep * progress : startAngle + sweep * progress
    points.push(`${segment.center.x + Math.cos(angle) * radius},${segment.center.y + Math.sin(angle) * radius}`)
  }

  return points.join(' ')
}

export function SheetEditor({ parts, sheet, selectedId, onAddPart, onSelect, onUpdateInstance }: SheetEditorProps) {
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number }>()
  const scale = Math.min(820 / sheet.width, 620 / sheet.height)
  const svgWidth = sheet.width * scale + viewPadding * 2
  const svgHeight = sheet.height * scale + viewPadding * 2

  const placed = useMemo(
    () =>
      sheet.instances
        .map((instance) => {
          const part = parts.find((candidate) => candidate.id === instance.partId)
          return part ? { instance, part, bounds: instanceBounds(part, instance), transformed: transformPartProgram(part, instance) } : undefined
        })
        .filter(Boolean) as Array<{
        instance: PartInstance
        part: Part
        bounds: ReturnType<typeof instanceBounds>
        transformed: ReturnType<typeof transformPartProgram>
      }>,
    [parts, sheet.instances],
  )

  const collidingIds = new Set<string>()
  for (let a = 0; a < placed.length; a += 1) {
    for (let b = a + 1; b < placed.length; b += 1) {
      if (rectsOverlap(placed[a].bounds, placed[b].bounds, sheet.spacing)) {
        collidingIds.add(placed[a].instance.id)
        collidingIds.add(placed[b].instance.id)
      }
    }
  }

  function toSheetPoint(clientX: number, clientY: number, target: SVGSVGElement) {
    const rect = target.getBoundingClientRect()
    return {
      x: (clientX - rect.left - viewPadding) / scale,
      y: (clientY - rect.top - viewPadding) / scale,
    }
  }

  return (
    <main className="sheet-wrap">
      <svg
        className="sheet"
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const partId = event.dataTransfer.getData('text/part-id')
          if (!partId) return
          const point = toSheetPoint(event.clientX, event.clientY, event.currentTarget)
          onAddPart(partId, Math.max(0, point.x), Math.max(0, point.y))
        }}
        onPointerMove={(event) => {
          if (!dragging) return
          const point = toSheetPoint(event.clientX, event.clientY, event.currentTarget)
          onUpdateInstance(dragging.id, { x: Math.max(0, point.x - dragging.dx), y: Math.max(0, point.y - dragging.dy) })
        }}
        onPointerUp={() => setDragging(undefined)}
        onPointerLeave={() => setDragging(undefined)}
      >
        <g transform={`translate(${viewPadding} ${viewPadding}) scale(${scale})`}>
          <rect width={sheet.width} height={sheet.height} className="sheet-boundary" />
          {placed.map(({ transformed, instance }) =>
            transformed.segments.map((segment, index) =>
              segment.type === 'arc-cw' || segment.type === 'arc-ccw' ? (
                <polyline
                  key={`${instance.id}-${index}`}
                  points={arcPolylinePoints(segment)}
                  className={`toolpath ${segment.type} ${selectedId === instance.id ? 'active' : ''}`}
                />
              ) : (
                <line
                  key={`${instance.id}-${index}`}
                  x1={segment.start.x}
                  y1={segment.start.y}
                  x2={segment.end.x}
                  y2={segment.end.y}
                  className={`toolpath ${segment.type} ${selectedId === instance.id ? 'active' : ''}`}
                />
              ),
            ),
          )}
          {placed.map(({ instance, part, bounds }) => {
            const isSelected = selectedId === instance.id
            const outOfBounds = bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > sheet.width || bounds.maxY > sheet.height
            return (
              <g key={instance.id}>
                <rect
                  x={bounds.minX}
                  y={bounds.minY}
                  width={bounds.maxX - bounds.minX}
                  height={bounds.maxY - bounds.minY}
                  className={`part-outline ${isSelected ? 'selected' : ''} ${collidingIds.has(instance.id) || outOfBounds ? 'invalid' : ''}`}
                  onPointerDown={(event) => {
                    const svg = event.currentTarget.ownerSVGElement
                    if (!svg) return
                    const point = toSheetPoint(event.clientX, event.clientY, svg)
                    onSelect(instance.id)
                    setDragging({ id: instance.id, dx: point.x - instance.x, dy: point.y - instance.y })
                  }}
                />
                <text x={bounds.minX + 5} y={bounds.minY + 16} className="part-label">
                  {part.name}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </main>
  )
}
