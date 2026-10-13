import { config, type Config } from "./runtime";

export type ClaudeProviderDefaults = Readonly<{
  model: string;
  autoMemory: boolean;
}>;
export type ResolvedConfig = Config & Readonly<{ disableAutoMemory: boolean }>;
const NATIVE_DEFAULTS: ClaudeProviderDefaults = Object.freeze({
  model: "",
  autoMemory: true,
});
const STORAGE_KEY = "buzz.claude-code.provider-defaults.v1";
const MODELS = new Set(["", "opus", "sonnet", "haiku"]);

/** Device-wide defaults are separate from agent records; a blank agent value
 * inherits this store and a blank store value leaves Claude Code in charge. */
export class ClaudeDefaults {
  private state: ClaudeProviderDefaults;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Storage = localStorage) {
    this.state = this.read();
  }

  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  resolve(raw: unknown): ResolvedConfig {
    const explicit = config(raw);
    return {
      ...explicit,
      model: explicit.model.trim() ? explicit.model : this.state.model,
      disableAutoMemory: !this.state.autoMemory,
    };
  }
  save(next: ClaudeProviderDefaults) {
    const model = MODELS.has(next.model) ? next.model : "";
    const autoMemory = Boolean(next.autoMemory);
    this.storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 1, model, autoMemory }),
    );
    this.state = Object.freeze({ model, autoMemory });
    for (const listener of this.listeners) listener();
  }
  private read(): ClaudeProviderDefaults {
    try {
      const value: unknown = JSON.parse(
        this.storage.getItem(STORAGE_KEY) ?? "null",
      );
      if (
        value &&
        typeof value === "object" &&
        (value as { version?: unknown }).version === 1 &&
        typeof (value as { model?: unknown }).model === "string" &&
        MODELS.has((value as { model: string }).model)
      )
        return Object.freeze({
          model: (value as { model: string }).model,
          autoMemory: (value as { autoMemory?: unknown }).autoMemory !== false,
        });
    } catch {
      // Malformed local preferences preserve Claude Code's native default.
    }
    return NATIVE_DEFAULTS;
  }
}
