import { useState } from 'react'
import type { GCodePreset, GCodeSettings as GCodeSettingsModel } from '../models/Sheet'

interface Props {
  settings: GCodeSettingsModel
  presets: GCodePreset[]
  defaultPresetId?: string
  onChange: (settings: GCodeSettingsModel) => void
  onLoadPreset: (preset: GCodePreset) => void
  onSavePreset: (name: string) => void
  onSetDefaultPreset: (presetId: string) => void
  onDeletePreset: (presetId: string) => void
}

export function GCodeSettings({
  settings,
  presets,
  defaultPresetId,
  onChange,
  onLoadPreset,
  onSavePreset,
  onSetDefaultPreset,
  onDeletePreset,
}: Props) {
  const [selectedPresetId, setSelectedPresetId] = useState(defaultPresetId ?? presets[0]?.id ?? '')
  const [presetName, setPresetName] = useState('')
  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId)

  return (
    <section className="panel settings">
      <div className="settings-title">
        <h2>G-code Settings</h2>
        {defaultPresetId && <span>Default preset set</span>}
      </div>

      <div className="preset-row">
        <label>
          Preset
          <select value={selectedPresetId} onChange={(event) => setSelectedPresetId(event.target.value)}>
            <option value="">Select preset</option>
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}{preset.id === defaultPresetId ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row compact">
          <button type="button" disabled={!selectedPreset} onClick={() => selectedPreset && onLoadPreset(selectedPreset)}>
            Load
          </button>
          <button type="button" disabled={!selectedPreset} onClick={() => selectedPreset && onSetDefaultPreset(selectedPreset.id)}>
            Default
          </button>
          <button type="button" className="danger" disabled={!selectedPreset} onClick={() => selectedPreset && onDeletePreset(selectedPreset.id)}>
            Delete
          </button>
        </div>
      </div>

      <div className="preset-row">
        <label>
          Save current as
          <input value={presetName} placeholder="Preset name" onChange={(event) => setPresetName(event.target.value)} />
        </label>
        <button
          type="button"
          onClick={() => {
            const name = presetName.trim()
            if (!name) return
            onSavePreset(name)
            setPresetName('')
          }}
        >
          Save Preset
        </button>
      </div>

      <label>
        Safe Z
        <input
          type="number"
          value={settings.safeZ}
          onChange={(event) => onChange({ ...settings, safeZ: Number(event.target.value) })}
        />
      </label>
      <label className="checkbox" title="At safe Z, rapid to the furthest transformed X/Y machining extent before starting the job.">
        <input
          type="checkbox"
          checked={Boolean(settings.reachCheckEnabled)}
          onChange={(event) => onChange({ ...settings, reachCheckEnabled: event.target.checked })}
        />
        Check furthest X/Y before cutting
      </label>
      <label>
        Start G-code
        <textarea value={settings.startGcode} onChange={(event) => onChange({ ...settings, startGcode: event.target.value })} />
      </label>
      <label>
        Spindle start G-code
        <textarea value={settings.spindleStartGcode} onChange={(event) => onChange({ ...settings, spindleStartGcode: event.target.value })} />
      </label>
      <label>
        End G-code
        <textarea value={settings.endGcode} onChange={(event) => onChange({ ...settings, endGcode: event.target.value })} />
      </label>
    </section>
  )
}
