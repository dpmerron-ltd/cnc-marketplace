import { describe, expect, it } from 'vitest'
import { defaultProgramSettings, normalizePrograms, spindleRpm, validatePrograms } from './programSettings'
import { generateCam } from '../cam/generate'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem, testParts, testRequest } from '../test/jobFixtures'

describe('account CNC programs', () => {
  it('validates supported setup, spindle delay, shutdown and parking commands', () => {
    const programs = { startGcode: '(Account setup)\nG21 G17 G90 G94\nG54\nG40 G49 G80\nM08', spindleStartGcode: 'S16000 M03\nG04 P3', endGcode: 'M05\nM09\nG00 Z25\nG00 X0 Y0\nM30' }
    expect(validatePrograms(programs)).toEqual([])
    expect(spindleRpm(programs)).toBe(16000)
    expect(normalizePrograms({ ...programs, endGcode: ' M05\r\nM30\r\n' }).endGcode).toBe('M05\nM30')
    expect(validatePrograms(programs, 30).join()).toContain('safe Z 30')
  })
  it.each(['G20', 'G91', 'G92 X0', 'G10 L2 P1 X0', 'G28', 'G53 G00 Z0', 'G01 Z-2 F600', 'M30', 'S18000 M03', 'G00 Z0.5', '(comment) M30', 'G21 garbage', 'G21.1', 'G04', 'G00 Z20\nG00 X999999'])('rejects incompatible startup: %s', startGcode => {
    expect(validatePrograms({ ...defaultProgramSettings, startGcode }).length).toBeGreaterThan(0)
  })
  it.each(['M30', 'M05\nM30\nG00 X0', 'M05', 'M05\nG01 Z-2\nM30'])('rejects invalid ending: %s', endGcode => {
    expect(validatePrograms({ ...defaultProgramSettings, endGcode }).length).toBeGreaterThan(0)
  })
  it.each(['S0 M03', 'S18000 M03 M05', 'M03', 'S18000 M04', 'S18000 M03\nG00 X0'])('requires an explicit running clockwise spindle: %s', spindleStartGcode => {
    expect(validatePrograms({ ...defaultProgramSettings, spindleStartGcode }).length).toBeGreaterThan(0)
  })
  it('bounds programs and blocks malformed syntax rather than ignoring it', () => {
    for (const code of ['', '\n', '(open', '%', '#1=2', 'G21\n'.repeat(101), '('.concat('a'.repeat(8000), ')')]) expect(validatePrograms({ ...defaultProgramSettings, startGcode: code }).length).toBeGreaterThan(0)
  })
  it('applies custom programs to DXF generation without changing pecks or depths', () => {
    const programs = { ...defaultProgramSettings, startGcode: '(Alice setup)\nG21 G90\nM08', spindleStartGcode: 'S16000 M03\nG04 P2', endGcode: 'M05\nM09\n(Alice ending)\nM30' }
    const job = generateCam({ units: 'mm', errors: [], warnings: [], features: [{ id: 'p', name: 'Hole', layer: 'DRILL', points: [{ x: 20, y: 20 }], kind: 'drill', closed: false }] }, { thickness: 18, units: 'mm', operations: {}, programs })
    expect(job.errors).toEqual([])
    expect(job.gcode).toContain(programs.startGcode)
    expect(job.gcode).toContain(programs.spindleStartGcode)
    expect(job.gcode.endsWith(`${programs.endGcode}\n`)).toBe(true)
    expect(job.gcode).toContain('G01 Z-2 F600\nG00 Z0.5')
    expect(job.simulation.deepestCutMm).toBe(9.2)
  })
  it('snapshots profile programs on every physical sheet without starting the spindle before reach checks', async () => {
    const programs = { ...defaultProgramSettings, startGcode: '(Bob setup)\nG21 G90', spindleStartGcode: 'S17000 M03\nG04 P1', endGcode: 'M05\nM09\nM30' }
    const result = await generateJob(parseJobRequest(testRequest), [testItem], testParts, programs)
    expect(result.manifest.programSettings).toEqual(programs)
    expect(result.exported.length).toBeGreaterThan(1)
    for (const sheet of result.exported) {
      expect(sheet.gcode).toContain(programs.startGcode)
      expect(sheet.gcode.indexOf('Reach check:')).toBeLessThan(sheet.gcode.indexOf('S17000 M03'))
      expect(sheet.gcode.endsWith(`${programs.endGcode}\n`)).toBe(true)
    }
  })
})
