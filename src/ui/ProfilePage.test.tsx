import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfilePage } from './ProfilePage'
import { defaultProgramSettings } from '../gcode/programSettings'

afterEach(cleanup)
const manual = { startGcode: 'M98 P"0:/macros/Probe"\nM400', spindleStartGcode: '', endGcode: 'M30' }
describe('profile program saving', () => {
  it('saves start/end with no automatic spindle command', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<ProfilePage loading={false} onRetry={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Start program'), { target: { value: manual.startGcode } })
    fireEvent.change(screen.getByLabelText('End program'), { target: { value: manual.endGcode } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByText('Settings saved')
    expect(onSave).toHaveBeenCalledExactlyOnceWith(manual)
  })
  it('makes validation failures actionable instead of disabling save', () => {
    const onSave = vi.fn()
    render(<ProfilePage loading={false} onRetry={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Start program'), { target: { value: 'G91' } })
    const button = screen.getByRole('button', { name: 'Save settings' })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Start program')).toHaveFocus()
    expect(screen.getByLabelText('Start program')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Not saved:')
    expect(screen.getByText('End program: this field is required.')).toBeVisible()
  })
  it('retains drafts after failed saves and allows retry', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Connection failed')).mockResolvedValue(undefined)
    render(<ProfilePage loading={false} programs={manual} onRetry={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('End program'), { target: { value: 'M05\nM30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('End program')).toHaveValue('M05\nM30')
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await screen.findByText('Settings saved')
    expect(onSave).toHaveBeenCalledTimes(2)
  })
  it('recognizes unchanged settings regardless of object property order', () => {
    const { rerender } = render(<ProfilePage programs={defaultProgramSettings} loading={false} onRetry={vi.fn()} onSave={vi.fn()} />)
    rerender(<ProfilePage programs={{ endGcode: defaultProgramSettings.endGcode, spindleStartGcode: defaultProgramSettings.spindleStartGcode, startGcode: defaultProgramSettings.startGcode }} loading={false} onRetry={vi.fn()} onSave={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled()
  })
  it('prevents duplicate requests while saving', async () => {
    let finish!: () => void
    const onSave = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    render(<ProfilePage programs={manual} loading={false} onRetry={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('End program'), { target: { value: 'M05\nM30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeDisabled()
    finish()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Settings saved'))
    expect(onSave).toHaveBeenCalledTimes(1)
  })
})
