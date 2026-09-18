import { CirclePlus } from 'lucide-react'
import type { OperationKind } from '../cam/types'
import { operationColors, operationLineStyles } from './camAppearance'

export function CamOperationSwatch({ kind }: { kind: OperationKind }) {
  return <span className="cam-operation-swatch" aria-hidden="true" style={{ color: operationColors[kind] }}>
    {kind === 'drill' ? <CirclePlus size={16} /> : <i style={{ borderTopStyle: operationLineStyles[kind] }} />}
  </span>
}
