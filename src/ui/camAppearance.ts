import type { OperationKind } from '../cam/types'

export const operationColors: Record<OperationKind, string> = { outside: '#168047', inside: '#007caa', drill: '#c14424', pocket: '#a34096', ignore: '#84909a', unassigned: '#c33b42' }
export const operationNames: Record<OperationKind, string> = { outside: 'Profile / outside', inside: 'Door / inside', drill: 'Drill', pocket: 'Circular pocket', ignore: 'Exclude', unassigned: 'Unassigned' }
