# AGENTS.md — Developer & AI Agent Guide for grammY Plugin Bot

> **Note for AI Agents & Developers**: This document serves as the comprehensive architectural and operational guide for the `grammY Plugin Bot` codebase. When reading, extending, debugging, or modifying this repository, follow the patterns, contracts, and best practices documented below.

---

## 1. Project Overview & Architecture

`grammY Plugin Bot` is a modular, production-ready Telegram Bot built with **TypeScript (Node.js ESM)** and **grammY**. It follows a **zero-config dynamic plugin architecture** that auto-discovers and registers features at boot time without manual wiring.

### Core Capabilities
- 🔌 **Dynamic Plugin Loader**: Auto-scans `src/plugins/`, validates runtime contracts, and registers Telegram bot commands and handlers automatically.
- 📬 **IMAP Email OTP Forwarder**: Real-time listener (`src/services/imapOtp.ts`) powered by **ImapFlow** and **MailParser** to capture incoming OTP emails (e.g. PayPal), extract recipient name & OTP code, and automatically forward to a dedicated Telegram channel configured by Admin.
- 📱 **Virtual SMS OTP Verification**: Integrated with the **SMSBower API** (`src/services/smsbower.ts`) to rent phone numbers, wait for incoming SMS/OTP codes, handle cancellations, and auto-refund.
- 📦 **Digital Store & Stock Management**: Built-in digital catalog system (`src/services/digitalProduct.ts`) with category filtering, automated stock dispensing (FIFO), and batch stock injection for administrators.
- 💳 **GoPay / GoBiz QRIS Payment Engine**: Dynamic QRIS image & payload generator (`src/services/payment/`) with unique fractional IDR amounts (1–1000) for transaction deduplication, combined with real-time settlement polling.
- 📢 **Channel Force Subscription**: Built-in channel gating middleware (`src/middlewares/forceSub.ts`) ensuring users join required Telegram channels before using bot features, with inline membership re-verification.
- 🧾 **Modern Receipt & Testimonial Dispatch**: Automatically renders high-resolution receipt PNG cards via headless Puppeteer (`src/services/receipt.ts`) and broadcasts transaction proofs with masked user info to a dedicated Telegram channel (`src/services/testimonial.ts`).
- 🗄️ **Automated Backup & Interactive Rollback**: Full MongoDB database export/import engine (`src/services/backup.ts`) supporting all 12 collections with automated daily backups at 00:00 WIB, on-demand admin exports, ZIP file inspection, auto-safety backups, and safe database rollbacks.
- 🛡️ **Graceful Lifecycle & Error Resilience**: Clean startup/shutdown sequence with MongoDB connection management and suppression of transient Telegram network dropouts.

---

## 2. Directory Structure

