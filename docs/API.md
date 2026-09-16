# CNC Jobs API v1

Base URL: `https://bsnndtwbvgrthddmbhoa.supabase.co/functions/v1/cnc-api/v1`

Creates immutable, private cutting jobs from the authenticated account's item library. One ordered item adds one copy of every component in that item; `quantity` multiplies that set. Components are automatically nested, with overflow placed on additional physical sheets. Every job starts in `awaiting_review`. The API never starts or controls a machine.

## Authentication

In the site, open **Queue > API Access**, create a named key, and copy it before dismissing it. Keys expire after 90 days and can be revoked immediately. There may be at most 10 active keys per account. Only hashes are stored; the full key cannot be retrieved later. Key creation/revocation requires an MFA-verified signed-in session.

Send `Authorization: Bearer <account API key>` on every request. A verified Supabase user access token with MFA (`aal2`) is also accepted for the operator UI. Do not use the project's public key as authentication, and never give integrations the service-role key or Supabase personal access token. Account API keys can read that account's catalog/jobs/files and create or transition its jobs; they cannot edit the component library or manage keys.

Store the key in your automation's secret store, not source control, browser code or order payloads. All non-OPTIONS routes require authentication. Files are private authenticated downloads, not public URLs.

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
      "spacingMm": 5,
      "borderMm": 10,
      "safeZMm": 20,
      "screwMarks": false
    },
    "labels": {"widthMm": 50, "heightMm": 25},
    "notes": "Check grain direction and the loaded cutter before cutting."
  }'
```

Use exactly one of `sku` or `itemId` per line. SKU matching is exact and case-sensitive; duplicate SKUs are rejected as ambiguous. `GET /items` returns valid IDs and SKUs for the caller's account. Repeated lines referencing the same item are combined. Quantity is a positive integer, not a machining-pass count.

Required: `jobName`, `orderNumber`, `items`, and sheet `widthMm`, `heightMm`, `material`. Unknown properties are rejected, including owner IDs and feed/depth overrides. Optional defaults: spacing 5 mm, border 10 mm, safe Z 20 mm, screw marks off, labels 50 x 25 mm. Material thickness and notes are optional. Material declarations are supplied by the caller; the library does not validate that every component uses the same stock or grain direction.

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

`Idempotency-Key` is mandatory for creation, scoped to the account, and retained with the job. Use an external order ID plus a batch/revision suffix. Replaying the same normalized request returns the existing job (`200`, usually `Idempotent-Replayed: true`), even if the library subsequently changes. Concurrent identical requests publish only one job. Reusing the key with different settings/items returns `409`.

Job names and order numbers are not unique keys. To intentionally create a new revision, use a new idempotency key and cancel the obsolete job. Existing job artifacts are snapshots; edits to items or the interactive sheet never alter them.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/items?limit=25&offset=0` | Own items, SKUs and component summaries |
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
- Auto nesting may rotate components. The operator must check grain/orientation restrictions; there is no grain-aware nesting in this version.
- Cutting depths and feeds come from the source files; no machining overrides are accepted. Above-surface rapid clearance is overridden to the requested safe Z (20 mm by default).
- The job start block is `G21 G17 G90 G94`, with `S18000 M03` spindle start and `M05 M30` end. Verify cutter and spindle speed, and configure the DDCS spindle start-up delay. This API does not infer tool diameter from filenames.
- A spindle-off maximum X/Y reach check precedes cutting on each sheet. Validation cannot establish physical machine limits or clamp clearance.
- Optional screw marking assumes a **6 mm cutter and recessed heads**, plunges 2 mm into waste positions, then uses `M05` and `M00` to pause for screws. Material must already be restrained for marking.
- Load and run each physical-sheet file separately. Labels and PDF layouts use the same part numbers as the G-code comments. Apply labels only while the machine and spindle are stopped.
- Dimensions in the cutting list are toolpath footprints, not finished dimensions. Time estimates exclude manual operations and are approximate.

## Limits and Errors

Initial limits are intentionally bounded for serverless generation: 20 order lines; 20 placed components; 5,000 expanded source-program lines; 2 MB selected source G-code; 12 MB generated files; 64 KiB request body; 60 authenticated requests per minute per account. Split larger orders into batches with separate idempotency keys. Stock dimensions: 50-10000 mm; safe Z: 0.5-200 mm; label dimensions: 40-190 x 20-277 mm. These are API validation limits, not certified machine limits. Large-batch automation should split requests; the hosting platform imposes a 2-second CPU limit per invocation.

PDF text supports Latin, Greek and Cyrillic via the bundled Noto Sans font. Other unsupported characters are rejected rather than silently printing missing glyphs. Long label fields are truncated with ellipses; full values remain in the cutting-list PDF and JSON manifest.

Errors are JSON with `error`, optional `details`, and a `requestId`. `400` invalid input/key requirement; `401` missing, revoked, expired or invalid credentials; `404` inaccessible/missing job or file; `409` idempotency/status conflict; `413` oversized body; `415` wrong content type; `422` invalid machining/job generation; `429` rate limit (`Retry-After: 60`); `500` unexpected backend error. Never retry validation failures unchanged. Retry transient/network failures using the original idempotency key.

## Deployment and Development

The API is a Supabase Edge Function. The site's GitHub Pages deployment applies `supabase/schema.sql` and `supabase/api.sql` after tests. Backend credentials remain in Supabase; no service-role key belongs in a Vite environment variable.

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
