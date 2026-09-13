import type { GCodeSettings as GCodeSettingsModel } from '../models/Sheet'

interface Props {
  settings: GCodeSettingsModel
  onChange: (settings: GCodeSettingsModel) => void
}

export function GCodeSettings({ settings, onChange }: Props) {
  return (
    <section className="panel settings">
      <h2>G-code Settings</h2>
      <label>
        Safe Z
        <input
          type="number"
          value={settings.safeZ}
          onChange={(event) => onChange({ ...settings, safeZ: Number(event.target.value) })}
        />
      </label>
      <label>
        Start G-code
        <textarea value={settings.startGcode} onChange={(event) => onChange({ ...settings, startGcode: event.target.value })} />
      </label>
      <label>
        End G-code
        <textarea value={settings.endGcode} onChange={(event) => onChange({ ...settings, endGcode: event.target.value })} />
      </label>
    </section>
  )
}
