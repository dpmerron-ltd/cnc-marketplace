import type { OperationKind } from '../cam/types'

export const operationColors: Record<OperationKind, string> = { outside: '#005ea8', inside: '#946600', drill: '#7040a0', pocket: '#374151', ignore: '#68727d', unassigned: '#242424' }
export const operationDashes: Record<OperationKind, number[]> = { outside: [], inside: [8, 5], drill: [], pocket: [1, 4], ignore: [6, 6], unassigned: [8, 3, 1, 3] }
export const operationLineStyles = { outside: 'solid', inside: 'dashed', drill: 'solid', pocket: 'dotted', ignore: 'dashed', unassigned: 'dashed' } as const
export const tabColor = '#f3c64e'
export const tabOutlineColor = '#28303a'
export const operationNames: Record<OperationKind, string> = { outside: 'Profile / outside', inside: 'Inside cut / door', drill: 'Drill', pocket: 'Blind pocket', ignore: 'Exclude', unassigned: 'Unassigned' }
