import { useEffect, useRef, useState } from 'react'
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react'
import { itemImageUrl, type ItemImage } from '../models/ItemImage'
import { prepareItemImage } from './prepareItemImage'

export function ItemImageEditor({ image, name, onSave }: { image?: ItemImage | null; name: string; onSave: (image: ItemImage | null) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const active = useRef(false)
  const pending = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])

  async function save(file?: File) {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError(''); setMessage('')
    try {
      const value = file ? await prepareItemImage(file) : null
      if (!active.current) return
      await onSave(value)
      if (active.current) setMessage(value ? 'Image saved.' : 'Image removed.')
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : 'Image could not be saved. Try again.')
    } finally {
      pending.current = false
      if (active.current) setBusy(false)
    }
  }

  return <section className="item-image-editor" aria-label="Item image" aria-busy={busy}>
    <div className="item-photo">{image ? <img src={itemImageUrl(image)} alt={name || 'Item'} /> : <ImagePlus size={32} aria-label="No item image" />}</div>
    <div className="item-image-controls">
      <h3>Item image</h3>
      <div className="items-actions">
        <label className={`file-button${busy ? ' is-busy' : ''}`}>
          {busy ? <LoaderCircle size={16} /> : <ImagePlus size={16} />}{busy ? 'Saving image...' : image ? 'Replace image' : 'Upload image'}
          <input type="file" aria-label={image ? 'Replace item image' : 'Upload item image'} accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => {
            const file = event.currentTarget.files?.[0]
            event.currentTarget.value = ''
            if (file) void save(file)
          }} />
        </label>
        {image && <button type="button" className="items-icon" title="Remove item image" aria-label="Remove item image" disabled={busy} onClick={() => void save()}><Trash2 size={16} /></button>}
      </div>
      <p className="item-image-limit">JPG, PNG or WebP. Maximum 20 MB.</p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
    </div>
  </section>
}
