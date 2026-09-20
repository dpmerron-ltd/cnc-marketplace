import { useMemo, useState } from 'react'
import { partNumberText } from '../labels/partLabels'
import type { Part } from '../models/Part'
import type { PartInstance } from '../models/PartInstance'
import type { Sheet } from '../models/Sheet'
import { footprintInterior, footprintsOverlap, instanceFootprint } from '../gcode/footprint'
import { instanceBounds, transformPartProgram } from '../gcode/transform'
import type { ToolpathSegment } from '../gcode/types'
import { planScrewPositions } from '../gcode/screwPositions'

interface SheetEditorProps {
  parts: Part[]
  sheet: Sheet
  sheetIndex: number
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

export function SheetEditor({ parts, sheet, sheetIndex, selectedId, onAddPart, onSelect, onUpdateInstance }: SheetEditorProps) {
  const [dragging, setDragging] = useState<{ id: string; dx: number; dy: number }>()
  const scale = Math.min(820 / sheet.width, 620 / sheet.height)
  const svgWidth = sheet.width * scale + viewPadding * 2
  const svgHeight = sheet.height * scale + viewPadding * 2
  const screwPlan = useMemo(() => planScrewPositions(parts, sheet, sheetIndex), [parts, sheet, sheetIndex])

  const placed = useMemo(
    () =>
      sheet.instances
        .filter((instance) => instance.sheetIndex === sheetIndex)
        .map((instance) => {
          const part = parts.find((candidate) => candidate.id === instance.partId)
          return part ? { instance, part, footprint: instanceFootprint(part, instance), bounds: instanceBounds(part, instance), transformed: transformPartProgram(part, instance) } : undefined
        })
        .filter(Boolean) as Array<{
        instance: PartInstance
        part: Part
        bounds: ReturnType<typeof instanceBounds>
        footprint: ReturnType<typeof instanceFootprint>
        transformed: ReturnType<typeof transformPartProgram>
      }>,
    [parts, sheet.instances, sheetIndex],
  )

  const collidingIds = new Set<string>()
  for (let a = 0; a < placed.length; a += 1) {
    for (let b = a + 1; b < placed.length; b += 1) {
      if (footprintsOverlap(placed[a].footprint, placed[b].footprint, sheet.spacing)) {
        collidingIds.add(placed[a].instance.id)
        collidingIds.add(placed[b].instance.id)
      }
    }
  }

  function toSheetPoint(clientX: number, clientY: number, target: SVGSVGElement) {
    const rect = target.getBoundingClientRect()
    return {
      x: (clientX - rect.left - viewPadding) / scale,
      y: sheet.height - (clientY - rect.top - viewPadding) / scale,
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
        <g transform={`translate(${viewPadding} ${viewPadding + sheet.height * scale}) scale(${scale} ${-scale})`}>
          <rect width={sheet.width} height={sheet.height} className="sheet-boundary" />
          {sheet.borderSpacing > 0 && (
            <rect
              x={sheet.borderSpacing}
              y={sheet.borderSpacing}
              width={Math.max(0, sheet.width - sheet.borderSpacing * 2)}
              height={Math.max(0, sheet.height - sheet.borderSpacing * 2)}
              className="border-spacing-guide"
            />
          )}
          <g className="origin-marker">
            <line x1={0} y1={0} x2={Math.min(80, sheet.width * 0.12)} y2={0} />
            <line x1={0} y1={0} x2={0} y2={Math.min(80, sheet.height * 0.12)} />
            <circle cx={0} cy={0} r={4} />
            <text transform="translate(8 16) scale(1 -1)">X0 Y0</text>
            <text transform={`translate(${Math.min(86, sheet.width * 0.12 + 8)} 5) scale(1 -1)`}>+X</text>
            <text transform={`translate(6 ${Math.min(86, sheet.height * 0.12 + 8)}) scale(1 -1)`}>+Y</text>
          </g>
          {placed.map(({ transformed, instance }) =>
            transformed.segments.map((segment, index) =>
              index === 0 && segment.type === 'rapid' ? null : segment.type === 'arc-cw' || segment.type === 'arc-ccw' ? (
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
          {screwPlan.points.map((point, index) => (
            <g key={`${point.x},${point.y}`} className="screw-mark" pointerEvents="none">
              <title>{`Screw mark ${index + 1}: X${point.x} Y${point.y}, depth 2 mm`}</title>
              <circle cx={point.x} cy={point.y} r={3} />
              <line x1={point.x - 6} y1={point.y} x2={point.x + 6} y2={point.y} />
              <line x1={point.x} y1={point.y - 6} x2={point.x} y2={point.y + 6} />
            </g>
          ))}
          {placed.map(({ instance, part, bounds, footprint }) => {
            const isSelected = selectedId === instance.id
            const label = partNumberText(instance.partNumber!)
            const interior = footprintInterior(footprint)
            const labelSize = Math.max(1, Math.min(24, Math.max(0, interior.radius - 3) * 2 / Math.hypot(label.length * 0.7, 1)))
            const outOfBounds = bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > sheet.width || bounds.maxY > sheet.height
            return (
              <g key={instance.id}>
                <title>{`${partNumberText(instance.partNumber!)}: ${part.name}`}</title>
                <polygon
                  points={footprint.map(p => `${p.x},${p.y}`).join(' ')}
                  className={`part-outline ${isSelected ? 'selected' : ''} ${collidingIds.has(instance.id) || outOfBounds ? 'invalid' : ''}`}
                  onPointerDown={(event) => {
                    const svg = event.currentTarget.ownerSVGElement
                    if (!svg) return
                    const point = toSheetPoint(event.clientX, event.clientY, svg)
                    onSelect(instance.id)
                    setDragging({ id: instance.id, dx: point.x - instance.x, dy: point.y - instance.y })
                  }}
                />
                <text transform={`translate(${interior.center.x} ${interior.center.y}) scale(1 -1)`} textAnchor="middle" dominantBaseline="central" style={{ fontSize: labelSize }} className="part-label">
                  {label}
                </text>
              </g>
            )
          })}
        </g>
      </svg>
    </main>
  )
}
