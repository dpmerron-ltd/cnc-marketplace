# Automatic Item Versions

Each successful item update automatically creates the next numbered version and
makes it the default. There is no draft or Publish step. Unchanged sheet autosaves
do not create versions. Typing is grouped by the existing autosave delay.

Versions preserve item details, images, packing settings, components, source DXFs,
all saved cutting profiles and attached PDFs. Use the item's **Version** selector
to view an older read-only version or add its components to a sheet. Editing the
default version keeps the editor on the newly saved default.

Existing sheets retain their original component IDs and programs. Saved jobs and
exported files are not rewritten. The catalogue, order matching and SKU-based API
jobs select the newest default version.

## API

- `GET /v1/items` lists current defaults, including `version_family_id`,
  `version_number`, `version_default` and component IDs.
- `GET /v1/items/{any-version-id}/versions` lists that item's history, newest first.
  Normal `limit` and `offset` pagination apply.
- Existing description, image, component and document write endpoints create
  versions automatically. They address the current default in the supplied
  item's family. Existing compare-and-swap checks still protect program and
  description changes against stale updates.
- Save returned item/component IDs after a write. Components in each saved
  version have separate IDs. Component create/replace responses include the new
  `itemId`; image/description responses return the new item `id`; uploaded
  documents include their new `item_id`.
- Reads by an explicit version ID return that version, not the latest version.
  An explicit job `itemId` pins that revision. Use a SKU to order the current
  default, or refresh `GET /items` before submitting an ID-based job.
- Retrying an identical component upload with its original UUID does not create
  another revision. Keep PDF upload UUIDs stable for retries too.

## Storage

Apply `supabase/item-versions.sql` after `supabase/item-documents.sql`. Existing
items become Version 1 without changing IDs or machining content. Updates copy
the prior version and change only the requested fields inside one transaction.
The old version remains immutable; failed updates cannot change the default.

PDF versions reference the same immutable storage bytes. Removing a PDF from the
current item leaves it available in its earlier versions. Catalogue history is
not physically deleted by ordinary item, component or PDF updates.
