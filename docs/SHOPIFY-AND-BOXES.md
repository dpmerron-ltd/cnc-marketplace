# Shopify Orders and Shared Box Stock

## Orders

The Orders page displays order numbers, ordered items (SKU, variant and
quantities), assignments and agreed cutting payments. Shopify prices, totals, customer identities and addresses are not requested
from Shopify or returned to the browser. Orders are fetched on page opening or
refresh, not copied into the CNC database. There are no Shopify mutations,
webhooks, automatic CNC jobs or stock deductions. Only the order ID/name,
assignment and cutting payment are stored locally, with an assignment audit history.

`dan@dpmerron.co.uk` is the order administrator. `supabase/orders.sql` pins that
existing account's UUID on first installation; later profile/email changes do not
grant anyone admin rights. Dan sees all accessible store orders, can assign,
reassign or unassign an order, and sets a fixed GBP cutting payment for the whole
order. This is a record of agreed compensation only: no money is transferred and
it is not a Shopify order value or a paid/unpaid ledger.

Other users see only orders assigned to their authenticated account and their
agreed fee. They cannot list users, change fees or fetch another order by ID.
The API checks assignments before details and again after Shopify responds.
Reassignment/unassignment revokes access on subsequent reads; it cannot retract
data already downloaded. Catalogue items, components, sheets and jobs remain
private: assignment does not copy Dan's components into the cutter's catalogue.

Each order has an **Add to sheet** action. It fetches every line-item page, matches
SKUs against the current user's catalogue (trimmed and case-insensitive), and asks
the operator to confirm the item selection. Missing or duplicate SKUs require an
explicit selection; nothing is written back to Shopify. Each current order unit
adds one copy of every component in the chosen catalogue item. Removed/refunded
quantities are excluded; fulfilled units still count if present in the current
order quantity. No line is silently skipped for a missing match or empty item.

The current sheet's dimensions, spacing and material profile apply. Existing
placements are preserved; additions nest from the active sheet onward, spilling
onto further sheets as necessary. Nesting runs in a cancellable worker with a
30-second timeout and a 500-new-component limit. Errors, missing thickness
variants, cancellation or account/catalogue/sheet changes leave the sheet unchanged.
The order number is appended to the sheet for labels. Saved order/instance references
prevent adding the same order twice to that project while its components remain.
This is not a global fulfilment lock: a separate project can contain the same order.

Account API keys and MFA sessions can use:

- `GET /v1/shopify/connection`: current account ID, `isOrderAdmin`, connection
  status and the administrator's store domain. No credentials are returned.
- `GET /v1/shopify/orders?status=open&search=%231001&after=CURSOR`: 25 orders per
  page, newest first, with five item lines per order. Status accepts `all`, `open`,
  `unfulfilled` (including partial), `fulfilled`, `cancelled`. This is the admin
  list; the UI defaults to `all`. Workers use `status=all` (or omit it), optional
  order-number search and the returned cursor. Their list is paginated from stored
  assignments and hydrates only those IDs using Shopify's [nodes query](https://shopify.dev/docs/api/admin-graphql/latest/queries/nodes).
- `GET /v1/shopify/orders/{numericOrderId}?after=CURSOR`: up to 100 item lines.
  Follow `order.lineItems.pageInfo` until complete; never silently truncate a kit.
- `GET /v1/shopify/users?offset=0`: admin only; `{users: [{id, email}], nextOffset}`.
  Follow `nextOffset` until null (100 users per page).
- `PATCH /v1/shopify/orders/{numericOrderId}/assignment`: admin only. Example:
  `{ "assigneeId": "<user UUID>", "paymentPence": 4500, "expectedVersion": 0 }`.
  This assigns a GBP 45.00 cutting fee. Amounts are integer pence, 0-100000000.
  Both assignee and payment must be supplied; use both `null` to unassign.
  Use the order's `assignment.version`, or 0 for a never-assigned order. Conflicts
  return 409: reload and review rather than blindly overwriting. Unassignment
  retains the revision and audit history. Each order response includes its
  `assignment` or null. Workers never receive other users' email addresses.

