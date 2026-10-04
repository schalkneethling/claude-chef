export type ClaudeChefReading = {
  tokens: number;
  window: number;
  percent: number;
};

declare module "claude-code" {
  interface PluginState {
    "claude-chef": { readings: ClaudeChefReading[] };
  }
}
