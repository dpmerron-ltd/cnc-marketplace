# Complete Item Revision Imports

Use an import when a redesign changes the complete bill of materials, component
SKUs, image and customer PDFs. Uploads are private to the authenticated account.
Nothing changes in the catalogue until the complete import is published.
Existing sheets, jobs, original programs, PDFs and older versions are retained.

All routes are below `/v1/items/{any-version-id}/imports` and use the normal
account API key or MFA session. Keep all UUIDs and exact request bodies for retries.

1. `POST /imports` with the following manifest. `expectedVersionId` must be the
   current default from `GET /items`. The image is required: JPEG/PNG data or
   explicit `null`. This replaces all components and documents, not just changes.

   ```json
   {
     "id": "<new import UUID>",
     "expectedVersionId": "<current default UUID>",
     "item": {"name": "Workbench", "sku": "VS-0002", "description": "Revision C", "image": null},
     "componentIds": ["<new component UUID>"],
     "documentIds": ["<new PDF UUID>"]
   }
   ```

2. For each component, `POST /imports/{id}/components` with `id`, `name`, `sku`,
   `filename`, `gcode`, optional original `dxf`, and `primaryProfile`. Use the
   generated primary program verbatim. Do not include `materialVariants` here.
   Dimensions and bounds are computed by the server, not supplied by the caller.
3. For each of the ten cutting profiles, `POST /imports/{id}/profiles` with
   `componentId`, `profileId`, `gcode`, `warnings`, `errors`. Copy each entry from
   the generator's variant bundle. Available NC is independently validated for
   machining, size and cutting depth. Unavailable profiles require empty NC and
   nonempty blocking errors. Do not substitute NC from another thickness.
4. `POST /imports/{id}/documents` with the usual PDF upload: `id`, `kind`
   (`instructions` or `packing`), `filename`, `dataBase64`. Original PDF bytes are
   retained, maximum 20 MB/200 pages. The UUID must be in the manifest.
5. `GET /imports/{id}` reports staged entry keys and `publishedItemId`. Review the
   bill of materials, files, profile errors/warnings, stock, cutter and setup.
6. `POST /imports/{id}/publish` with `{"reviewConfirmed":true}` publishes exactly
   one new default version. Missing entries, duplicate component SKUs, mismatched
   primary NC, missing PDF objects, or a changed default prevent publication.

Component/profile bodies are limited to 12 MiB, with 2 MB and 20,000 lines per NC
and 2 MB per DXF. Uploading profiles separately bounds server work for complex
parts. At most 100 components and 20 documents are allowed per import; at most
20 unpublished imports may be pending in one account. Respect `429` Retry-After.

Identical begin/stage/publish retries are safe. A staged key cannot be overwritten
with different content. Use a new import UUID after correcting files or resolving
a default-version conflict. An import belonging to another account or item is not
accessible. Retrying publication returns the original published item ID, even if
subsequent edits have since made another version the default.

The new version uses fresh component IDs and resets packing overrides: old
component-specific dimensions must not be reused for redesigned parts. Existing
orders still match the product SKU; explicit old item IDs remain pinned to their
original versions. This does not create, approve or start a cutting job.
