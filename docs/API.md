# CNC API v1

Base URL: `https://bsnndtwbvgrthddmbhoa.supabase.co/functions/v1/cnc-api/v1`

Creates immutable, private cutting jobs from the authenticated account's item library. One ordered item adds one copy of every component in that item; `quantity` multiplies that set. Components are automatically nested, with overflow placed on additional physical sheets. Every job starts in `awaiting_review`. The API never starts or controls a machine.

It also converts uploaded DXF text into new component NC through `POST /dxf-to-nc`, using the same generator as the site's **Generate** page.

Shopify orders and shared workshop box inventory are also available. See [Shopify and shared boxes](SHOPIFY-AND-BOXES.md) for routes, assignment permissions, server-side connection setup and packing assumptions. Dan sees all orders and assigns users with a fixed GBP cutting fee (record only); other users see only assigned orders. Shopify prices/customer details remain hidden. Box stock is deliberately shared by all authenticated users; changing a count requires its current revision.

## Authentication

In the site, open **Queue > API Access**, create a named key, and copy it before dismissing it. Keys expire after 90 days and can be revoked immediately. There may be at most 10 active keys per account. Only hashes are stored; the full key cannot be retrieved later. Key creation/revocation requires an MFA-verified signed-in session.

Send `Authorization: Bearer <account API key>` on every request. A verified Supabase user access token with MFA (`aal2`) is also accepted for the operator UI. Do not use the project's public key as authentication, and never give integrations the service-role key or Supabase personal access token. Account API keys can read that account's catalog/jobs/files, create catalogue items, upload new components, replace component programs with a revision check, replace/remove item images and create or transition jobs. They cannot delete components or manage keys.

Store the key in your automation's secret store, not source control, browser code or order payloads. All non-OPTIONS routes require authentication. Files are private authenticated downloads, not public URLs.

## Items and Images

`POST /items` creates an item in the authenticated account. Send JSON with required `name` (1-200 characters) and `sku` (1-100), optional `description` (up to 10,000), optional UUID `id`, and optional `image`. Example:

```json
{
  "id": "10000000-0000-4000-8000-000000000001",
  "name": "Camper locker",
  "sku": "LOCKER-800",
  "description": "800 mm flat-packed locker",
  "image": {"contentType": "image/jpeg", "dataBase64": "<base64 of actual JPEG bytes>"}
}
```

Images accept JPEG or PNG, up to **512 KiB decoded**, at most 4096 pixels per side and 16 megapixels. Encode actual file bytes as standard padded base64, without a `data:` prefix or line breaks. URLs, local filenames, SVG, GIF and multipart uploads are not accepted. Resize/compress larger images before sending. JSON bodies are limited to 720 KiB. The site also accepts WebP and automatically converts/resizes uploads to JPEG, at most 1200 pixels on the longest side; transparency is flattened onto white.

Creation is atomic (item and image together) and returns `201` with `id`, `name`, `sku`, `description`, and nullable `imageContentType`. It does not create components or a cutting job. For reliable retries, generate and retain a UUID `id` before the first request: an existing ID returns `409` without changing that item. Check `GET /items` after an uncertain response. Do not retry with a new ID unless you intend another item. `Idempotency-Key` applies only to jobs, not item creation. Choose unique SKUs for unambiguous job ordering.

- `GET /items` includes nullable `imageContentType`, not full image bytes.
- `GET /items/{id}/image` returns the private binary image with its MIME type; authentication is required. Missing images and inaccessible items both return `404`.
- `PATCH /items/{id}/image` with `{"image":{"contentType":"image/png","dataBase64":"..."}}` replaces an image. Use `{"image":null}` to remove it. Returns `200` with `id` and `hasImage`; repeated identical requests are safe. No other item fields or components are changed.

