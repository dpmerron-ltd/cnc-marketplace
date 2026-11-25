# Daily cutting planner

Use **Plan today’s cuts** in Orders or Cutting Jobs to preview the day. Save the preview to persist both the schedule and newly imported waiting sheets. Review/export scheduled sheets and print their labels through the existing cutting workflow. Planning does not start a machine or change an order’s fulfillment status.

The planner loads every accessible open/unfulfilled Shopify order and all its lines. Store administrators plan across the store; other users can plan their assigned orders only. Orders use Shopify's `createdAt` timestamp, not their number or API arrival order. Unknown dates, unmatched SKUs, unspecified material, unavailable programs and failed export/simulation checks are shown as exceptions. New order quantities use the smaller of current and unfulfilled quantities. Existing planned orders retain their component quantities and revisions to avoid duplicate imports; review existing allocations if an order has subsequently been edited in Shopify.

Compatible waiting sheets can be combined by the existing nesting engine; cutting/completed layouts and unrelated work remain separate. Material grouping respects actual thickness, material type, finish, face and cutting presets. Labels retain each part’s original order number across mixed-order nesting. Completed parts are not imported again. Existing in-progress cuts block a fresh full-day plan; this first version does not reschedule the remainder of a day already in progress.

Capacity assumptions:

- Two identical available machines, 09:00–17:00 Europe/London.
- At most 12 combined hours of estimated program runtime.
- Fifteen minutes of handling per physical sheet, included in each machine’s eight-hour window. The remaining daily capacity is spare time; breaks and staffing are not explicitly scheduled.
- Runtime comes from exporting and simulating the actual nested sheet with account program settings, including the selected material profile. It is an estimate, not measured machine telemetry.
- Whole sheets are assigned oldest-order-first. Sheets that cannot fit are deferred; newer work can fill remaining capacity. Selected material batches are then kept together on each machine without removing selected older work. This is a deterministic heuristic, not an optimal bin-packing solver.

Preview generation runs in a cancellable worker. Save rejects stale account, catalogue, program or workspace inputs, and uses the existing versioned workspace persistence. Layout/material changes invalidate saved schedules; changed program settings and a new date require replanning. Overflow remains visible as waiting work. Stock availability and physical workholding still need checking.

The frontend and CNC API must be deployed together: the Shopify reader now supplies placement dates and cancellation/closure fields. No database migration is required; the plan is stored in existing workspace JSON.

Tests cover FIFO selection, both machine limits, handling time, material top-ups into existing jobs, repeated imports, completed work, missing metadata, order pagination, cancellations, stale plans and per-order labels on a shared sheet.

Material preparation: new daily layouts use 1220 × 1220 mm stock squares. The preview and saved plan tally scheduled physical sheets by actual material, thickness and finish across both machines. Each sheet counts once, even when shared by several orders; partly filled layouts still reserve a whole square. Deferred sheets are excluded. Existing smaller layouts conservatively reserve one square each; oversized or unknown legacy layouts are explicitly flagged and excluded from the confirmed total. Old saved plans can recover their dimensions from their stored layout signatures.

The loading bar shows estimated overall progress and the current task. Milestones cover order-page loading (0–20%), component loading (20–45%), nesting and combining layouts (45–78%), sheet runtime checks (78–96%) and machine scheduling (97%). Unknown pagination totals use a bounded estimate. Long individual operations can pause at a percentage; no timer invents completion. The bar reaches 100% only after the complete preview arrives, resets on retry and stops on cancellation or failure.
