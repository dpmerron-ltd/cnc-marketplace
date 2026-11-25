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