All reads and writes are owner-scoped. Images inherit item row-level access control and are not public URLs. Existing site autosaves cannot overwrite API image changes; reload an already-open site to see changes made by an API client. Invalid payloads return `400`, over-limit bodies `413`, and non-JSON requests `415`.

In **Items**, create/open an item to upload, replace or remove its image. **Add all to sheet** adds one copy of each component, nesting from the active physical sheet onward without moving existing placements. Overflow uses additional sheets; an oversized component blocks the whole addition. For API jobs, `items: [{"itemId":"...","quantity":1}]` already includes every component once.

## Upload Components

`POST /items/{id}/components` adds one component to an owned catalogue item. Send JSON:

```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "name": "Left side",
  "sku": "LOCKER-800-P01",
  "filename": "left-side.nc",
  "gcode": "<actual NC text>",
  "dxf": "<optional original DXF text>"
}
```

Generate and retain a UUID `id` per physical component design. Name is limited to 200 characters, SKU to 100, and filename to 128 (no paths; `.nc`, `.tap`, `.gcode`, `.cnc`). NC and optional source DXF are each limited to 2 MB UTF-8; each NC variant may have at most 10,000 lines, and the complete JSON body at most 12 MiB. NC must explicitly use G21/G90, contain finite machining geometry, and pass the existing transform and simulation error checks. Geometry, bounds and owner are derived by the server; caller-supplied dimensions/owner IDs are rejected. The optional DXF is retained as source, not regenerated by this endpoint.

Include the exact `materialVariants` object returned by `/dxf-to-nc` when uploading a generated component. It contains `version: 1`, `primaryProfile` and `profiles` keyed by `6`, `12`, `12-2pass`, `15`, `18`. Each profile contains `gcode`, `warnings` and `errors`; unavailable profiles have empty G-code and blocking errors. The primary profile must exactly match the uploaded `gcode`. Every available variant is independently validated, including its maximum cutting depth. Variants are stored in the owned component's separate `material_variants` database field and included in idempotent content comparison. Omitting this field preserves legacy single-program uploads; those cannot be used with an explicit sheet thickness.

To replace programs on an existing component after operator approval, use `PATCH /v1/items/{itemId}/components/{componentId}/gcode` with exactly `expectedSha256` (the previous primary NC hash), `expectedMaterialVariants` (the exact previous bundle, or null for legacy), `gcode` and `materialVariants` (the new validated bundle). The server atomically checks the old revision, ownership and parent item before updating. IDs, name, SKU, filename, import date and source DXF are retained. Returns `200` with `id`, `itemId`, `sha256`, `warnings` and `reviewRequired: true`. Exact retries of already-applied programs are accepted; stale revisions return `409` without replacement. Missing/foreign components return `404`. The component upload size and machining checks also apply. Retain the original payload and receipt for future revision checks; catalogue listings do not expose NC. Existing job artifacts and downloaded files remain unchanged. Reload open sheet pages and export again to use the corrected programs.

Returns `201` with `id`, `itemId`, `name`, `sku`, `filename`, `widthMm`, `heightMm`, the exact NC `sha256`, `warnings`, and `reviewRequired: true`. Replaying the same ID with identical name/SKU/filename/NC/DXF under the same owner and item returns `200` with `Idempotent-Replayed: true`. Different content/ownership with that ID returns `409`; it never overwrites another component. Foreign/missing parent items return `404`. Invalid payloads return `400`, oversized uploads `413`, machining errors `422`. Keep the exact generated NC/metadata when retrying, since generator/profile changes can alter a regenerated program. `Idempotency-Key` is not used for this route.

To create an item from DXFs: create the item once; call `/dxf-to-nc` for each DXF; review its warnings/operations; upload its exact returned NC plus source DXF through this route. Keep original source distinctions such as screw-mark depth, pre-existing corner reliefs and required tooling: do not silently substitute incompatible preset operations. No upload creates a sheet, approves a cutting job, or operates the machine. Reload the site to see API-created components. Job-generation limits (including 5,000 total source lines) still apply separately.