```
.
├── src/
│   ├── index.ts                  # Application entry point & bootstrap lifecycle
│   ├── core/
│   │   ├── bot.ts                # grammY bot factory, global error handler & middleware setup
│   │   ├── db.ts                 # Mongoose connection & disconnect lifecycle management
│   │   └── pluginLoader.ts       # Dynamic plugin scanner, validator & setMyCommands sync
│   ├── middlewares/
│   │   └── forceSub.ts           # Channel membership verification & gating middleware
│   ├── models/                   # Mongoose Schemas & TypeScript interfaces
│   │   ├── BotConfig.ts          # Singleton: ForceSub, Testimonial, Log & OTP channel configuration
│   │   ├── DigitalOrder.ts       # Completed digital product order records
│   │   ├── DigitalProduct.ts     # Digital store product items & categories
│   │   ├── DigitalStock.ts       # Digital item stock inventory (FIFO delivery)
│   │   ├── Order.ts              # SMS OTP rental orders and states
│   │   ├── SmsConfig.ts          # Singleton: OTP service toggle, country/service whitelist & markup
│   │   ├── TopupSession.ts       # QRIS payment invoices & settlement tracking (TTL: 2h)
│   │   └── User.ts               # Telegram user profiles & balance tracking
│   ├── plugins/                  # Self-contained feature modules (auto-loaded)
│   │   ├── admin/                # Master admin panel (OTP settings, ForceSub, Testimonial, OTP Channel)
│   │   ├── digiadmin/            # Admin panel for digital products, categories & stock
│   │   ├── digital/              # User-facing digital store & checkout flows
│   │   ├── info/                 # /info command describing bot architecture
│   │   ├── panel/                # User main menu (/start, Reply Keyboard, balance, top-up)
│   │   ├── ping/                 # /ping health check command
│   │   ├── register/             # /register command for explicit user account creation
│   │   └── smsbower/             # User-facing SMS OTP number rental & polling flow
│   ├── services/                 # Business logic & external API integrations
│   │   ├── activityLog.ts        # Channel audit logging service for user registrations & transactions
│   │   ├── backup.ts             # Automated backup scheduler, zip exporter, inspector & rollback engine
│   │   ├── digitalProduct.ts     # Digital store catalog, stock management & transactions
│   │   ├── forceSub.ts           # Channel membership check & prompt builders
│   │   ├── imapOtp.ts            # IMAP real-time listener & OTP forwarder to Telegram channel
│   │   ├── receipt.ts            # Puppeteer HTML-to-image receipt generator
│   │   ├── smsbower.ts           # SMSBower API client & in-memory cache manager
│   │   ├── stats.ts              # Aggregated bot statistics & multi-metric performance analytics
│   │   ├── testimonial.ts        # Channel broadcast service for transaction proofs
│   │   └── payment/              # GoPay / GoBiz merchant & QRIS engine
│   │       ├── gobiz-auth.ts     # GoBiz OAuth authentication & token refresh
│   │       ├── gopay-merchant.ts # GoPay merchant settlement querying
│   │       ├── index.ts          # Payment service facade & exports
│   │       ├── paymentService.ts # Unified QRIS generation & session settlement checker
│   │       ├── qr-reader.ts      # QR image decoder (jsQR / Canvas fallback)
│   │       ├── qris-watcher.ts   # QRIS settlement polling watcher
│   │       ├── qris.ts           # Dynamic QRIS string & QR code generator
│   │       └── types.ts          # Payment transaction types & DTOs
│   └── types/
│       └── Plugin.ts             # Plugin interface & PluginCommand type definitions
├── .env.example                  # Environment variable blueprint
├── package.json                  # Dependencies, scripts & ESM configuration
├── tsconfig.json                 # TypeScript compiler configuration (ESM / NodeNext)
└── README.md                     # General user documentation
```

---

## 3. Application Lifecycle & Startup Sequence

The bootstrap process in [`src/index.ts`](src/index.ts) executes deterministically:

```
[1] Validate Required ENV (BOT_TOKEN, MONGODB_URI)
 └── [2] connectDatabase() (MongoDB connection pool established)
      └── [3] SMSBowerService.loadData() (Pre-fetch countries & services into memory)
           └── [4] createBot(BOT_TOKEN)
                ├── Attach global error handler & benign callback handler
                ├── bot.use(forceSubMiddleware)
                └── loadPlugins(bot)
                     ├── Scan src/plugins/
                     ├── Import plugin entry files (index.ts / index.js)
                     ├── Validate isPlugin() contract
                     ├── plugin.register(bot)
                     └── bot.api.setMyCommands(collectedCommands)
           └── [5] bot.start() (Begin Telegram long polling)
```

### Shutdown & Error Handling Rules
- **Graceful Shutdown**: On `SIGINT` or `SIGTERM`, polling is stopped via `bot.stop()`, then pending DB queries are flushed with `disconnectDatabase()`.
- **Transient Network Errors**: Errors containing `stream reading error`, `connection was aborted`, `ECONNRESET`, or `ETIMEDOUT` are caught and logged as warnings; grammY auto-reconnects without terminating the process.
- **Old Callback Queries**: The API transform in [`src/core/bot.ts`](src/core/bot.ts) intercepts `query is too old` on `answerCallbackQuery` to avoid breaking handler execution when Telegram timeouts expire.

---

## 4. Plugin System & Contract (`src/types/Plugin.ts`)

Every feature module inside `src/plugins/<feature-name>/` must default-export an object conforming to the `Plugin` interface:

