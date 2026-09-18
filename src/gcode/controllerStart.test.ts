import { describe, expect, it } from 'vitest'
import { controllerStartBegin, controllerStartEnd, controllerStartWarnings, hasControllerStart } from './controllerStart'
import { defaultProgramSettings, startProgramLines, validatePrograms } from './programSettings'
import { parseGCode } from './parser'
import { simulateGCode } from './simulator'
import { createPartFromGCode } from './importPart'
import { transformPartProgram } from './transform'
import { generateCam } from '../cam/generate'
import { generateJob, parseJobRequest } from '../jobs/generateJob'
import { testItem, testParts, testRequest } from '../test/jobFixtures'

const start = `M98 P"0:/macros/Probe"
M400

M291 P"Make sure the 5 mm probe is connected and positioned under the tool."R"Warning" S3

M400
G91
M563 P999 S"Z-Probe"
T999
M585 Z10 E3 L0 F500 S1
T-1
M400
G10 L20 Z5
G1 Z3 F500
G90

M291 P"Remove the touch probe, then press OK to continue." R"Remove probe" S3
M563 P999 D-1 H-1

G21
G90
G94
M03 S1000
G00 Z5.0000`
const programs = { ...defaultProgramSettings, startGcode: start }
const tail = '\n(No. 1: Test)\nG00 X10 Y10\nG01 Z-2 F600\nG01 X30 Y10 F3000\nG00 Z20\nM05\nM30'
const source = () => startProgramLines(programs, 20).join('\n') + tail

