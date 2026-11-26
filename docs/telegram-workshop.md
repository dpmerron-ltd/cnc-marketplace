# Workshop Telegram bot

The initial release is read-only. Saving a new day plan posts the saved schedule, order summary and whole 1220 × 1220 mm material-square requirements to the configured workshop group. Previewing a plan or ordinary autosaves do not post. If delivery fails, the day plan remains saved; `/today` retrieves it without re-planning.

Commands (append `@tripleeightgroup_bot` in a group with multiple bots):

- `/today`: today's saved plan, with a warning if layouts have since changed.
- `/orders`: live saved component counts by order.
- `/order 1234`: exact order-number lookup, Shopify line items and saved cutting progress. No customer address, email or payment details are sent.
- `/part ID`: identify a physical part, its order, job, sheet and saved sheet status.
- `/scan`: open the native camera QR scanner through a Telegram keyboard Mini App.
- `/help`: command list.

Newly printed part labels contain unique QR codes encoding a Telegram deep link. A phone camera can scan a label and open the bot; press Start if Telegram asks. The full physical instance UUID remains readable underneath. Re-nesting preserves it; a new copy gets a different UUID. The QR is not a component SKU or a sheet-local P001 number. Old exports that only have synthesized sheet-local IDs do not get misleading barcodes. Current workspace data takes precedence over export history. Export-only lookups explicitly distinguish the job/export status from individual part completion.

The initial private-chat allowlist contains Dan's Telegram user ID. Group queries work only in the configured workshop group. The bot checks the webhook secret header before accepting updates. Store `CNC_TELEGRAM_CONFIG` as a Supabase Edge Function secret, never in frontend variables, repository files or logs. Its JSON fields are `token`, `secret`, `chatId`, `userIds`, `ownerId` and `username`. The token comes from BotFather; use a random webhook secret. The account owner is fixed by server configuration, not supplied by Telegram messages.

Webhook endpoint: `/functions/v1/cnc-api/telegram/webhook`. Configure Telegram `setWebhook` with `secret_token` and `allowed_updates: ["message"]`. Keep Telegram privacy mode enabled; direct bot commands and replies work without granting group admin access. `POST /v1/telegram/day-plan` requires the normal authenticated account API session and a `createdAt` timestamp matching the current saved plan. Messages use escaped Telegram HTML for headings, icons and compact monospace tables. Product names and other data cannot inject markup; tables paginate with complete opening/closing tags.

Scanning and queries do not change manufacturing progress, mark orders fulfilled, create a new plan, or run either machine. Per-part completion recording remains deferred. Interactive camera scanning is available through `/scan`; photo upload decoding is not used. Plan completion estimates must never be presented as confirmation of physical cutting.

## Interactive scanner

In the group, `/scan` sends an **Open scanner** deep link into the bot’s private chat. Telegram keyboard Mini Apps are private-chat only. In that chat, tap **Scan part QR**; `part-scanner.html` opens Telegram’s native `showScanQrPopup` on supported iOS/Android clients (Bot API 7.7+, including scanner-close events). Telegram handles camera permission. Unsupported desktop clients can enter the readable UUID manually. The web page does not upload camera images or receive account credentials.

Only recognised part UUIDs or this bot’s QR deep links are accepted. The scanned result is returned with `WebApp.sendData` as a `part_lookup` service message. The webhook rechecks the Telegram sender, private chat and UUID; no client-provided account or status is accepted. Cancelling, denying permission, unrelated codes and duplicate scanner callbacks are handled without changing manufacturing progress.

### Saved sheet tab maps

`/tabs` lists saved CNC exports, newest first, with date, status and a short export ID. Tap an export, then a physical sheet. The bot sends a PDF with the selected sheet overview, highlighted tab spans, part numbers and detailed X/Y position pages. `/tabs EXPORT-UUID SHEET-NUMBER` also works. The sheet number is the original physical sheet number; empty indices are not renumbered.

