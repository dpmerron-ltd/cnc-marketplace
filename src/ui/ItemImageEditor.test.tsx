import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ItemImageEditor } from './ItemImageEditor'
import { prepareItemImage } from './prepareItemImage'
import { testImage } from '../test/imageFixture'

vi.mock('./prepareItemImage', () => ({ prepareItemImage: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })
const upload = () => fireEvent.change(screen.getByLabelText('Upload item image'), { target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })] } })

describe('item image editor', () => {
  it('prepares and saves an image, shows progress, and removes an existing image', async () => {
    vi.mocked(prepareItemImage).mockResolvedValue(testImage)
    const onSave = vi.fn(async () => {})
    const view = render(<ItemImageEditor name="Cabinet" onSave={onSave} />)
    upload()
    expect(screen.getByLabelText('Upload item image')).toBeDisabled()
    await screen.findByText('Image saved.')
    expect(onSave).toHaveBeenCalledExactlyOnceWith(testImage)
    view.rerender(<ItemImageEditor image={testImage} name="Cabinet" onSave={onSave} />)
    expect(screen.getByRole('img', { name: 'Cabinet' })).toHaveAttribute('src', expect.stringContaining('data:image/png'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove item image' }))
    await screen.findByText('Image removed.')
    expect(onSave).toHaveBeenLastCalledWith(null)
  })
  it('shows upload failures and enables retry without losing the existing image', async () => {
    vi.mocked(prepareItemImage).mockRejectedValueOnce(new Error('Bad image')).mockResolvedValue(testImage)
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Network failure')).mockResolvedValue(undefined)
    render(<ItemImageEditor name="Cabinet" onSave={onSave} />)
    upload()
    expect(await screen.findByRole('alert')).toHaveTextContent('Bad image')
    expect(onSave).not.toHaveBeenCalled()
    upload()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Network failure'))
    expect(screen.getByLabelText('Upload item image')).toBeEnabled()
    upload()
    await screen.findByText('Image saved.')
  })
  it('does not save an image prepared after navigating away or switching accounts', async () => {
    let resolve!: (value: typeof testImage) => void
    vi.mocked(prepareItemImage).mockReturnValue(new Promise(done => { resolve = done }))
    const onSave = vi.fn(async () => {})
    const view = render(<ItemImageEditor name="Cabinet" onSave={onSave} />)
    upload()
    view.unmount()
    resolve(testImage)
    await waitFor(() => expect(prepareItemImage).toHaveBeenCalledOnce())
    expect(onSave).not.toHaveBeenCalled()
  })
})
