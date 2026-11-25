import { dailyMaterialRequirements } from '../jobs/dailyMaterials'
import type { DailyPlan } from '../jobs/dailyPlan'
import { sheetHandlingMinutes } from '../jobs/dailyPlan'
const clock = (minute: number) =>
  `${String(Math.floor(Math.ceil(minute) / 60)).padStart(2, '0')}:${String(Math.ceil(minute) % 60).padStart(2, '0')}`
export function DailyPlanPanel({ plan, onOpen }: { plan: DailyPlan; onOpen?: (id: string, index: number) => void }) {
  const materials = dailyMaterialRequirements(plan)
  const hours = plan.cuts.reduce((sum, c) => sum + c.seconds, 0) / 3600
  return (
    <section className="daily-plan" aria-label="Daily cutting plan">
      <h3>
        {plan.date} · {hours.toFixed(1)} / 12 cutting hours
      </h3>
      <p>
        09:00–17:00 · two machines · {sheetHandlingMinutes} minutes reserved for loading and unloading each sheet. Times
        are program estimates; check stock and workholding before cutting.
      </p>
      <h4>Material needed today</h4>
      <p>
        1220 × 1220 mm squares across both machines. One square per scheduled sheet, including partially filled sheets.
        Deferred work is excluded.
      </p>
      {materials.materials.length ? (
        <div className="queue-table-scroll">
          <table className="queue-table" aria-label="Material needed today">
            <thead>
              <tr>
                <th>Material / thickness / finish</th>
                <th>1220 × 1220 mm squares</th>
                {materials.reviewSheets > 0 && <th>Layouts to review</th>}
              </tr>
            </thead>
            <tbody>
              {materials.materials.map((material) => (
                <tr key={material.key}>
                  <td>{material.material}</td>
                  <td>{material.squares}</td>
                  {materials.reviewSheets > 0 && <td>{material.reviewSheets}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row">{materials.reviewSheets ? 'Confirmed total' : 'Total squares'}</th>
                <td>{materials.totalSquares}</td>
                {materials.reviewSheets > 0 && <td>{materials.reviewSheets}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <p>No material needed: no cuts scheduled.</p>
      )}
      {materials.reviewSheets > 0 && (
        <p role="alert">
          {materials.reviewSheets} scheduled layouts have an unknown size or exceed 1220 × 1220 mm and are not included
          in the square total. Review their stock size and re-plan before preparing material.
        </p>
      )}
      {[1, 2].map((machine) => (
        <div key={machine}>
          <h4>Machine {machine}</h4>
          {plan.cuts.some((c) => c.machine === machine) ? (
            <div className="queue-table-scroll">
              <table className="queue-table">
                <thead>
                  <tr>
                    <th>Cutting time</th>
                    <th>Material</th>
                    <th>Orders</th>
                    <th>Parts</th>
                    <th>Sheet</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.cuts
                    .filter((c) => c.machine === machine)
                    .map((c) => (
                      <tr key={`${c.jobId}/${c.sheetIndex}`}>
                        <td>
                          {clock(c.startMinute)}–{clock(c.endMinute)}
                        </td>
                        <td>{c.material}</td>
                        <td>{c.orders.join(', ')}</td>
                        <td>{c.parts}</td>
                        <td>
                          {onOpen ? (
                            <button type="button" onClick={() => onOpen(c.jobId, c.sheetIndex)}>
                              Open sheet {c.sheetIndex + 1}
                            </button>
                          ) : (
                            `Sheet ${c.sheetIndex + 1}`
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No cuts scheduled.</p>
          )}
        </div>
      ))}
      <h4>Orders in this plan</h4>
      <p>Counts are components. Waiting parts roll over; cut parts are not scheduled again.</p>
      <div className="queue-table-scroll">
        <table className="queue-table">
          <thead>
            <tr>
              <th>Order</th>
              <th>Plan</th>
              <th>Today</th>
              <th>Waiting</th>
              <th>Already cut</th>
              <th>Awaiting allocation</th>
            </tr>
          </thead>
          <tbody>
            {plan.orders.map((o) => (
              <tr key={o.name}>
                <td>{o.name}</td>
                <td>
                  {o.pending
                    ? 'Needs allocation'
                    : o.scheduled
                      ? o.waiting
                        ? 'Partial today'
                        : 'All remaining planned parts today'
                      : o.waiting
                        ? 'Deferred'
                        : o.cut
                          ? 'Already cut'
                          : 'Needs attention'}
                </td>
                <td>{o.scheduled}</td>
                <td>{o.waiting}</td>
                <td>{o.cut}</td>
                <td>{o.pending}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {plan.deferred.length > 0 && (
        <p>{plan.deferred.length} sheets exceed today’s available capacity and remain waiting.</p>
      )}
      {plan.issues.length > 0 && (
        <>
          <h4>Needs attention</h4>
          <ul>
            {plan.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </>
      )}
      {plan.warnings.length > 0 && (
        <details>
          <summary>Program review notes ({plan.warnings.length})</summary>
          <ul>
            {plan.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