Browser sheet autosaves insert new components only; they never replace existing programs.
A database trigger also rejects machining-program, variant, source or geometry changes
from older browser upserts, so a stale open tab cannot undo an API correction. Use the
revision-checked replacement endpoint above for intentional program changes. After a
correction, back up any unsaved layout, reload the catalogue and re-export; existing
downloads and job artifacts are not rewritten.

## Generate NC from DXF

### Account Program Settings

The authenticated account must first save **Profile > CNC Program Settings** in the site. Start, spindle-start and end programs are private per-user settings, applied to both DXF conversion and newly generated sheet jobs. API keys cannot edit these settings or override them in request bodies. An unconfigured account receives `422`; a settings database error never falls back to another user's programs. Dan's existing metric / S18000 M03 / M05 M30 settings are provisioned only for his account.

DXF responses include the applied `programSettings`; job manifests snapshot them as `manifest.programSettings`. `settings.spindleRpm` reflects the profile's spindle-start program. Retries with an existing job idempotency key still return the original immutable job, even if the profile has since changed or become unavailable. A new revision/key uses the current settings. Profile changes never rewrite saved source components or existing job artifacts.

Programs are validated before use. Metric/absolute/XY-plane setup and safe-Z guards remain enforced; cutting spindle start runs after sheet reach checks, and shutdown retracts and sends M05 before the custom end program. Basic programs support metric setup, G54-G59 selection in startup, explicit G00 parking at/above safe Z, G04 P dwell, M03 spindle start, M05 stop, M07-M09, startup/ending M00/M01 pauses, and final M02/M30. Fields are limited to 100 lines / 8,000 characters each. A non-empty spindle-start program must set a positive S speed and leave M03 active; its end program must stop with M05 and end with M02/M30.

**Manual routers:** `spindleStartGcode` may be an empty string. This intentionally disables automatic spindle start; no RPM or M03 is substituted. API `settings.spindleRpm` is `0` to indicate no configured automatic RPM, not a command to run at zero RPM. The end program may simply be `M30`. Existing M05 safety guards and user-authored startup/end commands are retained, but M05 cannot stop a manually switched router. The operator is responsible for starting/stopping the cutter. Automatic screw marking remains blocked without automatic spindle control: set `sheet.screwMarks` to `false` for API sheet jobs, or disable screw marking in the site. Never insert a dummy spindle command to bypass this check.

Duet M291 prompts support X/Y/Z jog flags with values 0 or 1, including `M291 P"Check clearance" S3 Z1`. These are jog-button flags, not motion coordinates.