```typescript
export interface PluginCommand {
  command: string;      // 1-32 chars, lowercase alphanumeric + underscores
  description: string;  // 1-256 chars shown in Telegram command menu
}

export interface Plugin {
  name: string;                                   // Unique plugin identifier
  version: string;                                // SemVer string (e.g. "1.0.0")
  commands?: readonly PluginCommand[];            // Optional commands declared to Telegram
  register: (bot: Bot<Context>) => void | Promise<void>; // Attaches commands, hears & callback handlers
}
```

### Adding a New Plugin
1. Create a folder: `src/plugins/<my-plugin>/`
2. Create `src/plugins/<my-plugin>/index.ts`:
   ```typescript
   import { Bot, Context } from "grammy";
   import { Plugin } from "../../types/Plugin.js";

   const myPlugin: Plugin = {
     name: "my-plugin",
     version: "1.0.0",
     commands: [
       { command: "mycommand", description: "Sample command description" },
     ],
     register(bot: Bot<Context>): void {
       bot.command("mycommand", async (ctx) => {
         await ctx.reply("Command executed successfully!");
       });
     },
   };

   export default myPlugin;
   ```
3. Restart the bot (`npm run dev`). The loader dynamically discovers it, registers its handlers, and syncs its commands to Telegram's UI menu.

### Disabling a Plugin
To disable a plugin without deleting files, rename its folder with the `archived_` prefix (e.g. `src/plugins/archived_my-plugin/`). The loader explicitly skips folders starting with `archived_`.

---

## 5. Plugin Functionality Breakdown

| Plugin | Entry & Triggers | Target Users | Key Responsibilities |
|---|---|---|---|
| **`panel`** | `/start`, `/menu`, `/help`, Reply Keyboard | All Users | Home dashboard, user registration on arrival, balance display, interactive Top-Up flow via dynamic QRIS. |
| **`digital`** | `product_digital`, `dgp_*` callbacks | All Users | Catalog category browser, product selection, balance/QRIS purchase checkout, instant stock delivery, receipt generation, and testimonial dispatch. |
| **`smsbower`** | `product_otp`, `/carinegara`, `/carilayanan`, `ctry_*`, `srv_*`, `buy_*` callbacks | All Users | Interactive virtual phone number rental for SMS verification, interactive Country & Service search with pagination, real-time OTP status polling (10s interval, 10 min max), refund on cancellation/timeout. |
| **`admin`** | `/admin`, `/stats`, `/statistik`, `/cekharga`, `/hargasms`, `/backup`, `/rollback`, `/restore`, `/cf`, `/cfcreate`, `/cflist`, `/cfdel`, `/cfzones`, `adm_*` callbacks | Admin (`ADMIN_ID`) | Master control for Bot Analytics/Stats, OTP toggle, country & service whitelists, realtime SMSBower price & currency inspector (USD/IDR), price markup settings, Force-Subscription setup, Testimonial/Log channels, Cloudflare Email Routing manager, and Database Backup & Safe Rollback. Multi-admin supported. |
| **`digiadmin`**| `dga_*` callbacks | Admin (`ADMIN_ID`) | Digital store manager: Add/edit/delete products, toggle active status, bulk stock injection (`dga_stock`), and revenue/sales metrics. Multi-admin supported. |
| **`register`** | `/register` | All Users | Direct account registration fallback. |
| **`id`** | `/id`, `/getid`, `/myid`, Forward message | All Users | Telegram ID inspector for user, chat, channel, thread/topic, replied message, forwarded message origin, and media file IDs. |
| **`info`** | `/info` | All Users | Provides bot architecture and plugin system info. |
| **`ping`** | `/ping` | All Users | Health-check command returning "🏓 Pong!". |

---

## 6. Database Models (`src/models/`)

All database interactions use **Mongoose 9.x** with a single persistent connection established at startup.

### 1. `User` (`src/models/User.ts`)
- **Collection**: `users`
- **Purpose**: Stores registered Telegram users, balance, and lifetime order counts.
- **Key Fields**: `telegramId` (String, Unique), `firstName`, `username` (optional), `balance` (Number, default 0, min 0), `totalOrders` (Number, default 0).

