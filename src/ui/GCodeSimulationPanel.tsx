import { isFiniteBounds } from '../models/geometry'
import type { GCodeSimulation, SimulatedMove } from '../gcode/simulator'

interface GCodeSimulationPanelProps {
  title?: string
  simulation: GCodeSimulation
}

const padding = 18

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s'
  const rounded = Math.round(seconds)
  const hours = Math.floor(rounded / 3600)
  const minutes = Math.floor((rounded % 3600) / 60)
  const remainingSeconds = rounded % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`
  return `${remainingSeconds}s`
}

function formatMm(value: number): string {
  if (!Number.isFinite(value)) return '0 mm'
  return `${value >= 1000 ? (value / 1000).toFixed(2) : value.toFixed(1)} ${value >= 1000 ? 'm' : 'mm'}`
}

function movePoints(move: SimulatedMove): string {
  return move.points.map((point) => `${point.x},${point.y}`).join(' ')
}

function viewBox(simulation: GCodeSimulation): string {
  if (!isFiniteBounds(simulation.bounds)) return `0 0 100 100`
  const width = Math.max(1, simulation.bounds.maxX - simulation.bounds.minX)
  const height = Math.max(1, simulation.bounds.maxY - simulation.bounds.minY)
  return `${simulation.bounds.minX - padding} ${simulation.bounds.minY - padding} ${width + padding * 2} ${height + padding * 2}`
}

export function GCodeSimulationPanel({ title = 'G-code Simulator', simulation }: GCodeSimulationPanelProps) {
  const messages = [...simulation.errors.map((message) => ({ level: 'error', message })), ...simulation.warnings.map((message) => ({ level: 'warning', message }))]

  return (
    <div className="panel simulator-panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <strong>{formatDuration(simulation.estimatedSeconds)}</strong>
      </div>
      <div className="simulator-metrics">
        <div>
          <span>Cutting</span>
          <strong>{formatMm(simulation.cuttingDistanceMm)}</strong>
        </div>
        <div>
          <span>Rapid</span>
          <strong>{formatMm(simulation.rapidDistanceMm)}</strong>
        </div>
        <div>
          <span>Deepest</span>
          <strong>{simulation.deepestCutMm.toFixed(2)} mm</strong>
        </div>
        <div>
          <span>Moves</span>
          <strong>{simulation.moves.length}</strong>
        </div>
      </div>
      <div className="simulator-view">
        <svg viewBox={viewBox(simulation)} role="img" aria-label="Simulated G-code toolpath">
          <g transform={`scale(1 -1) translate(0 ${isFiniteBounds(simulation.bounds) ? -(simulation.bounds.minY + simulation.bounds.maxY) : -100})`}>
            {simulation.moves.map((move) =>
              move.type === 'arc-cw' || move.type === 'arc-ccw' ? (
                <polyline key={move.lineNumber} points={movePoints(move)} className={`sim-move ${move.type}`} />
              ) : (
                <line
                  key={move.lineNumber}
                  x1={move.start.x}
                  y1={move.start.y}
                  x2={move.end.x}
                  y2={move.end.y}
                  className={`sim-move ${move.type}`}
                />
              ),
            )}
          </g>
        </svg>
      </div>
      {messages.length > 0 && (
        <ul className="simulator-messages">
          {messages.slice(0, 8).map((item, index) => (
            <li key={`${item.message}-${index}`} className={item.level}>{item.message}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
