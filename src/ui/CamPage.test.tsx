import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CamPage } from './CamPage'
import { defaultProgramSettings } from '../gcode/programSettings'
import { testItem } from '../test/jobFixtures'
import { readDxf } from '../cam/dxf'
import { generateCam } from '../cam/generate'
import type { CamSettings } from '../cam/types'
import { downloadText } from '../storage/projectStorage'
import { generateMaterialVariants } from '../cam/materialVariants'

vi.mock('./CamPreview', () => ({ CamPreview: () => <div>Preview</div> }))
vi.mock('../storage/projectStorage', () => ({ downloadText: vi.fn() }))

const dxf = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'PROFILE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 100, 10, 0, 20, 100, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
class TestWorker {
  static instances: TestWorker[] = []
  onmessage?: (event: { data: unknown }) => void
  onerror?: () => void
  request!: { source: string; settings: CamSettings }
  terminate = vi.fn()
  constructor() { TestWorker.instances.push(this) }
  postMessage(request: TestWorker['request']) { this.request = request }
  respond() {
    const drawing = readDxf(this.request.source, this.request.settings.units)
    const result = generateCam(drawing, this.request.settings)
    this.onmessage?.({ data: { result, materialVariants: generateMaterialVariants(drawing, this.request.settings, result) } })
  }
}
function file(name: string, text: () => Promise<string> = async () => dxf) {
  return Object.assign(new File([dxf], name), { text: vi.fn(text) })
}
function upload(files: File[]) { fireEvent.change(screen.getByLabelText('Upload DXF files'), { target: { files } }) }
async function generated() {
  await waitFor(() => {
    expect(TestWorker.instances.at(-1)?.request).toBeDefined()
    expect(TestWorker.instances.at(-1)!.terminate).not.toHaveBeenCalled()
  })
  act(() => TestWorker.instances.at(-1)!.respond())
}
const review = () => screen.getByRole('checkbox', { name: /Units, operations/ })

