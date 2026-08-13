# 🤖 grammY Plugin Bot

A **production-ready, plugin-based Telegram bot** boilerplate built with [grammY](https://grammy.dev/) and TypeScript.

## ✨ Key Features

- **Zero-config plugin discovery** — drop a folder in `src/plugins/`, the bot auto-loads it on startup.
- **Strict TypeScript** — every plugin is validated against the `Plugin` interface at runtime *and* compile time.
- **Graceful shutdown** — handles `SIGINT` / `SIGTERM` cleanly (Docker-friendly).
- **ESM-native** — uses Node.js ESM modules with dynamic `import()`.

---

## 📁 Folder Structure

```
├── src/
│   ├── index.ts               # Entry point — validates env, bootstraps bot
│   ├── core/
│   │   ├── bot.ts             # Bot factory (creates & configures Bot instance)
│   │   └── pluginLoader.ts    # 🔑 Dynamic plugin scanner & loader
│   ├── types/
│   │   └── Plugin.ts          # Strict Plugin interface contract
│   └── plugins/
│       ├── ping/
│       │   └── index.ts       # Sample: /ping → "Pong!"
│       └── info/
│           └── index.ts       # Sample: /start, /info
├── .env.example
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## 🚀 Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure your token

```bash
cp .env.example .env
```

Edit `.env` and set your bot token from [@BotFather](https://t.me/BotFather):

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
```

### 3. Run in development mode

```bash
npm run dev
```

### 4. Build & run for production

```bash
npm run build
npm start
```

---

## 🔌 Creating a New Plugin

1. **Create a new folder** inside `src/plugins/`:

```
src/plugins/my-feature/
└── index.ts
```

2. **Implement the `Plugin` interface** and export it as default:

```typescript
// src/plugins/my-feature/index.ts
import { Bot, Context } from "grammy";
import { Plugin } from "../../types/Plugin.js";

const myFeaturePlugin: Plugin = {
  name: "my-feature",
  version: "1.0.0",

  register(bot: Bot<Context>): void {
    bot.command("hello", async (ctx) => {
      await ctx.reply("Hello, World!");
    });
  },
};

export default myFeaturePlugin;
```

3. **Restart the bot.** The loader finds and registers it automatically — no imports needed anywhere else.

---

## 🗑️ Removing a Plugin

Simply **delete its folder** from `src/plugins/`. Nothing else to change.

---

## 🧩 Plugin Interface Contract

Every plugin must satisfy this interface (defined in [`src/types/Plugin.ts`](src/types/Plugin.ts)):

| Field      | Type                         | Description                                      |
|------------|------------------------------|--------------------------------------------------|
| `name`     | `string`                     | Unique, human-readable identifier                |
| `version`  | `string`                     | Semver version string (e.g., `"1.0.0"`)          |
| `register` | `(bot: Bot<Context>) => void`| Called once at startup; attach all handlers here |

If a plugin's default export doesn't match this interface, it is **skipped with a warning** — the bot continues running.

---

## 📜 Available Scripts

| Command         | Description                             |
|-----------------|-----------------------------------------|
| `npm run dev`   | Run with `ts-node` (hot TypeScript)     |
| `npm run build` | Compile TypeScript → `dist/`            |
| `npm start`     | Run compiled JS from `dist/`            |
| `npm run clean` | Delete the `dist/` folder              |

---

## 🏗️ How the Loader Works

```
Startup
  └─▶ createBot()
        └─▶ loadPlugins(bot)
              ├─▶ readdirSync("src/plugins/")
              ├─▶ For each folder:
              │     ├─▶ Find index.ts / index.js
              │     ├─▶ dynamic import(fileURL)
              │     ├─▶ isPlugin(mod.default) — runtime type guard
              │     └─▶ plugin.register(bot)  — attach handlers
              └─▶ bot.start()  — begin polling
```
