import { Bot, Context } from "grammy";

// ---------------------------------------------------------------------------
// PluginCommand — a single entry in Telegram's bot command menu.
// Mirrors the shape Telegram's Bot API expects for `setMyCommands`.
// ---------------------------------------------------------------------------

/**
 * Represents one slash-command that will appear in Telegram's command menu.
 *
 * Rules (enforced by the Telegram Bot API):
 *  - `command`     1–32 chars, lowercase letters / digits / underscores, NO leading slash.
 *  - `description` 1–256 chars, plain text shown below the command in the menu.
 */
export interface PluginCommand {
  /** The command string without a leading slash (e.g. "ping", "start"). */
  readonly command: string;

  /** Short description shown to users in the Telegram command picker. */
  readonly description: string;
}

// ---------------------------------------------------------------------------
// Plugin — the strict contract every plugin folder must satisfy.
// ---------------------------------------------------------------------------

/**
 * The contract every plugin must satisfy.
 * Drop a folder inside `src/plugins/` with an `index.ts` that exports
 * a default object implementing this interface — the loader handles the rest.
 */
export interface Plugin {
  /** Unique, human-readable identifier for the plugin (e.g. "ping"). */
  readonly name: string;

  /** Semantic version string following semver (e.g. "1.0.0"). */
  readonly version: string;

  /**
   * The commands this plugin exposes to Telegram's command menu.
   *
   * - **Optional** — plugins that only use callback queries or middleware
   *   (no slash commands) can omit this entirely.
   * - The loader collects these from every loaded plugin and calls
   *   `bot.api.setMyCommands()` once after all plugins are registered,
   *   so the Telegram command picker stays in sync automatically.
   *
   * @example
   * commands: [
   *   { command: "ping",  description: "Check if the bot is alive" },
   *   { command: "start", description: "Open the main menu" },
   * ]
   */
  readonly commands?: readonly PluginCommand[];

  /**
   * Called once at startup by the plugin loader.
   * Register all commands, listeners, and middleware here.
   *
   * @param bot - The shared grammY Bot instance.
   */
  register(bot: Bot<Context>): void;
}
