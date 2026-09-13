import type { SheetHistoryEntry } from '../models/Project'

interface HistoryPageProps {
  history: SheetHistoryEntry[]
  onOpen: (entry: SheetHistoryEntry) => void
  onDelete: (entryId: string) => void
}

export function HistoryPage({ history, onOpen, onDelete }: HistoryPageProps) {
  return (
    <section className="history-page">
      <div className="panel history-panel">
        <div className="panel-header">
          <h2>Sheet History</h2>
          <span className="history-count">{history.length} saved sheet{history.length === 1 ? '' : 's'}</span>
        </div>
        <div className="history-list">
          {history.length === 0 && <p className="muted">Saved sheets will appear here. Use Save Sheet from the toolbar to create a history snapshot.</p>}
          {history.map((entry) => (
            <article className="history-card" key={entry.id}>
              <div>
                <strong>{entry.name}</strong>
                <small>{new Date(entry.savedAt).toLocaleString()}</small>
              </div>
              <dl>
                <div>
                  <dt>Sheet</dt>
                  <dd>{entry.sheet.width} x {entry.sheet.height} mm</dd>
                </div>
                <div>
                  <dt>Placed</dt>
                  <dd>{entry.placedCount}</dd>
                </div>
                <div>
                  <dt>Items</dt>
                  <dd>{entry.itemCount}</dd>
                </div>
                <div>
                  <dt>Components</dt>
                  <dd>{entry.componentCount}</dd>
                </div>
              </dl>
              <div className="history-actions">
                <button type="button" onClick={() => onOpen(entry)}>Open</button>
                <button type="button" className="danger" onClick={() => onDelete(entry.id)}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
