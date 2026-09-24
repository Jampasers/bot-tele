# Email OTP Rental

Email OTP Rental adds a tenant-scoped email rental catalog at `/email` and an admin workflow at `/emailadmin`. It reuses the bot's Mongoose tenant plugin, balance ledger, QRIS settlement claim, AES-256-GCM encryption, Cloudflare Email Routing client, and activity log. The legacy IMAP forwarder and `/cf` commands remain available.

## Enable safely

1. Back up MongoDB and keep all bot processes stopped while adding indexes.
2. Set `CREDENTIAL_ENCRYPTION_KEY` to a durable 32-byte key (64 hex characters or base64). Use the key already used by other encrypted tenant features; rotating it without a migration makes stored credentials unreadable.
3. Leave `EMAIL_RENTAL_ENABLED=false` while installing indexes. Run `npm run migrate:email-rental` and inspect the read-only report, then run `npm run migrate:email-rental -- --apply`.
4. Start the bot with `EMAIL_RENTAL_ENABLED=true`. Tenant plans must include `email_otp` in their enabled features. The platform admin can use `/emailadmin` while the feature is disabled.
5. Configure at least one IMAP provider, mailbox, OTP service, and a service/provider price. The user catalog only displays combinations with live stock and an enabled price.

The migration is idempotent, defaults to dry run, does not copy legacy IMAP credentials, and verifies the compound tenant/resource/service usage index before checkout. Existing IMAP settings are left untouched.

## Admin setup example

In a private chat as a configured admin:

1. `/emailadmin` → **Provider** → add `GMAIL|Gmail|📮|imap.gmail.com|993|true|APP_PASSWORD`.
2. **Mailbox** → choose Gmail → send one or more rows in a private message: `gmail01@example.com|app-password`. The bot deletes that message before testing or saving. If Telegram cannot delete it, the bot cancels the operation. The confirmation never echoes the secret.
3. **OTP Service** → add a service, for example `DISCORD|Discord|🎮|20|5|discord\\.com|verification|\\b(code|otp)\\D{0,8}(\\d{4,8})|false|true`. Sender, subject, and OTP fields accept semicolon-separated JavaScript regular expressions. At least one sender or subject matcher is required.
4. **Harga** → set `DISCORD|MAILBOX|GMAIL|2000`.

For domain aliases, first configure Cloudflare using `/cf` and verify the desired zone appears in `/cf`. Add a collector mailbox and then add the domain from **Domain** using `domain|zoneId|collectorEmail|true`. Add a `DOMAIN_ALIAS` price for each service. Aliases are random, tenant-unique, routed through the existing Cloudflare client, retired permanently after use, and their rule is deleted after the configured grace period.

Admin settings use `maxConcurrentEmailRentalsPerUser|reservationMinutes|messageGraceMinutes|aliasGraceMinutes|maxConcurrentConnections|pollIntervalSeconds`. Defaults are 3 concurrent rentals, 10-minute reservations, 5-minute late-message grace, 15-minute Cloudflare cleanup grace, 5 worker connections, and 15-second polling.

## Lifecycle and safety

- A compare-and-set mailbox reservation prevents two checkouts from claiming one mailbox. Expired unpaid reservations return to `AVAILABLE` and do not create `EmailUsage`.
- Balance debit, payment effect, permanent `EmailUsage`, resource activation, and rental activation share a MongoDB transaction. MongoDB must support transactions (replica set or sharded cluster).
- QRIS reuses the existing merchant settlement scan, amount reservation, and settlement claim. Settlement is idempotent; post-payment provisioning failure is credited to the user's bot balance once, with a matching balance log.
- `EmailUsage` has a unique tenant + normalized email address + service index and is permanent, even if an inventory mailbox document is later replaced. A used mailbox can serve a different service after cooldown, but never the same service again.
- Mailbox secrets use purpose-bound AES-GCM (`email-mailbox:<mailboxId>:credential`) and are excluded from normal Mongoose projections. Email messages persist parsed OTP/link and a short text preview only for up to 30 days; no raw MIME or attachment is stored.
- IMAP polling runs inside each tenant bot's lifecycle with bounded concurrent connections, backoff, and active-rental priority. Polling reads cached `EmailMessage` documents on user refresh; it does not open an IMAP connection for each button press.
- Inbound dispatch requires the current resource, service sender/subject matcher, post-start receive time, message UID boundary (for direct mailboxes), and rental/grace time. The worker keeps recently expired resources in its bounded polling pool for the configured late-message grace; alias cleanup waits through that grace plus one poll interval. Dedup keys prevent repeat Telegram delivery. Renter inbox queries always include both rental ID and Telegram user ID.

## Commands and models

Users: `/email`, `/emailrent`, `/myemail`. Admin: `/emailadmin`.

Tenant models: `EmailProvider`, `EmailMailbox`, `EmailOtpService`, `EmailUsage`, `EmailRental`, `EmailRentalPrice`, `EmailMessage`, `EmailDomain`, `EmailDomainAlias`, `EmailRentalCounter`, `EmailPaymentEffect`, `EmailRentalSettings`, and `EmailRentalRenewal`.

`EmailInboundSource` is the shared ingestion seam for IMAP and a future signed Worker webhook. Cloudflare Worker webhook ingestion is not enabled by this release; aliases currently use Cloudflare Email Routing to a collector mailbox and generic IMAP polling. IMAP uses bounded polling instead of one persistent IDLE socket per account, which keeps account connections bounded at the cost of the configured polling delay.