Maps come from the immutable `cnc_machine_runs.snapshot.map`, scoped to the configured owner, not a newly regenerated workspace layout. Match the export and NC file to the physical sheet; later edits require a new export. Source/inference warnings are preserved. The PDF links to that saved export's interactive sheet view. No cutting state or NC is changed.

The webhook must enable `message` and `callback_query` updates. Buttons use the same fixed workshop-group/allowed-private-user access rules as commands. Old or deleted exports and missing sheets fail explicitly rather than guessing another layout.

### Daily-plan machining and packing

Fresh daily plans disable sheet workholding screw marks and use 1.9x the roughing feed on explicitly identified level finishing moves. Ramps, drilling, tab lifts and geometry retain their existing settings. Unclassified imported NC without an identified finish keeps its original feeds; known non-6-mm source programs require regeneration. Completed sheets retain their original settings; waiting work is separated before applying new settings. Existing exports are not rewritten and changed waiting settings require a fresh export.

When an order administrator marks a sheet cut in Cutting Jobs and the cloud save succeeds, the app checks the order's readiness through `/v1/shopify/packing-sync`. The server reads saved progress, verifies current exported-sheet signatures, all required component identities and quantities against the live order and published catalogue, and adds only `Ready to pack` with Shopify `tagsAdd`. Unknown SKUs, missing components, edited orders, pending parts and incomplete sheets cannot qualify. Historical component revisions requiring reconciliation are reported for review. Shipping and payment statuses are unchanged.

The Shopify app needs `write_orders`. Failures preserve cutting progress and show a retry button. The bot scanner remains read-only; scanning a label does not confirm cutting. A packing tag records readiness at the time of confirmation; later order edits or recut requests need packing review.

The workshop menu uses inline buttons for Today's cuts, Orders, Find order, Tab maps and Scan a part. Buttons use authenticated callback updates with the same group/private-user restrictions. Find order prompts for a reply containing the order number; arbitrary group messages are not interpreted as lookups. Existing slash commands remain available.

## Packing and failure scans

The menu includes **Pending packing**, **Scan cut part**, and **Scan failed part**. Pending packing reads open Shopify orders tagged `Ready to pack`, excludes fulfilled orders and unresolved failed parts, and pages oldest first.

Cut and failed scans are restricted to configured workshop operator IDs. The camera opens in the bot's private chat. Each mode is explicitly labelled; older lookup links remain read-only. Cut scans save individual physical IDs against the exported layout, lock partially confirmed sheets, and mark the sheet cut when all its parts have been recorded. Saved workspace version checks prevent concurrent scans and stale browser saves from overwriting each other. Reload an already-open site after scanning.

Once the complete current order BOM is verified, the bot adds `Ready to pack` and posts **PACK ORDER #…** to the workshop group. A saved per-order alert claim suppresses repeat-scan alerts. A delivery error clears the claim for a retry; a process crash after claiming but before delivery can require manual alert recovery.

Failed scans queue the exact saved export/part in the existing Re-cut queue, remove packing readiness, and exclude the failed physical ID from usable quantities. Add the queued replacement to a cutting job in the site; it receives a new QR identity. Confirm that replacement after cutting. The failed original label cannot complete the replacement. Failures of replacements can themselves be queued. No shipment or Shopify fulfillment is created by scans.

## Continuous scanner

Use the latest private-chat **Scan cut QR** or **Scan failed QR** inline button. The Mini App keeps its own rear-camera preview open, decodes QR frames locally, and posts only the part ID/mode with Telegram's signed `initData` to `/telegram/scan`. Camera images never leave the device. The server verifies the HMAC, a 12-hour session age, and the configured operator ID before reading or changing progress. Old keyboard launches lack this signed session and ask the operator to reopen from the latest button.

A green tick and haptic feedback appear only after the server acknowledges the scan; amber indicates saved progress with a packing warning; red indicates no successful acknowledgement. The next different part scans automatically after a brief confirmation interval. A held QR is suppressed until removed or replaced. No `sendData` or app close call is used. Camera access may need initial device permission; if unavailable, manual ID entry remains available. The camera stops when the app is hidden or closed.
