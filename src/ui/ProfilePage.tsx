import { useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { normalizePrograms, validatePrograms, type ProgramSettings } from '../gcode/programSettings'
import './ProfilePage.css'
import { controllerStartWarnings } from '../gcode/controllerStart'

const fields = [['startGcode', 'Start program'], ['spindleStartGcode', 'Spindle start'], ['endGcode', 'End program']] as const

export function ProfilePage({ email, programs, loading, error, onRetry, onSave }: { email?: string; programs?: ProgramSettings; loading: boolean; error?: string; onRetry: () => void; onSave: (programs: ProgramSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<ProgramSettings>(programs ?? { startGcode: '', spindleStartGcode: '', endGcode: '' })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [attempted, setAttempted] = useState(false)
  const problems = validatePrograms(draft)
  const dirty = fields.some(([key]) => draft[key] !== programs?.[key])
  const showProblems = attempted || dirty && Object.values(draft).some(Boolean)
  async function save(form: HTMLFormElement) {
    if (busy || loading || error || !dirty) return
    setAttempted(true); setSaveError(''); setSaved(false)
    if (problems.length) {
      const invalid = fields.find(([, label]) => problems.some(message => message.startsWith(label)))
      if (invalid) (form.elements.namedItem(invalid[0]) as HTMLTextAreaElement | null)?.focus()
      return
    }
    setBusy(true); setSaveError(''); setSaved(false)
    try { const normalized = normalizePrograms(draft); await onSave(normalized); setDraft(normalized); setSaved(true); setAttempted(false) } catch (error) { setSaveError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <main className="profile-page">
    <header className="profile-heading"><h2>User Profile</h2><span>{email}</span></header>
    <form onSubmit={event => { event.preventDefault(); void save(event.currentTarget) }}>
      <div className="profile-section-heading"><h3>CNC Program Settings</h3><span>{loading ? 'Loading...' : programs ? 'Account settings' : 'Setup required'}</span></div>
      {error && <div className="profile-error" role="alert">{error}<button type="button" onClick={onRetry}>Retry</button></div>}
      <div className="profile-programs">{fields.map(([key, label]) => {
        const errors = showProblems ? problems.filter(message => message.startsWith(label)) : []
        return <div key={key}><label>{label}{key === 'spindleStartGcode' ? ' (optional)' : ''}<textarea name={key} aria-label={label} aria-invalid={errors.length > 0} aria-describedby={errors.length ? `${key}-errors` : undefined} spellCheck={false} maxLength={8000} disabled={loading || busy || Boolean(error)} value={draft[key]} onChange={event => { setDraft(current => ({ ...current, [key]: event.target.value })); setSaved(false); setSaveError('') }} /></label>{errors.length > 0 && <ul id={`${key}-errors`} className="profile-errors">{errors.map(message => <li key={message}>{message}</li>)}</ul>}</div>
      })}</div>
      {controllerStartWarnings(draft.startGcode).map(message => <p key={message} role="note">{message}</p>)}
      {!draft.spindleStartGcode.trim() && <p role="note">Manual cutter control: no automatic spindle start. The cutter must be started and stopped manually; M05 cannot stop a manually switched router.</p>}
      {saveError && <p className="profile-error" role="alert">{saveError}</p>}
      <footer className="profile-actions"><button type="submit" className="primary icon-text-button" disabled={!dirty || busy || loading || Boolean(error)}><Save size={16} />{busy ? 'Saving...' : 'Save settings'}</button><button type="button" className="icon-text-button" disabled={!dirty || busy || loading} onClick={() => { setDraft(programs ?? { startGcode: '', spindleStartGcode: '', endGcode: '' }); setSaveError(''); setSaved(false); setAttempted(false) }}><RotateCcw size={16} />Discard changes</button><span role="status">{saved ? 'Settings saved' : busy ? 'Saving settings...' : showProblems && problems.length ? `Not saved: ${problems.length} validation ${problems.length === 1 ? 'error' : 'errors'}. Check the marked fields.` : dirty ? 'Unsaved changes' : 'No unsaved changes'}</span></footer>
    </form>
  </main>
}
