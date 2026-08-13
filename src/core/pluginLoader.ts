import { Bot, Context } from "grammy";
import { readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { Plugin, PluginCommand } from "../types/Plugin.js";

// ---------------------------------------------------------------------------
// Resolve the absolute path to `src/plugins/` regardless of CWD.
// ---------------------------------------------------------------------------
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PLUGINS_DIR = resolve(__dirname, "..", "plugins");

// ---------------------------------------------------------------------------
// Type guard — verifies that a dynamic import's default export is a Plugin.
// ---------------------------------------------------------------------------
function isPlugin(value: unknown): value is Plugin {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["name"] === "string" &&
    typeof candidate["version"] === "string" &&
    typeof candidate["register"] === "function"
  );
}

/**
 * Validates that a `commands` value is a well-formed PluginCommand array.
 * Rejects anything that would cause `setMyCommands` to throw at the API level.
 */
function isValidCommands(value: unknown): value is readonly PluginCommand[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>)["command"] === "string" &&
      typeof (item as Record<string, unknown>)["description"] === "string"
  );
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Scans `src/plugins/`, dynamically imports each `index.ts/js`, validates
 * the exported Plugin object, calls its `register` method, and collects
 * any declared commands.
 *
 * After all plugins are loaded, calls `bot.api.setMyCommands()` once with
 * the full aggregated command list so Telegram's command picker stays in sync.
 *
 * A plugin is skipped (with a warning) if:
 *   - its folder has no `index.ts` / `index.js`
 *   - its default export does not implement the Plugin interface
 *   - it throws during import or registration
 */
export async function loadPlugins(bot: Bot<Context>): Promise<void> {
  console.log(`🔍  Scanning plugins directory: ${PLUGINS_DIR}`);

  let entries: string[];
  try {
    entries = readdirSync(PLUGINS_DIR);
  } catch {
    console.warn(
      "⚠️   plugins/ directory not found — no plugins will be loaded."
    );
    return;
  }

  const pluginFolders = entries.filter((entry) => {
    const fullPath = join(PLUGINS_DIR, entry);
    return statSync(fullPath).isDirectory();
  });

  if (pluginFolders.length === 0) {
    console.warn("⚠️   No plugin folders found inside plugins/.");
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command collector — filled as we loop; flushed to Telegram at the end.
  // Using a plain mutable array here is intentional: it's local to this
  // function call and never escapes, so there's no shared-state concern.
  // ─────────────────────────────────────────────────────────────────────────
  const collectedCommands: PluginCommand[] = [];

  let loadedCount = 0;

  for (const folder of pluginFolders) {
    // ── Archive guard ────────────────────────────────────────────────────────
    // Any folder whose name begins with "archived_" is treated as intentionally
    // disabled. We skip it entirely — no import, no registration, no commands.
    // To re-enable a plugin, simply rename the folder (remove the prefix).
    if (folder.startsWith("archived_")) {
      console.log(`📦  [${folder}] Skipped — archived plugin.`);
      continue;
    }
    // ────────────────────────────────────────────────────────────────────────

    const pluginDir = join(PLUGINS_DIR, folder);

    // Prefer .js (compiled) in production; fall back to .ts (ts-node in dev).
    const candidates = ["index.js", "index.ts"];
    const entryFile = candidates
      .map((f) => join(pluginDir, f))
      .find((f) => {
        try {
          statSync(f);
          return true;
        } catch {
          return false;
        }
      });

    if (!entryFile) {
      console.warn(
        `⚠️   [${folder}] Skipped — no index.ts or index.js found.`
      );
      continue;
    }

    try {
      // Convert the absolute path to a file:// URL (required for ESM imports
      // on Windows where backslashes break dynamic import paths).
      const moduleUrl = pathToFileURL(entryFile).href;
      const mod = await import(moduleUrl);
      const plugin: unknown = mod.default;

      if (!isPlugin(plugin)) {
        console.warn(
          `⚠️   [${folder}] Skipped — default export does not implement the Plugin interface.`
        );
        continue;
      }

      // 1. Register the plugin's handlers on the bot instance.
      plugin.register(bot);

      // 2. Collect commands declared by this plugin (optional field).
      if (plugin.commands !== undefined) {
        if (isValidCommands(plugin.commands)) {
          // Spread into the collector so each plugin's commands are appended.
          collectedCommands.push(...plugin.commands);

          const names = plugin.commands
            .map((c) => `/${c.command}`)
            .join(", ");
          console.log(
            `✅  Plugin loaded: "${plugin.name}" v${plugin.version}  ` +
              `[commands: ${names}]`
          );
        } else {
          // Commands exist but are malformed — still load the plugin, just warn.
          console.warn(
            `⚠️   [${folder}] Plugin loaded but "commands" is malformed — ` +
              `skipping command registration for this plugin.`
          );
          console.log(`✅  Plugin loaded: "${plugin.name}" v${plugin.version}`);
        }
      } else {
        // Plugin has no commands (e.g. it only uses callback queries).
        console.log(
          `✅  Plugin loaded: "${plugin.name}" v${plugin.version}  [no commands]`
        );
      }

      loadedCount++;
    } catch (err) {
      console.error(`❌  [${folder}] Failed to load plugin:`, err);
    }
  }

  console.log(
    `\n🚀  ${loadedCount} / ${pluginFolders.length} plugin(s) loaded successfully.`
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Push the aggregated command list to Telegram in one API call.
  // Doing this AFTER all plugins are registered ensures the list is complete.
  //
  // An empty array is a valid call — it clears any previously set commands,
  // which is the correct behaviour when no plugin declares any commands.
  // ─────────────────────────────────────────────────────────────────────────
  if (collectedCommands.length > 0) {
    console.log(
      `\n📋  Registering ${collectedCommands.length} command(s) with Telegram:`
    );

    // Pretty-print the full command table for easy debugging at startup.
    const maxCmdLen = Math.max(...collectedCommands.map((c) => c.command.length));
    for (const { command, description } of collectedCommands) {
      console.log(
        `    /${command.padEnd(maxCmdLen)}  —  ${description}`
      );
    }

    await bot.api.setMyCommands(collectedCommands);
    console.log("✅  setMyCommands() completed.\n");
  } else {
    console.log(
      "\n📋  No commands declared across all plugins — skipping setMyCommands().\n"
    );
  }
}
