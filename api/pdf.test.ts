// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { generateJob, parseJobRequest } from '../src/jobs/generateJob'
import { testItem, testRequest } from '../src/test/jobFixtures'
import { hex, materialPart, natural } from '../src/test/materialFixtures'
import { jobPdfs } from './pdf'

it('prints material-specific plans and labels when the selected stock sheet stays empty', async () => {
  const job = await generateJob(parseJobRequest({ ...testRequest, items: [{ sku: testItem.sku, quantity: 1 }], sheet: { ...testRequest.sheet, stockMaterial: natural, thicknessMm: 12, screwMarks: false } }), [testItem], [materialPart('Front',hex)]).catch(error => { throw new Error(error.message + ': ' + error.details?.join('; ')) })
  expect(job.manifest.sheets[0].number).toBe(2)
  expect(job.manifest.cuts[0].material).toBe('12 mm Plywood · Black hex')
  const font = new Uint8Array(await readFile(new URL('./assets/NotoSans-Regular.ttf', import.meta.url)))
  const files = await jobPdfs(job, 'test', font)
  expect((await PDFDocument.load(files.plan)).getPageCount()).toBeGreaterThanOrEqual(4)
  expect((await PDFDocument.load(files.labels)).getPageCount()).toBe(1)
})
