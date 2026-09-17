import type { PackingSize } from './types'

export const boxSize = (size: PackingSize) => `${size.length / 10} x ${size.width / 10} x ${size.height / 10} cm`
