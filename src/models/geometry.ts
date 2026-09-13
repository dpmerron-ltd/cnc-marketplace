export type Rotation = 0 | 90 | 180 | 270

export interface Point {
  x: number
  y: number
}

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface Size {
  width: number
  height: number
}

export const emptyBounds = (): Bounds => ({
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY,
})

export function includePoint(bounds: Bounds, point: Point): Bounds {
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  }
}

export function isFiniteBounds(bounds: Bounds): boolean {
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY].every(Number.isFinite)
}

export function boundsSize(bounds: Bounds): Size {
  if (!isFiniteBounds(bounds)) return { width: 0, height: 0 }
  return { width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY }
}

export function rotatedSize(size: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : size
}

export function rotatePointInBounds(point: Point, size: Size, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return point
    case 90:
      return { x: size.height - point.y, y: point.x }
    case 180:
      return { x: size.width - point.x, y: size.height - point.y }
    case 270:
      return { x: point.y, y: size.width - point.x }
  }
}

export function rotateVector(point: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return point
    case 90:
      return { x: -point.y, y: point.x }
    case 180:
      return { x: -point.x, y: -point.y }
    case 270:
      return { x: point.y, y: -point.x }
  }
}

export function rectsOverlap(a: Bounds, b: Bounds, spacing = 0): boolean {
  return !(
    a.maxX + spacing <= b.minX ||
    b.maxX + spacing <= a.minX ||
    a.maxY + spacing <= b.minY ||
    b.maxY + spacing <= a.minY
  )
}