Duet startup programs are recognized by M98, M291, M400, M563 or M585. They additionally support quoted macro paths/prompts, temporary tools, Z-only M585 probing, G10 L20 Z touch-off, G91/G90, positive Z-only G00/G01 retraction and M03 S startup spindle commands. Unsupported commands, XY cutting, inch mode, homing and malformed syntax are rejected. Duet lines are limited to 255 ASCII characters. Legacy tool numbers above 49 and M585 E/L parameters trigger a firmware compatibility warning. See the [official RepRapFirmware G-code reference](https://docs.duet3d.com/en/User_manual/Reference/Gcodes).

For Duet startup, no generated Z move precedes the custom block. Afterwards, generated code restores G21/G17/G90/G94, stops the startup spindle with M05, then retracts to safe Z (20 mm for DXF) before any generated XY travel. The separate **Spindle start** field still controls cutting RPM. Startup text is preserved, but external macros, probe movements and tool changes are **not simulated**; an operator must verify macro contents, firmware compatibility and final work zero. A macro call plus inline M585 triggers a possible double-probe warning. Use one tested probe cycle, not both if the macro already probes.

Generated controller startup blocks are excluded from component machining geometry and are stripped when nesting components, so probing runs once at the sheet program start, not once per component. Each separately exported physical sheet gets its own startup. Block boundary/reset validation fails closed. Existing saved source components and queued job files are not rewritten by changing profile settings. Review physical parking coordinates, spindle settings and controller dwell units before running.

`POST /dxf-to-nc` takes JSON and returns JSON containing the generated `gcode`. Send the actual DXF text, not a local path, URL or base64 string. `jq --rawfile` handles newlines and escaping:

```bash
export CNC_API='https://bsnndtwbvgrthddmbhoa.supabase.co/functions/v1/cnc-api/v1'
# Populate CNC_API_KEY from your secret store.
jq -n --rawfile dxf component.dxf \
  '{dxf: $dxf, filename: "component.dxf", thicknessMm: 18}' \
  | curl --fail-with-body "$CNC_API/dxf-to-nc" \
      -H "Authorization: Bearer $CNC_API_KEY" \
      -H 'Content-Type: application/json' \
      --data-binary @- --output component-result.json

# Only extract the program after the request succeeds.
jq -ej '.gcode // error("No NC was generated")' component-result.json > component.nc
```

Request fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `dxf` | Yes | ASCII DXF text, at most 2,000,000 UTF-8 bytes |
| `thicknessMm` | Yes | `6`, `12`, `15` or `18` |
| `profilePasses` | No | Only for 12 mm stock: `1` (default) or `2` (depths 6.1, then 12.2 mm). Omit for 6/15/18 mm stock. |
| `filename` | No | DXF basename, default `component.dxf`; no directories; letters, digits, spaces, dots, underscores and hyphens |
| `units` | No | `auto` (default), `mm`, or `inches`; output is always metric |
| `layerOperations` | No | Exact DXF layer names mapped to operation overrides |
| `operations` | No | Feature IDs mapped to overrides, applied after layer overrides |

An override can contain `kind` (`outside`, `inside`, `drill`, `pocket`, `ignore`, or `unassigned`), `tabs` (integer 0-4, contours only), `depthMm` (blind pockets only, strictly less than stock thickness), and `cornerOvercuts` (boolean, non-circular pockets and inside contours only; defaults true). Non-door inside holes/cut-outs accept `tabs: 0` and return a workholding review warning. Outside profiles larger than 12 mm in X or Y, and recognized doors, still require 1-4 tabs: `tabs: 0` returns `422`, as does geometry on which no required tab fits. Dimensions are evaluated in millimetres before cutter compensation, including circles. Layer names are case-sensitive. Unknown layers, feature IDs, request properties and ineffective overrides are rejected, not silently ignored. Individual feature properties take precedence over layer properties. With no overrides, the same layer-name and geometry classification as the browser is used. For example:

```json
{
  "layerOperations": {
    "HOLES": {"kind": "drill"},
    "DOORS": {"kind": "inside", "tabs": 4},
    "PROFILES": {"kind": "outside", "tabs": 4},
    "REFERENCE": {"kind": "ignore"}
  }
}
```

Include that object alongside `dxf` and `thicknessMm`. Returned `features` identify the classified feature IDs and layers for subsequent requests. Invalid machining returns `422` with error details and **no G-code**. Unsupported entities must be corrected in the source drawing, not merely ignored through overrides.

For the optional two-pass 12 mm preset, include `"thicknessMm": 12, "profilePasses": 2`. It returns `passDepthsMm: [6.1, 12.2]` and a filename ending `-12mm-2pass.nc`. Drilling remains 4.5 mm deep; clearance, ramps and tabs are unchanged. Explicit blind pockets deeper than 6.1 mm use an initial 6.1 mm pass before their assigned depth. Omitting `profilePasses` preserves existing output. Unsupported pass selections or specifying it for 15/18 mm stock return `400`.

For 6 mm stock, use `"thicknessMm": 6` and omit `profilePasses`: profiles and inside openings cut to 6.2 mm in a single pass (`passDepthsMm: [6.2]`). Spindle settings come from the same account profile; cutting remains F3000, ramps/drilling F600, and clearance Z20. Blind drilling remains 4.5 mm with 2 mm pecks. Hinge pockets are blocked; other blind pockets must be shallower than 6 mm. Existing tab rules/height are retained. Supplying `profilePasses` for 6 mm stock returns `400`.

Internal openings with a narrowest full-outline width <= 12 mm always use zero tabs, regardless of length, rotation, door label or positive `tabs` override. Rectangles and rectangular mortises with local corner reliefs use their straight-wall spacing, allowing up to 12.2 mm for a nominal 12 mm slot with 0.2 mm fit clearance. This only changes tab selection, not drawing geometry or cutting depth. Circles keep the strict 12 mm diameter threshold. Non-fitting tabs are automatically removed from ordinary inside cutouts with a waste-movement review warning; larger doors and outside profiles remain protected. This exception takes precedence over the general tab defaults above and below. Rectangular/square holes narrower than the 6.35 mm cutter are also widened centrally to cutter size, with a review warning. They remain through-holes, not blind drills. Slots use centreline ramping; point-sized holes use 2 mm pecks. `cornerOvercuts` remains supported; widening/relief collisions still block export.

The successful `200` response includes:
- `filename` (ending `.nc`), `contentType`, `bytes`, `sha256`, and `gcode`. The hash and byte count cover the exact UTF-8 `gcode` string. The example uses `jq -j` to avoid adding an extra newline.
- `reviewRequired: true`, and `warnings`, including unspecified drawing units or insufficient room for all tabs. Neither an empty warnings list nor HTTP 200 certifies a machine setup.
- `settings`: resolved material thickness, assumed drawing units, cutter, spindle, clearance, depths, peck size and feeds.
- `materialVariants`: automatically generated programs for all five supported profiles, preserving operation overrides and account program settings. The requested thickness remains the primary `gcode`/`settings`/preview result. Invalid alternative thicknesses are marked unavailable, not silently changed.
- `features`: IDs, names, layers and resolved operation kinds, including ignored features.
- `operations`: machining order, depth, actual tab count and inclusive 1-based NC line ranges.
- `drawingShiftMm` and `summary`: toolpath bounds (including clearance/travel), deepest cut and operation count.

Presets match the site: 6.35 mm cutter, account-profile spindle speed (18,000 rpm for Dan's existing settings), Z20 clearance, ramps up to 3 degrees, F600 drilling/ramping and F3000 contour cutting. Drills use the cutter diameter regardless of nominal DXF circle diameter. In 15 mm and 18 mm stock, drills peck to 2, 4, 6, 8 and 9.2 mm; in 12 mm stock, to 2, 4 and 4.5 mm. Between pecks at the same hole they retract to Z0.5 (`settings.drillPeckRetractMm`); after the final peck they retract to Z20 before lateral travel. Sheet safe-Z overrides preserve these short same-hole peck retracts. Profiles cut to 18.4 mm in two 9.2 mm passes, 15.4 mm in two 7.7 mm passes, or 12.2 mm in one pass. Profiles offset outside; doors offset inside. Through-cut parts/holes larger than 12 mm in X or Y, plus recognized doors, default to four tabs. Tabs may be removed explicitly on non-door inside holes/cut-outs, but remain mandatory for recognized doors and large outside profiles. Other contours default to zero; drills and blind pockets never receive tabs. A 35 mm circle inside a non-circular inside/door contour is automatically a 12 mm-deep hinge pocket; these require 15 mm or 18 mm stock. Other internal openings default to through-cuts, regardless of a `POCKET` layer name. Explicit `kind: "pocket"` assignments support circular and non-circular blind pockets, including concave and split clearing regions, but not nested islands. Non-circular pockets and inside cuts have automatic dogbone corner relief unless disabled. See [CAM details and supported geometry](CAM.md).

Component NC has **no reach check and no screw marking**; those belong to sheet export after placement. The response always requires operator review. This endpoint does not save a component, alter an item, create a queued job, generate PDFs/labels, or send anything to the machine. To use the result with the jobs API, upload its NC into an account item through `/items/{id}/components` or the site first.

Conversion is synchronous and stateless. `Idempotency-Key` is not required or stored for this route; retrying does not create duplicates. Repeated identical requests against the same deployed generator produce the same NC. Generator updates may change output, so retain the response/hash for an approved revision.

Limits: 4 MiB JSON request, 2 MB DXF text, the shared parser's 1,000-entity limit, 100 parsed features, 10,000 sampled curve points, and output at most 10,000 NC lines / 2 MB. The feature/point limits include ignored geometry. These limits are lower than the browser worker because [Supabase Edge Functions have a 2-second CPU budget](https://supabase.com/docs/guides/functions/limits). Split complex drawings if the platform reports a resource limit; retrying an oversized drawing unchanged will not help. The existing per-account 60 requests/minute limit is shared with all API routes.

## Create a Job

```bash
export CNC_API='https://bsnndtwbvgrthddmbhoa.supabase.co/functions/v1/cnc-api/v1'
# Populate CNC_API_KEY from your secret store.
curl --fail-with-body "$CNC_API/jobs" \
  -H "Authorization: Bearer $CNC_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: shop-order-1042-batch-1' \
  --data '{
    "jobName": "Camperlocker production",
    "orderNumber": "1042",
    "items": [{"sku": "YOUR-ITEM-SKU", "quantity": 2}],
    "sheet": {
      "widthMm": 1220,
      "heightMm": 1220,
      "material": "Birch plywood",
      "thicknessMm": 18,
      "spacingMm": 30,
      "borderMm": 10,
      "safeZMm": 20,
      "screwMarks": true
    },
    "labels": {"widthMm": 50, "heightMm": 25},
    "notes": "Check grain direction and the loaded cutter before cutting."
  }'
```

Use exactly one of `sku` or `itemId` per line. SKU matching is exact and case-sensitive; duplicate SKUs are rejected as ambiguous. `GET /items` returns valid IDs and SKUs for the caller's account. Repeated lines referencing the same item are combined. Quantity is a positive integer, not a machining-pass count.

Required: `jobName`, `orderNumber`, `items`, and sheet `widthMm`, `heightMm`, `material`. Unknown properties are rejected, including owner IDs and feed/depth overrides. Optional defaults: spacing 30 mm, border 10 mm, safe Z 20 mm, screw marks on, labels 50 x 25 mm. Set `screwMarks: false` to disable marking. Explicit settings and already-generated job files are not changed by new defaults. Material thickness and notes are optional.

`sheet.thicknessMm` now selects the actual program for every component, not just descriptive metadata. Supported values are 6, 12, 15 and 18. For 12 mm stock, optional `sheet.profilePasses: 2` chooses two 6.1 mm passes; otherwise it uses one 12.2 mm pass. Missing or unavailable component variants return 422 without queuing a job. Omit thickness to preserve original NC for legacy components. This is a behavior change for clients that previously supplied thickness only as a declaration. Keep grain/workholding review; selection does not validate the physical stock. Saved job artifacts remain immutable.

The response is `201 Created` with `Location`, a UUID `id`, job/order names, `status`, timestamps, `manifest`, `files` and `status_history`. Example file metadata:

```json
{
  "name": "labels.pdf",
  "contentType": "application/pdf",
  "bytes": 16420,
  "sha256": "<64-character hexadecimal SHA-256>"
}
```

Files:
- `sheet-plan.pdf`: order contents, notes, setup specifics, warnings, a toolpath/layout drawing for each sheet, a per-part cutting list, and source feed/spindle values and hashes.
- `labels.pdf`: one exact-size page per placed part; defaults to 50 x 25 mm. Print at actual size / 100%.
- `sheet-1.nc`, `sheet-2.nc`, etc.: separate physical-sheet G-code using the same exporter and validation as the site.
- `manifest.json`: machine-readable placements, stable part numbers, component dimensions/source filenames, deepest cuts, maximum X/Y reach, timing estimates, material/settings, notes, warnings, and source hashes.

Generation is synchronous. A job and all artifacts are committed in one database transaction only after successful generation/validation. Failures do not leave partial jobs. Requests that fail before commit may be safely retried. A network timeout does not prove failure; always retry with the same idempotency key and payload.

### Retry and Idempotency Rules

`Idempotency-Key` is mandatory for job creation, scoped to the account, and retained with the job. Use an external order ID plus a batch/revision suffix. Replaying the same normalized request returns the existing job (`200`, usually `Idempotent-Replayed: true`), even if the library subsequently changes. Concurrent identical requests publish only one job. Reusing the key with different settings/items returns `409`.

Job names and order numbers are not unique keys. To intentionally create a new revision, use a new idempotency key and cancel the obsolete job. Existing job artifacts are snapshots; edits to items or the interactive sheet never alter them.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/items?limit=25&offset=0` | Own items, SKUs, image MIME types and component summaries |
| POST | `/items` | Create an item with an optional image |
| GET | `/items/{id}/image` | Download the private item image |
| PATCH | `/items/{id}/image` | Replace or remove the item image |
| POST | `/items/{id}/components` | Upload a new component with optional source DXF |
| POST | `/dxf-to-nc` | Stateless DXF-to-component-NC generation, operator review required |
| POST | `/jobs` | Create nested job and all files |
| GET | `/jobs?status=awaiting_review&limit=25&offset=0` | Queue summaries, newest first |
| GET | `/jobs/{id}` | Full manifest, status, file metadata and audit history |
| GET | `/jobs/{id}/artifacts/{filename}` | Download an authenticated binary/text file |
| PATCH | `/jobs/{id}` | Compare-and-set queue status |

List responses contain `items` or `jobs`, `limit` and `offset`. Request subsequent offsets until a page contains fewer than `limit` entries. Queue pages are a live view, not a frozen snapshot; new jobs can shift offsets. Supported limits: 1-100, offset 0-100000. Omit `status` for all jobs.

```bash
curl --fail-with-body "$CNC_API/jobs/$JOB_ID/artifacts/labels.pdf" \
  -H "Authorization: Bearer $CNC_API_KEY" --output labels.pdf
```

## Operator Review and Queue Status

Allowed transitions: `awaiting_review -> ready -> cutting -> completed`. Any nonterminal status can also transition to `cancelled`. Completed and cancelled jobs are terminal. All changes are recorded with the actor and time. `expectedStatus` prevents two operators from silently overwriting each other's status changes.

```bash
curl --fail-with-body -X PATCH "$CNC_API/jobs/$JOB_ID" \
  -H "Authorization: Bearer $CNC_API_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"expectedStatus":"awaiting_review","status":"ready","reviewConfirmed":true}'
```

Set `reviewConfirmed` only after an operator has reviewed the documents, stock, cutter, work origin, travel and clearances. Changing status never sends a start, pause or stop command to the DDCS. Cancelling a cutting job does **not** stop the machine. Use the machine's controls for physical operations.

### Machining Specifics

- Metric, absolute source programs are required. Invalid or oversized components, collisions, unsupported transformations and detected simulation errors prevent publication.
- Auto nesting uses conservative convex machining outlines, allowing parts beside diagonal edges even when bounding rectangles overlap. Holes and concavities remain reserved; ambiguous/open geometry falls back to rectangular bounds. It tests edge-aligned straightening and quarter-turns, choosing fitting placements without changing source depths, feeds or tabs. This is heuristic nesting, not a global optimum. Rotations in manifests can be fractional degrees. The operator must check grain/orientation restrictions; there is no grain-aware nesting in this version. Existing queued jobs are immutable and are not re-nested.
- Cutting depths and feeds come from the source files; no machining overrides are accepted. Above-surface rapid clearance is overridden to the requested safe Z (20 mm by default).
- The authenticated user's profile supplies the start, spindle-start and end programs. Metric absolute-mode and safe-Z guards are enforced. Verify cutter, spindle speed, parking and DDCS start-up delay against the applied `programSettings`. This API does not infer tool diameter from filenames.
- A spindle-off maximum X/Y reach check precedes cutting on each sheet. Validation cannot establish physical machine limits or clamp clearance.
- Optional screw marking assumes a **6 mm cutter and recessed heads**, plunges 2 mm into waste positions, then uses `M05` and `M00` to pause for screws. Material must already be restrained for marking.
- Load and run each physical-sheet file separately. Labels and PDF layouts use the same part numbers as the G-code comments. Apply labels only while the machine and spindle are stopped.
- Dimensions in the cutting list are toolpath footprints, not finished dimensions. Time estimates exclude manual operations and are approximate.

## Limits and Errors

Initial limits are intentionally bounded for serverless generation: 20 order lines; 20 placed components; 5,000 expanded source-program lines; 2 MB selected source G-code; 12 MB generated files; 64 KiB request body; 60 authenticated requests per minute per account. Split larger orders into batches with separate idempotency keys. Stock dimensions: 50-10000 mm; safe Z: 0.5-200 mm; label dimensions: 40-190 x 20-277 mm. These are API validation limits, not certified machine limits. Large-batch automation should split requests; the hosting platform imposes a 2-second CPU limit per invocation.

PDF text supports Latin, Greek and Cyrillic via the bundled Noto Sans font. Other unsupported characters are rejected rather than silently printing missing glyphs. Long label fields are truncated with ellipses; full values remain in the cutting-list PDF and JSON manifest.

Errors are JSON with `error`, optional `details`, and a `requestId`. `400` invalid input/key requirement; `401` missing, revoked, expired or invalid credentials; `404` inaccessible/missing job or file; `409` idempotency/status conflict; `413` oversized body; `415` wrong content type; `422` invalid machining/job generation; `429` rate limit (`Retry-After: 60`); `500` unexpected backend error. Never retry validation failures unchanged. Retry transient/network failures using the original idempotency key.

## Deployment and Development

The API is a Supabase Edge Function. The site's GitHub Pages deployment applies `supabase/schema.sql`, `supabase/api.sql` and `supabase/orders.sql` after tests. Backend credentials remain in Supabase; no service-role key belongs in a Vite environment variable.

```bash
npm ci
npm test
npm run build:api
npx supabase login
npx supabase functions deploy cnc-api --project-ref bsnndtwbvgrthddmbhoa --use-api
```

`build:api` type-checks the server and bundles the existing shared domain code and font into the generated, ignored `supabase/functions/cnc-api/index.ts`. Dependency versions are pinned in its `deno.json`. Keep those pins aligned with `package-lock.json` when upgrading.

For automatic backend deployment after successful site/schema deployments, add `SUPABASE_ACCESS_TOKEN` to repository Actions secrets. Without it, the API workflow reports that deployment was skipped and local deployment is required. A local CLI login does not configure GitHub Actions.

Local backend: after `npm run build:api`, run `npx supabase functions serve cnc-api` against a local Supabase instance with the schemas applied and local auth/catalog fixtures. Never use production service credentials for an unauthenticated local test fixture. The function validates its own account key or MFA JWT on every non-OPTIONS request; platform JWT verification is disabled specifically to support account API keys.

The bundled Noto Sans font is licensed under the SIL Open Font License in `api/assets/OFL.txt`. Source: https://github.com/notofonts/noto-fonts/tree/main/hinted/ttf/NotoSans.