describe('Duet controller startup', () => {
  it('accepts the supplied program unchanged and warns about double probing and firmware compatibility', () => {
    expect(validatePrograms(programs)).toEqual([])
    const warnings = controllerStartWarnings(start).join('\n')
    expect(warnings).toContain('probe twice')
    expect(warnings).toContain('RepRapFirmware 2')
    expect(warnings).toContain('not simulated')
  })
  it.each(['M98 P"0:/macros/Probe"\nM400', 'M291 P"Check X999; (Z-100) and ""probe"""R"Warning"S3\nM400', 'M585 Z10 P0 F500 S1\nG90'])('accepts quoted strings and supported macro/new-firmware forms: %s', startGcode => {
    expect(validatePrograms({ ...programs, startGcode })).toEqual([])
  })
  it.each(['M98 P"unfinished', 'M98 P"Probe" junk', 'M98 P"Probe" P"Other"', 'G01 X1 Z1', 'G01 Z-1 F500', 'G20', 'G28', 'G10 L2 Z5', 'G10 L20 X0 Z5', 'M30', 'M291 P"Test" S4', 'M585 Z10 L0 F500', 'M03 S0', 'M400 X1', 'M98 P"Probe"\n' + controllerStartBegin])('rejects unsupported or malformed startup: %s', code => {
    expect(validatePrograms({ ...programs, startGcode: `M400\n${code}` }).length).toBeGreaterThan(0)
  })
  it('does not detect controller commands inside comments or quoted prompts as extra commands', () => {
    expect(hasControllerStart('(M98 P"Probe")\nG21')).toBe(false)
    expect(controllerStartWarnings('M291 P"M98 M585 Z-999" S3')).toHaveLength(1)
  })
  it('runs startup before the first generated Z move, restores modes and stops the startup spindle', () => {
    const lines = startProgramLines(programs, 20)
    expect(lines.slice(0, lines.indexOf(controllerStartBegin)).join('\n')).not.toMatch(/Z/)
    expect(lines.slice(lines.indexOf(controllerStartEnd) + 1)).toEqual(['G21', 'G17', 'G90', 'G94', 'M05', 'G00 Z20'])
    expect(lines).toContain('G00 Z5.0000')
  })
  it('does not change basic startup output', () => {
    expect(startProgramLines(defaultProgramSettings, 20)).toEqual(['G21', 'G17', 'G90', 'G94', 'M05', 'G00 Z20', 'G21', 'G17', 'G90', 'G94', 'G21', 'G17', 'G90', 'G94', 'G00 Z20'])
  })
  it('excludes startup from simulation and component transformations while preserving line numbers', () => {
    const parsed = parseGCode(source())
    expect(parsed.startLines.map(line => line.raw)).toContain('G1 Z3 F500')
    expect(parsed.bodyLines.some(line => /M585|M98|M563|G10|Z3 F500/.test(line.raw))).toBe(false)
    const simulation = simulateGCode(source())
    expect(simulation.errors).toEqual([])
    expect(simulation.deepestCutMm).toBe(2)
    expect(simulation.moves.some(move => /M585|G1 Z3|Z5.0000/.test(move.raw))).toBe(false)
    for (const move of simulation.moves) expect(source().split('\n')[move.lineNumber - 1]).toBe(move.raw)
    const part = createPartFromGCode('duet.nc', source())
    const transformed = transformPartProgram(part, { id: 'copy', partId: part.id, x: 100, y: 100, sheetIndex: 0, rotation: 0, locked: false })
    expect(transformed.errors).toEqual([])
    expect(transformed.lines.join('\n')).not.toMatch(/M98|M585|M563|CONTROLLER START/)
    expect(transformed.lines).toContain('G01 Z-2 F600')
  })
  it.each([
    (code: string) => code.replace(controllerStartEnd, ''),
    (code: string) => code.replace('M400', 'G01 X100 Z-20'),
    (code: string) => `G01 X10\n${code}`,
    (code: string) => code.replace(controllerStartEnd, controllerStartBegin),
    (code: string) => code.replace(`${controllerStartEnd}\nG21`, `${controllerStartEnd}\nG20`),
  ])('fails closed on invalid marked blocks', change => {
    const code = change(source())
    expect(simulateGCode(code).errors.join()).toContain('invalid controller startup block')
    const part = createPartFromGCode('bad.nc', code)
    expect(transformPartProgram(part, { id: 'copy', partId: part.id, x: 0, y: 0, sheetIndex: 0, rotation: 0, locked: false }).errors.join().toLowerCase()).toContain('invalid controller startup block')
  })
  it('preserves CAM cutting depths and pecks', () => {
    const drawing = { units: 'mm' as const, errors: [], warnings: [], features: [{ id: 'p', name: 'Hole', layer: 'DRILL', points: [{ x: 20, y: 20 }], kind: 'drill' as const, closed: false }] }
    const base = generateCam(drawing, { thickness: 18, units: 'mm', operations: {}, programs: defaultProgramSettings })
    const duet = generateCam(drawing, { thickness: 18, units: 'mm', operations: {}, programs })
    expect(duet.errors).toEqual([])
    expect(duet.simulation.deepestCutMm).toBe(9.2)
    expect(duet.simulation.moves.filter(m => m.type !== 'rapid').map(m => m.raw)).toEqual(base.simulation.moves.filter(m => m.type !== 'rapid').map(m => m.raw))
  })
  it('never treats operation-like comments inside startup as the component body boundary', () => {
    const code = startProgramLines({ ...programs, startGcode: '(No. 1 Probe)\n' + start }, 20).join('\n') + tail
    expect(parseGCode(code).bodyLines.map(line => line.raw).join('\n')).not.toMatch(/Probe|M98|M585|CONTROLLER/)
    expect(parseGCode(startProgramLines(programs, 20).join('\n')).bodyLines.map(line => line.raw).join('\n')).not.toMatch(/M98|M585|CONTROLLER/)
  })
  it('runs one startup per physical sheet with the spindle stopped before reach checks', async () => {
    const result = await generateJob(parseJobRequest(testRequest), [testItem], testParts, programs)
    for (const sheet of result.exported) {
      expect(sheet.gcode.split('M98 P').length - 1).toBe(1)
      const end = sheet.gcode.indexOf(controllerStartEnd)
      const reach = sheet.gcode.indexOf('Reach check:')
      expect(end).toBeLessThan(reach)
      expect(sheet.gcode.slice(end, reach)).toContain('M05\nG00 Z20')
      expect(reach).toBeLessThan(sheet.gcode.indexOf(programs.spindleStartGcode))
    }
  })
})
