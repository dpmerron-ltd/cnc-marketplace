import { useState } from 'react'
import { RotateCcw, Save } from 'lucide-react'
import { normalizePrograms, validatePrograms, type ProgramSettings } from '../gcode/programSettings'
import './ProfilePage.css'
import { controllerStartWarnings } from '../gcode/controllerStart'

export function ProfilePage({ email, programs, loading, error, onRetry, onSave }: { email?: string; programs?: ProgramSettings; loading: boolean; error?: string; onRetry: () => void; onSave: (programs: ProgramSettings) => Promise<void> }) {
  const [draft, setDraft] = useState<ProgramSettings>(programs ?? { startGcode: '', spindleStartGcode: '', endGcode: '' })
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const problems = validatePrograms(draft)
  const dirty = JSON.stringify(draft) !== JSON.stringify(programs)
  async function save() {
    setBusy(true); setSaveError(''); setSaved(false)
    try { const normalized = normalizePrograms(draft); await onSave(normalized); setDraft(normalized); setSaved(true) } catch (error) { setSaveError((error as Error).message) }
    finally { setBusy(false) }
  }
  return <main className="profile-page">
    <header className="profile-heading"><h2>User Profile</h2><span>{email}</span></header>
    <form onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="profile-section-heading"><h3>CNC Program Settings</h3><span>{loading ? 'Loading...' : programs ? 'Account settings' : 'Setup required'}</span></div>
      {error && <div className="profile-error" role="alert">{error}<button type="button" onClick={onRetry}>Retry</button></div>}
      <div className="profile-programs">{([['startGcode', 'Start program'], ['spindleStartGcode', 'Spindle start'], ['endGcode', 'End program']] as const).map(([key, label]) => <label key={key}>{label}<textarea aria-label={label} spellCheck={false} maxLength={8000} disabled={loading || busy || Boolean(error)} value={draft[key]} onChange={event => { setDraft(current => ({ ...current, [key]: event.target.value })); setSaved(false); setSaveError('') }} /></label>)}</div>
      {dirty && problems.length > 0 && Object.values(draft).some(Boolean) && <ul className="profile-errors" role="alert">{problems.map(message => <li key={message}>{message}</li>)}</ul>}
      {controllerStartWarnings(draft.startGcode).map(message => <p key={message} role="note">{message}</p>)}
      {saveError && <p className="profile-error" role="alert">{saveError}</p>}
      <footer className="profile-actions"><button type="submit" className="primary icon-text-button" disabled={!dirty || busy || loading || Boolean(error) || problems.length > 0}><Save size={16} />{busy ? 'Saving...' : 'Save settings'}</button><button type="button" className="icon-text-button" disabled={!dirty || busy || loading} onClick={() => { setDraft(programs ?? { startGcode: '', spindleStartGcode: '', endGcode: '' }); setSaveError(''); setSaved(false) }}><RotateCcw size={16} />Discard changes</button><span role="status">{saved ? 'Settings saved' : dirty ? 'Unsaved changes' : ''}</span></footer>
    </form>
  </main>
}
