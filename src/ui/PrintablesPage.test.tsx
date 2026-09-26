import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PrintablesPage } from './PrintablesPage'
const mock = vi.hoisted(() => ({ list: vi.fn(), thumbnails: vi.fn(), download: vi.fn(), upload: vi.fn(), read: vi.fn(), remove: vi.fn() }))
vi.mock('../storage/printablesStore', () => ({ listPrintables: mock.list, printableThumbnails: mock.thumbnails, downloadPrintable: mock.download, uploadPrintable: mock.upload, removePrintable: mock.remove, printablesPageSize: 24 }))
vi.mock('../printing/readStl', () => ({ readStl: mock.read }))
vi.mock('./StlPreview', () => ({ StlPreview: ({ name }: { name: string }) => <div role="img" aria-label={`3D preview of ${name}`} /> }))
const asset = { id: '1', owner_id: 'alice', name: 'Corner protector', purpose: 'packaging', item_id: null, notes: 'PETG, 4 walls', units: 'mm', filename: 'corner.stl', file_bytes: 4, triangles: 12, dimensions: [20, 30, 40], created_at: '', stl_path: 'alice/1/model.stl', preview_path: 'alice/1/preview.png' }
describe('3D-print library', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    HTMLDialogElement.prototype.showModal = function () { this.open = true }
    mock.list.mockResolvedValue({ assets: [asset], count: 1 }); mock.thumbnails.mockResolvedValue({ [asset.preview_path]: 'https://example.test/preview.png' })
    mock.download.mockResolvedValue(new Blob(['mesh'])); mock.read.mockResolvedValue({ positions: new Float32Array(), normals: new Float32Array(), dimensions: [20, 30, 40], triangles: 12 })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })
  afterEach(() => { cleanup(); vi.restoreAllMocks() })
  it('shows shared thumbnails and defers mesh downloads until requested', async () => {
    render(<PrintablesPage userId="bob" items={[]} />)
    expect(await screen.findByRole('img', { name: 'Corner protector' })).toBeInTheDocument()
    expect(screen.getByText('20 × 30 × 40 mm')).toBeInTheDocument()
    expect(mock.download).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Download Corner protector' }))
    await waitFor(() => expect(mock.download).toHaveBeenCalledWith('bob', expect.objectContaining({ owner_id: 'alice' })))
  })
  it('opens a real model preview and notes without another uploader remove control', async () => {
    render(<PrintablesPage userId="bob" items={[]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Preview Corner protector' }))
    expect(await screen.findByRole('img', { name: '3D preview of Corner protector' })).toBeInTheDocument()
    expect(screen.getByText('PETG, 4 walls')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove STL' })).not.toBeInTheDocument()
  })
  it('filters and paginates without loading meshes', async () => {
    mock.list.mockResolvedValue({ assets: [asset], count: 25 })
    render(<PrintablesPage userId="alice" items={[]} />)
    await screen.findByRole('img', { name: 'Corner protector' })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    await waitFor(() => expect(mock.list).toHaveBeenLastCalledWith('alice', expect.objectContaining({ page: 1 }), expect.any(AbortSignal)))
    fireEvent.change(screen.getByRole('combobox', { name: 'Purpose' }), { target: { value: 'packaging' } })
    await waitFor(() => expect(mock.list).toHaveBeenLastCalledWith('alice', expect.objectContaining({ page: 0, purpose: 'packaging' }), expect.any(AbortSignal)))
    expect(mock.download).not.toHaveBeenCalled()
  })
  it('rejects non-STL uploads before reading or saving files', async () => {
    render(<PrintablesPage userId="alice" items={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Upload STL' }))
    fireEvent.change(screen.getByLabelText('STL file'), { target: { files: [new File(['bad'], 'bad.exe')] } })
    expect(await screen.findByRole('alert')).toHaveTextContent('.stl')
    expect(mock.read).not.toHaveBeenCalled(); expect(mock.upload).not.toHaveBeenCalled()
  })
})
