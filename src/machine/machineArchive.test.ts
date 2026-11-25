import { expect, it } from 'vitest'
import { machineArchive } from './machineArchive'
import { ncHash, type ExportSnapshot } from './exportSnapshot'
import { defaultProgramSettings } from '../gcode/programSettings'
async function fixture() {
  const file = { filename: 'sheet-1.nc', gcode: 'G21\nM30', sheetIndices: [0], estimatedSeconds: 0, sha256: await ncHash('G21\nM30') }
  return { files: [file], machineVariants: ['andy', 'dan'].map(key => ({ key, label: key, programs: defaultProgramSettings, files: [{ ...file }] })) } as ExportSnapshot
}
it('refuses corrupt saved programs', async () => {
  const snapshot = await fixture(); snapshot.machineVariants![1].files[0].gcode = 'changed'
  await expect(machineArchive(snapshot)).rejects.toThrow('integrity')
})
it('rejects missing sheet coverage and unsafe archive paths', async () => {
  const snapshot = await fixture(); snapshot.machineVariants![1].files[0].sheetIndices = [1]
  await expect(machineArchive(snapshot)).rejects.toThrow('coverage')
  snapshot.machineVariants![1].files[0].sheetIndices = [0]
  snapshot.machineVariants![1].files[0].filename = '../outside.nc'
  await expect(machineArchive(snapshot)).rejects.toThrow('filename')
})