### 2. `DigitalProduct` (`src/models/DigitalProduct.ts`)
- **Collection**: `digitalproducts`
- **Purpose**: Catalog items available in the digital store.
- **Key Fields**: `name`, `category` (indexed), `description`, `deliveryMessage`, `price` (IDR), `isActive` (Boolean). Compound index on `{ category: 1, isActive: 1 }`.

### 3. `DigitalStock` (`src/models/DigitalStock.ts`)
- **Collection**: `digitalstocks`
- **Purpose**: Individual inventory items (credentials, license keys, vouchers) sold on a FIFO basis.
- **Key Fields**: `productId` (ObjectId -> DigitalProduct), `content` (String), `isSold` (Boolean), `soldTo` (Telegram ID), `soldAt` (Date), `orderId` (String). Compound index on `{ productId: 1, isSold: 1, createdAt: 1 }`.

### 4. `DigitalOrder` (`src/models/DigitalOrder.ts`)
- **Collection**: `digitalorders`
- **Purpose**: Audit record for fulfilled digital product purchases.
- **Key Fields**: `orderId` (Unique), `userId`, `productId`, `productName`, `quantity`, `price`, `itemContent`, `deliveryMessage`, `createdAt`.

### 5. `Order` (`src/models/Order.ts`)
- **Collection**: `orders`
- **Purpose**: Tracks SMS OTP rental transactions with SMSBower.
- **Key Fields**: `userId`, `activationId` (Unique), `service`, `country`, `phoneNumber`, `cost`, `status` (`PENDING` | `COMPLETED` | `CANCELED`), `code` (received OTP), `createdAt`.

### 6. `TopupSession` (`src/models/TopupSession.ts`)
- **Collection**: `topupsessions`
- **Purpose**: Dynamic QRIS payment invoices generated for top-ups or direct purchases.
- **Key Fields**: `telegramId`, `chatId`, `messageId`, `orderId` (Unique), `baseAmount`, `uniqueCode` (1–1000 offset), `amountIDR`, `pendingProductType` (`"SMS"` | `"DIGITAL"`), `pendingServiceCode`, `pendingDigitalProductId`, `status` (`PENDING` | `SETTLED` | `EXPIRED` | `CANCELLED`).
- **TTL Index**: Auto-expires documents after 2 hours (`expires: 7200`).

### 7. `SmsConfig` (`src/models/SmsConfig.ts`)
- **Collection**: `smsconfigs` (Singleton accessed via `SmsConfig.getOrCreate()`)
- **Purpose**: Configuration for SMS OTP service availability, whitelists, and pricing markups.
- **Key Fields**: `enabled` (Boolean), `allowedCountries` (`string[]`), `allowedServices` (`string[]`), `markupType` (`"fixed"` | `"percentage"`), `markupValue` (Number).

### 8. `BotConfig` (`src/models/BotConfig.ts`)
- **Collection**: `botconfigs` (Singleton accessed via `BotConfig.getOrCreate()`)
- **Purpose**: Runtime configuration for Force Subscription, Testimonial broadcasting, Activity Log, and IMAP OTP Forwarder channels.
- **Key Fields**: `forceSubEnabled`, `forceSubChannel`, `forceSubLink`, `forceSubName`, `testimonialEnabled`, `testimonialChannel`, `testimonialLink`, `logChannelEnabled`, `logChannel`, `logChannelLink`, `otpChannelEnabled`, `otpChannel`, `otpChannelLink`, `otpNetflixChannelEnabled`, `otpNetflixChannel`, `otpNetflixChannelLink`, `imapEnabled`, `imapHost`, `imapPort`, `imapSecure`, `imapUser`, `imapPass`, `imapMailbox`, `imapTargetSender`.

### 9. `WarrantyClaim` (`src/models/WarrantyClaim.ts`)
- **Collection**: `warrantyclaims`
- **Purpose**: Digital product warranty claims, tickets, buyer complaints, and admin resolution decisions.
- **Key Fields**: `claimId` (Unique), `orderId`, `userId`, `userHandle`, `productId`, `productName`, `itemContentSnapshot`, `reason`, `status` (`PENDING` | `APPROVED_REPLACE` | `APPROVED_REFUND` | `REJECTED`), `adminNote`, `replacementContent`, `refundAmount`, `resolvedBy`, `resolvedAt`, `createdAt`.

