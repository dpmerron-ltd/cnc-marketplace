import { strToU8, zipSync } from 'fflate'
import { ncHash, type ExportSnapshot } from './exportSnapshot'
export async function machineArchive(snapshot: ExportSnapshot): Promise<Uint8Array> {
  const variants = snapshot.machineVariants
  if (!variants || variants.length !== 2 || new Set(variants.map(v => v.key)).size !== 2 || variants.some(v => !['andy', 'dan'].includes(v.key))) throw new Error('Both machine profiles are required.')
  const entries: Record<string, Uint8Array> = {}
  for (const variant of variants) {
    if (variant.files.length !== snapshot.files.length) throw new Error('Machine profile sheet coverage differs.')
    const folder = variant.key === 'andy' ? 'Andy' : 'Dan'
    for (const [index, file] of variant.files.entries()) {
      if (JSON.stringify(file.sheetIndices) !== JSON.stringify(snapshot.files[index].sheetIndices)) throw new Error('Machine profile sheet coverage differs.')
      if (!file.filename || /[/\\]/.test(file.filename) || file.filename === '..') throw new Error('Invalid program filename.')
      if (await ncHash(file.gcode) !== file.sha256) throw new Error('Saved file integrity check failed. Do not run this file.')
      const path = `${folder}/${file.filename}`
      if (entries[path]) throw new Error('Duplicate program filename.')
      entries[path] = strToU8(file.gcode)
    }
  }
  entries['README.txt'] = strToU8('Andy/ and Dan/ contain alternative machine programs for the SAME physical sheets. Cut each sheet once, using the folder for the chosen machine. Programs are the saved settings at export time.\n')
  return zipSync(entries)
}
export function downloadMachineArchive(bytes: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/zip' }))
  const link = document.createElement('a'); link.href = url; link.download = `${name}-Andy-and-Dan.zip`
  document.body.appendChild(link); link.click(); link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