The pinned administrator selects the store server-side. Client owner/shop
parameters are rejected. Responses use `Cache-Control: no-store`. Expiring tokens
are cached and renewed. Shopify errors do not expose raw upstream payloads.
GraphQL API version is pinned to `2026-07`.

Configure the backend-only Supabase secret `CNC_SHOPIFY_CONNECTIONS` as a JSON array
with an entry for Dan's pinned CNC account:

```json
[
  {
    "ownerId": "<CNC account UUID>",
    "shop": "<store>.myshopify.com",
    "clientId": "<Shopify app client ID>",
    "clientSecret": "<Shopify app client secret>"
  }
]
```

Use a protected temporary env file with `supabase secrets set --env-file ...`.
Never put credentials in `VITE_*`, source control, logs or browser storage.
Preserve other entries when adding connections. An empty array means no stores.
Invalid configuration fails closed for Shopify routes without disabling CNC routes.
Removing Dan's entry disconnects order access for everyone; another user's
connection does not bypass assignment checks.

The app must be installed on its own organisation's store and have `read_orders`.
The normal order-history window is 60 days; older records require Shopify's
`read_all_orders` approval. This feature does not change app permissions.
See [client-credentials authentication](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)
and [order access](https://shopify.dev/docs/api/admin-graphql/latest/objects/Order).

## Shared Inventory

Box stock is one **shared workshop inventory for all authenticated CNC users**.
Catalogue components, sheets and jobs remain account-private. Order visibility
is controlled separately by administrator/assignment, not by box access.
Initial shared stock is ten each of 1050 x 350 x 400 mm and 1200 x 350 x 400 mm,
internal dimensions, 0201 single-wall plain brown kraft without hand holes.
Repeated schema deployments do not reset existing counts or create per-user copies.

- `GET /v1/boxes`: shared sizes/counts with revision `version`.
- `POST /v1/boxes`: stable UUID `id`, `name`, `length_mm`, `width_mm`, `height_mm`,
  `quantity`, optional `details`. Dimensions are integer mm, 10-1200; quantity is
  0-100000. Duplicate IDs/sizes return 409, not an overwrite.
- `PATCH /v1/boxes/{id}`: `{ "quantity": 9, "expectedVersion": 1 }`. The count is
  replaced atomically at the expected revision; a stale count returns 409. Refresh
  and review instead of blindly retrying. The acting user is recorded server-side.

All writes require the authenticated API. Direct browser table writes and anonymous
reads are denied. Counts are manual: update when cartons are received or used.
Estimates neither reserve cartons nor allocate inventory across all catalogue items.

## Packing

Items and Boxes calculate against shared stock sizes. Zero-stock sizes remain
eligible with a replenishment warning. The objective is a complete single carton
first, then fewer stock shortages, then lower volume. If no tested single carton
fits, two-carton layouts are tried. Otherwise a compact new single-carton size is
suggested, not counted as available inventory. Suggestions also identify at least
25% potential volume reduction versus an existing single carton. No purchases occur.

`maxrects-packer` handles rotated rectangular placement within layers, trying area,
longest-edge and thickness orderings. Panels can share a layer or stack; the old
five-component cap no longer applies to these estimates. Both normal and side-laid
carton orientations are tested. Diagrams distinguish stock size from packing
orientation. Layer height is its thickest panel; thinner parts need supporting inserts.

Defaults remain 10 mm padding on each side, 2 mm separation and 5 mm estimated
carton wall thickness. Padding is subtracted from internal space; wall thickness
is not subtracted again. A 120 cm internal carton may exceed 120 cm externally:
check the carrier's actual limits. Suggested dimensions round up to 10 mm.
Calculations support 60 components and 50 box sizes, run bounded heuristics in a
worker, and are not a guarantee of a globally optimal layout.

Measurements use toolpath bounding rectangles and material hints (18 mm assumed
when absent). Confirm finished dimensions, detached parts, stock thickness,
hardware, shipping weight and carton strength with a trial pack before ordering.
Packing calculations never alter machining programs.