describe('DXF review queue', () => {
  beforeEach(() => { TestWorker.instances = []; vi.stubGlobal('Worker', TestWorker); vi.mocked(downloadText).mockClear(); vi.spyOn(window, 'scrollTo').mockImplementation(() => {}) })
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it.each([3, 12])('automatically removes tabs for %s mm holes and keeps outer outlines protected', async width => {
    const slot = [0, 'SECTION', 2, 'HEADER', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES', 0, 'LWPOLYLINE', 8, 'CUT_INNER', 90, 4, 70, 1, 10, 0, 20, 0, 10, 100, 20, 0, 10, 100, 20, 3, 10, 0, 20, 3, 0, 'ENDSEC', 0, 'EOF', ''].join('\n')
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={vi.fn()} />)
    upload([file('slot.dxf', async () => slot.replaceAll('\n20\n3\n', `\n20\n${width}\n`))]); await generated()
    const tabs = screen.getByRole('spinbutton', { name: /Tabs for/ })
    expect(tabs).toHaveValue(0)
    expect(tabs).toHaveAttribute('max', '0')
    expect(tabs).toBeDisabled()
    if (width === 3) {
      expect(screen.getByText('6.35 mm cutter-width hole')).toBeInTheDocument()
      expect(screen.getByText(/widened from 3 mm/)).toBeInTheDocument()
    }
    expect(screen.queryByText(/no holding tabs/)).not.toBeInTheDocument()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Download G-code' }))
    expect(vi.mocked(downloadText).mock.calls[0][1]).not.toContain('(Tab ')
    fireEvent.change(screen.getByLabelText('Operation for LWPOLYLINE 1'), { target: { value: 'outside' } }); await generated()
    expect(tabs).toHaveValue(4)
    fireEvent.change(tabs, { target: { value: '2' } }); await generated()
    fireEvent.change(screen.getByLabelText('Operation for LWPOLYLINE 1'), { target: { value: 'inside' } }); await generated()
    expect(tabs).toHaveValue(0)
    expect(review()).not.toBeChecked()
    expect(screen.queryByText(/Export blocked/)).not.toBeInTheDocument()
  })

  it.each(['6', '12', '15', '12-2pass', '18-9mm'])('confirms one file at a time, retaining %s material/item but resetting overrides, units and review', async choice => {
    const thickness = choice === '18-9mm' ? 18 : choice === '15' ? 15 : choice === '6' ? 6 : 12
    const suffix = choice === '18-9mm' ? '18mm-9mm-holes' : choice === '12-2pass' ? '12mm-2pass' : `${thickness}mm`
    const onSave = vi.fn()
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={onSave} />)
    const first = file('first.dxf'), second = file('second.dxf')
    upload([first, second]); await generated()
    expect(screen.getByText('File 1 of 2')).toBeInTheDocument()
    expect(second.text).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Material thickness'), { target: { value: choice } }); await generated()
    if (choice === '12-2pass') expect(screen.getByText('2 x 6.1 mm')).toBeInTheDocument()
    if (thickness === 15) expect(screen.getByText('2 x 7.7 mm')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('DXF units'), { target: { value: 'mm' } }); await generated()
    fireEvent.change(screen.getByRole('spinbutton', { name: /Tabs for/ }), { target: { value: '1' } }); await generated()
    expect(screen.getByRole('button', { name: 'Confirm & add component' })).toBeDisabled()
    fireEvent.click(review())
    expect(screen.getByText('File 1 of 2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add component' }))
    await waitFor(() => expect(screen.getByText('File 2 of 2')).toBeInTheDocument())
    await generated()
    expect(onSave).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ filename: `first-${suffix}.nc`, itemId: testItem.id, source: dxf }))
    expect(Object.keys(onSave.mock.calls[0][0].materialVariants.profiles)).toHaveLength(6)
    expect(onSave.mock.calls[0][0].materialVariants.profiles['6'].gcode).toContain('Pass depth 6.2')
    expect(onSave.mock.calls[0][0].materialVariants.profiles['18'].gcode).toContain('Pass depth 18.4')
    expect(screen.getByLabelText('Material thickness')).toHaveValue(choice)
    expect(screen.getByLabelText('Save generated component to item')).toHaveValue(testItem.id)
    expect(screen.getByLabelText('DXF units')).toHaveValue('auto')
    expect(screen.getByRole('spinbutton', { name: /Tabs for/ })).toHaveValue(4)
    expect(review()).not.toBeChecked()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Download G-code' }))
    expect(downloadText).toHaveBeenCalledExactlyOnceWith(`second-${suffix}.nc`, expect.stringContaining(`Pass depth ${thickness === 18 ? 18.4 : thickness === 15 ? 15.4 : thickness === 6 ? 6.2 : 12.2}`))
    if (choice === '12-2pass') expect(vi.mocked(downloadText).mock.calls[0][1]).toContain('Pass depth 6.1')
    expect(screen.getByText('File 2 of 2')).toBeInTheDocument()
    expect(screen.queryByText('Queue complete')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add component' }))
    await screen.findByText('Queue complete')
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(screen.getByText('2 confirmed / 0 skipped')).toBeInTheDocument()
    expect(review()).toBeDisabled()
  })

  it('resets review and pass selection when changing material presets', async () => {
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={vi.fn()} />)
    upload([file('panel.dxf')]); await generated()
    for (const choice of ['18-9mm', '12-2pass', '6', '12-2pass', '15', '18-9mm', '18', '12-2pass', '12']) {
      fireEvent.click(review())
      fireEvent.change(screen.getByLabelText('Material thickness'), { target: { value: choice } }); await generated()
      expect(review()).not.toBeChecked()
      expect(TestWorker.instances.at(-1)!.request.settings.profilePasses).toBe(choice === '12-2pass' ? 2 : undefined)
      expect(TestWorker.instances.at(-1)!.request.settings.drillDepthMm).toBe(choice === '18-9mm' ? 9 : undefined)
      expect(screen.queryByText(/Export blocked/)).not.toBeInTheDocument()
    }
  })

  it('advances immediately after enqueueing, without waiting for background persistence', async () => {
    const onSave = vi.fn(() => new Promise<void>(() => {}))
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={onSave} />)
    upload([file('one.dxf'), file('two.dxf')]); await generated()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add component' }))
    expect(screen.getByText('File 2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skip file' })).toBeEnabled()
    expect(screen.getByLabelText('Upload DXF files')).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add component' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    await generated()
    expect(review()).not.toBeChecked()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add component' }))
    await screen.findByText('Queue complete')
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('appends uploads without discarding the current review and can skip an unreadable file', async () => {
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={vi.fn()} />)
    upload([file('one.dxf')]); await generated()
    fireEvent.click(review())
    upload([file('empty.dxf', async () => ''), file('three.dxf')])
    expect(screen.getByText('File 1 of 3')).toBeInTheDocument()
    expect(review()).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & add component' }))
    await screen.findByText('DXF is empty.')
    expect(screen.getByRole('button', { name: 'Download G-code' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Skip file' })); await generated()
    expect(screen.getByText('File 3 of 3')).toBeInTheDocument()
    expect(review()).not.toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Skip file' }))
    expect(screen.getByText('Queue complete')).toBeInTheDocument()
    expect(screen.getByText('1 confirmed / 2 skipped')).toBeInTheDocument()
    upload([file('new.dxf')]); await generated()
    expect(screen.queryByLabelText('DXF queue')).not.toBeInTheDocument()
    expect(screen.getByText('new.dxf')).toBeInTheDocument()
  })

  it('ignores reads and worker replies from files that have been skipped', async () => {
    let resolve!: (source: string) => void
    render(<CamPage items={[]} programs={defaultProgramSettings} onSave={vi.fn()} />)
    upload([file('slow.dxf', () => new Promise(done => { resolve = done })), file('second.dxf'), file('third.dxf')])
    fireEvent.click(screen.getByRole('button', { name: 'Skip file' })); await generated()
    await act(async () => resolve('stale source'))
    expect(screen.getByText('File 2 of 3')).toBeInTheDocument()
    const oldWorker = TestWorker.instances.at(-1)!
    fireEvent.click(screen.getByRole('button', { name: 'Skip file' }))
    act(() => oldWorker.onmessage?.({ data: { error: 'Stale error' } }))
    await generated()
    expect(screen.queryByText('Stale error')).not.toBeInTheDocument()
    expect(oldWorker.terminate).toHaveBeenCalled()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Download G-code' }))
    expect(downloadText).toHaveBeenCalledWith('third-18mm.nc', expect.any(String))
  })

  it('preserves single-file download followed by add, and blocks invalid geometry', async () => {
    const onSave = vi.fn()
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={onSave} />)
    upload([file('one.dxf')]); await generated()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Download G-code' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    await screen.findByRole('button', { name: /^Confirmed$/ })
    expect(onSave).toHaveBeenCalledTimes(1)
    upload([file('bad.dxf', async () => 'invalid'), file('good.dxf')])
    await waitFor(() => expect(TestWorker.instances.at(-1)?.request.source).toBe('invalid'))
    act(() => TestWorker.instances.at(-1)!.onmessage?.({ data: { error: 'Invalid DXF' } }))
    expect(review()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Confirm & add component' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Skip file' })).toBeEnabled()
  })
  it('defaults large through-cuts to four tabs and blocks confirmation when zero is entered', async () => {
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={vi.fn()} />)
    upload([file('large-part.dxf')]); await generated()
    const tabs = screen.getByRole('spinbutton', { name: /Tabs for/ })
    expect(tabs).toHaveValue(4)
    expect(tabs).toHaveAttribute('min', '1')
    fireEvent.change(tabs, { target: { value: '0' } }); await generated()
    expect(screen.getByRole('alert')).toHaveTextContent('require holding tabs')
    expect(review()).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add component' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download G-code' })).toBeDisabled()
    fireEvent.change(tabs, { target: { value: '4' } }); await generated()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(review()).toBeEnabled()
  })
  it('allows zero tabs on an inside hole and resets operator review', async () => {
    render(<CamPage items={[testItem]} programs={defaultProgramSettings} onSave={vi.fn()} />)
    upload([file('hole.dxf', async () => dxf.replace('PROFILE', 'CUT_INNER'))]); await generated()
    const tabs = screen.getByRole('spinbutton', { name: /Tabs for/ })
    expect(tabs).toHaveValue(4)
    expect(tabs).toHaveAttribute('min', '0')
    fireEvent.click(review())
    fireEvent.change(tabs, { target: { value: '0' } }); await generated()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(review()).not.toBeChecked()
    expect(screen.getByText(/no holding tabs/)).toBeInTheDocument()
    fireEvent.click(review())
    fireEvent.click(screen.getByRole('button', { name: 'Download G-code' }))
    expect(downloadText).toHaveBeenCalledWith('hole-18mm.nc', expect.not.stringContaining('(Tab '))
  })
})
