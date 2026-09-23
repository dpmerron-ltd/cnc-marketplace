# At Machine

Open `/#machine` under the application's base URL on a phone, or choose **At Machine**.
Sign in to the same account used for the export. MFA and account isolation still apply.

## Export and Review

- **Export Combined** and **Export Sheets** save a new, immutable export before downloading NC files.
- New exports start **Waiting to cut**. A failed cloud save blocks the download and can be retried without creating another export.
- The saved view contains physical-sheet layouts, numbered parts, tab positions, screw marks, reach extents, selected material/profile, clearance Z, deepest cut, warnings and the exact NC files.
- Select a physical sheet, zoom the layout, or select a part for tab coordinates. Tab coordinates are in millimetres; inferred imported-NC tabs remain marked as inferred.
- **Download NC** retrieves the saved bytes, checks their SHA-256 fingerprint, and does not regenerate anything from the current catalogue.
- **Copy sheet link** opens that export on another signed-in device. Links do not grant access to another account.

Mark the export **Cutting**, then **Completed**, or cancel it. These are record-only actions, not CNC commands. A status applies to every physical sheet in that export. Concurrent status changes require a refresh.

The layout is an inspection aid, not a safety certification or collision simulator. Verify the actual file, stock, tooling, workholding, origin and clearance. Original-NC exports without an explicitly selected material profile show thickness as unknown rather than guessing from machining depth.

## Scope and Deployment

Only new sheet exports create these records. Existing sheet history cannot reconstruct exact previously exported NC files and is not backfilled. API-created jobs remain in the existing **Queue** workflow.

`supabase/schema.sql` creates `cnc_machine_runs`. Deploy it before the frontend. Queue listing selects metadata only; full snapshots load only when opened and do not require component downloads. There are no changes to G-code generation or existing component records.

Verification includes snapshot/NC identity, material selection and placement mapping, failed-save retries, account isolation, immutable storage, legal status transitions, direct links, and desktop/mobile browser checks.
