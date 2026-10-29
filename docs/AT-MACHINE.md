# Cutting Jobs

**Cutting Jobs** replaces **At Machine**. Open `/#machine` under the application's base URL and sign in to the account that owns the plan. Existing immutable exports remain under **Previous exports**.

## Plan a day's cutting

Each job is a saved tab containing a stock size, material/thickness, layout and any number of physical sheets. Use **New job** for another stock setup, such as an 18 mm batch alongside a 12 mm batch. Switching tabs preserves their contents. Tabs save automatically to the account, with a lightweight browser recovery copy; the save indicator reports pending or failed cloud writes. Version checks prevent a phone or another browser from overwriting newer waiting work. Reload after a conflict; **Download unsaved recovery** preserves the other local plan as an importable file containing its uncut tabs.

Use **Remove job** beside **New job**, or on a Cutting Jobs card, to discard a job’s waiting parts. Populated jobs ask for confirmation. Queued re-cuts become available to add again; previous exports and cut-sheet records remain in history. Sheets still cutting must be marked cut first. Removing the last open job leaves a fresh empty job ready to use. Removed waiting layouts cannot be downloaded for cutting.

New jobs default to today's date. The first export allocates a shared daily number on the server, using Europe/London time: `2026-10-29-001`. A job keeps that number; subsequent exports add `-r2`, `-r3`, etc. Cancelled reviews can leave gaps in the sequence, and retries keep their reserved number.

Add orders or individual components to the selected tab. **Re-plan waiting sheets** explicitly repacks uncut work across compatible jobs. Material, thickness/profile, sheet dimensions, spacing, border, clearance, screw-marking and program settings must match. Opposite cutting faces remain on separate sheets. Order references and replacement identities follow the parts when they move. Empty jobs merged into another job leave the working tabs, while their previous exports remain traceable.

Re-planning never runs automatically. It does not move parts on sheets marked **Cutting** or **Cut**, and those sheets are never used for new placements. Changed waiting layouts require a fresh export. Marking a sheet cut does not remove its parts from the record or return them to the uncut pool.

## Export and progress

- **Export Sheets** creates a separate file for each occupied waiting sheet. Cut and cutting sheets are excluded, preserving physical sheet numbers even when the first remaining sheet is Sheet 2 or later.
- Filenames include the face requirement, for example `2026-10-29-001-r2-sheet-2-non-pattern-side-up.nc`. Unrestricted sheets have no face suffix.
- **Export Combined** retains load-sheet pauses. If a sheet in a combined file has started, other waiting sheets need a fresh export before that file can be downloaded to start again.
- Review, simulation and cloud persistence precede download. A failed save blocks download; retrying preserves the export ID and exact bytes.
- Use **Start cutting** or **Mark cut** for each physical sheet. These record progress and do not control the CNC. A cutting or cut sheet's layout and stock settings are fixed, including against stale cloud autosaves. Use a replacement request for failed parts.
- **Cutting file** opens the immutable layout, numbered parts, tabs, reach extents, screw positions and NC file. Downloads verify SHA-256 and use the saved bytes. Superseded waiting files cannot be downloaded from this view.

The latest cutting plan must load before downloading a managed job's file. Legacy exports remain accessible independently of the catalogue. Direct links require the same account and MFA.

## Labels and replacements

**Print labels** is available for every sheet in Cutting Jobs and in the exported-file view. Managed jobs print from the latest saved plan, including changed placements and added replacements. Saved snapshots also retain their original labels; older exports can print basic labels from their recorded part map.

Select a failed part in its exported layout and choose **Re-cut**. **Queue → Re-cuts → Add to sheet** adds one replacement of the original component revision to the selected job. Empty jobs adopt its material/profile; populated jobs must use matching stock. Placement respects cutting face, existing parts and closed sheets. An already-added replacement cannot be added twice. Marking its destination sheet cut completes the queued replacement.

Older exports without component IDs are recoverable when a saved sheet reproduces their exact NC bytes. If that check cannot succeed, the application asks the operator to select the original component from the library rather than guessing a revision. **Mark re-cut** and **Remove** remain available for completing or cancelling queue entries manually.

## Persistence and deployment

Apply `supabase/schema.sql` before the frontend. Editable plans live in the account-scoped `sheet_projects.workspace`; daily numbers use `cnc_job_names` and `cnc_job_daily_numbers`. `cnc_machine_runs` continues to hold immutable exports, and `cnc_machine_recuts` holds replacement requests. Old single-sheet projects migrate into their first working tab without discarding the layout. API-created jobs continue to use the existing Queue workflow; their physical NC artifacts also include cutting-face suffixes.

Tests cover separate job tabs, material/face grouping, fixed cutting/cut sheets, revisions that omit completed work, stale-file blocking, live label routing, numbering retries and MFA, account isolation, and database rejection of stale saves that reopen or rearrange cut sheets.