---

## 7. Payment & QRIS Processing Workflow

```
User selects "Topup" or "Beli via QRIS"
  ├── [1] Calculate Unique Amount via getUniquePaymentAmount(baseAmount)
  │         ↳ Finds lowest unused integer code (1-1000) for baseAmount to prevent collisions
  ├── [2] Generate Dynamic QRIS via generateQris(totalAmount)
  │         ↳ Uses static QRIS payload/image and injects dynamic transaction amount
  ├── [3] Create TopupSession record (status: PENDING)
  │         ↳ Dispatch Activity Log: Topup invoice created
  ├── [4] Send QRIS image + countdown invoice to user
  └── [5] Poll checkSessionSettlement(session) every 10 seconds
            ├── Query GoPay Merchant API settlements within 2-min window
            ├── Verify status === "SETTLEMENT" && amount === session.amountIDR
            ├── Ensure matchedTransactionId is not already claimed
            └── On match:
                  ├── Mark session SETTLED & credit user balance (or execute pending purchase)
                  ├── Dispatch Activity Log: Topup settled / purchase completed
                  ├── Generate receipt image (Puppeteer)
                  └── Dispatch testimonial to channel
```

---

## 8. Development Environment & Configuration

### Required Environment Variables (`.env`)

| Variable | Required | Description | Example / Default |
|---|---|---|---|
| `BOT_TOKEN` | **Yes** | Telegram Bot API token from [@BotFather](https://t.me/BotFather) | `123456:ABC-DEF...` |
| `MONGODB_URI` | **Yes** | MongoDB connection URI | `mongodb://localhost:27017/grammy-bot` |
| `DATABASE_NAME` | No | Database name override | `telegram-danka` |
| `ADMIN_ID` | **Yes** | Numeric Telegram ID(s) of bot administrator(s). Supports comma/space separated multi-admin. | `123456789,987654321` |
| `CF_EMAIL` | Optional | Account email for Cloudflare Email Routing API | `admin@example.com` |
| `CF_GLOBAL_API_KEY` / `CF_API_KEY` | Optional | Global API Key or API Token for Cloudflare API | `your_api_key_or_token` |
| `CF_DEST_EMAIL` | Optional | Default forward destination email for Cloudflare routing | `forward_to@example.com` |
| `SMSBOWER_API_KEY`| Optional | API key for [SMSBower](https://smsbower.page/) | `your_api_key_here` |
| `OTP_ENABLED` | No | Enable/disable OTP SMS features globally | `true` |
| `FORCE_SUB_CHANNEL`| Optional | Username or ID of required channel (e.g. `@channel`) | `@mychannel` |
| `FORCE_SUB_LINK` | Optional | Invite link for the required channel | `https://t.me/mychannel` |
| `FORCE_SUB_NAME` | No | Display name of the required channel | `Official Channel` |
| `FORCE_SUB_ENABLED`| No | Enable/disable force subscription check | `true` |
| `TESTIMONIAL_CHANNEL`| Optional | Channel for automated purchase proofs & receipts | `@mytestichannel` |
| `TESTIMONIAL_LINK` | Optional | Public link to testimonial channel | `https://t.me/mytestichannel` |
| `TESTIMONIAL_ENABLED`| No | Enable/disable testimonial broadcasting | `true` |
| `LOG_CHANNEL` | Optional | Channel for automated real-time audit & activity logs | `@myactivitylog` |
| `LOG_CHANNEL_LINK` | Optional | Public link to activity log channel | `https://t.me/myactivitylog` |
| `LOG_CHANNEL_ENABLED`| No | Enable/disable audit logging to channel | `true` |
| `OTP_PAYPAL_CHANNEL` / `OTP_CHANNEL` | Optional | Channel for automatic PayPal OTP forwarding | `@mypaypalchannel` |
| `OTP_PAYPAL_CHANNEL_LINK` | Optional | Public link to PayPal OTP forwarder channel | `https://t.me/mypaypalchannel` |
| `OTP_PAYPAL_CHANNEL_ENABLED` | No | Enable/disable PayPal OTP forwarding to channel | `true` |
| `OTP_NETFLIX_CHANNEL` | Optional | Channel for automatic Netflix OTP forwarding | `@mynetflixchannel` |
| `OTP_NETFLIX_CHANNEL_LINK` | Optional | Public link to Netflix OTP forwarder channel | `https://t.me/mynetflixchannel` |
| `OTP_NETFLIX_CHANNEL_ENABLED` | No | Enable/disable Netflix OTP forwarding to channel | `true` |
| `OTP_DISCORD_CHANNEL` | Optional | Channel for automatic Discord OTP forwarding | `@mydiscordchannel` |
| `OTP_DISCORD_CHANNEL_LINK` | Optional | Public link to Discord OTP forwarder channel | `https://t.me/mydiscordchannel` |
| `OTP_DISCORD_CHANNEL_ENABLED` | No | Enable/disable Discord OTP forwarding to channel | `true` |
| `IMAP_HOST` | Optional | IMAP host server (e.g. `imap.gmail.com`) | `imap.gmail.com` |
| `IMAP_PORT` | Optional | IMAP port (e.g. `993` for SSL) | `993` |
| `IMAP_SECURE` | No | Use SSL/TLS encryption | `true` |
| `IMAP_USER` | Optional | Email username for IMAP authentication | `your_email@gmail.com` |
| `IMAP_PASS` | Optional | Email password or 16-digit App Password | `abcd1234efgh5678` |
| `IMAP_MAILBOX` | No | Mailbox folder to monitor | `INBOX` |
| `IMAP_TARGET_SENDER` | No | Filter incoming emails by sender address | `service@intl.paypal.com` |
| `IMAP_ENABLED` | No | Enable/disable IMAP background listener | `true` |
| `QRIS_STATIC_PAYLOAD`| Optional | Raw static QRIS string payload | `000201010211...` |
| `QRIS_IMAGE_PATH`| No | Path to static QRIS base image | `./qris-static.png` |
| `GOPAY_MERCHANT_ID`| Optional | GoPay / GoBiz merchant identifier | `G123456789` |
| `GOBIZ_EMAIL` / `GOJEK_EMAIL` | Optional | Account email for GoBiz authentication | `merchant@example.com` |
| `GOBIZ_PASSWORD` / `GOJEK_PASSWORD` | Optional | Account password for GoBiz authentication | `secretpassword` |

### NPM Scripts
```bash
# Run in development mode with hot-reloading (tsx)
npm run dev

# Compile TypeScript to JavaScript (dist/)
npm run build

# Start the compiled production build
npm start
```

---

## 9. Coding Guidelines & Best Practices for AI Agents

1. **ESM Module Resolution**:
   - This project uses native Node.js ESM (`"type": "module"` in `package.json`).
   - When importing local TypeScript/JavaScript files, **always include the `.js` extension** (e.g., `import { User } from "../../models/User.js";`).
2. **Telegram Callback Queries**:
   - Always invoke `await ctx.answerCallbackQuery()` inside callback query handlers to prevent endless loading animations on the client.
   - Wrap `answerCallbackQuery` in `try/catch` or allow the global error filter to catch `query is too old`.
3. **Safe Message Updates**:
   - Use `safeEditOrReply` patterns when switching between media messages (photos/receipts) and text menus. Attempting to edit a photo message with text alone causes a Telegram API error.
4. **Database Operations**:
   - Use `.lean()` for read-only Mongoose queries to reduce overhead.
   - For configuration documents, always use `SmsConfig.getOrCreate()` and `BotConfig.getOrCreate()` to guarantee a non-null singleton.
   - When mutating user balances, ensure atomic operations (e.g. `$inc`) or validation checks against negative balances.
5. **Puppeteer Receipt Generator**:
   - The browser instance in `ReceiptService` is maintained as a singleton (`getBrowser()`). Ensure pages are always closed in `finally` blocks (`await page.close()`).
6. **Privacy Protection**:
   - Never log or post unmasked user phone numbers or full Telegram IDs in public channels. Always use the privacy masking helpers (`maskId`, `maskPhone`) in `src/services/testimonial.ts`.
