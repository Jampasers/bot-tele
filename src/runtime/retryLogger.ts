type Clock = () => number;
type Sink = (line: string) => void;

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Unknown error");
  return raw
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@[redacted]")
    .replace(/\b(?:authorization|token|password|secret|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Unknown error";
}

interface WarningState {
  lastLoggedAt: number;
  suppressed: number;
}

export class ThrottledWarningLogger {
  private readonly states = new Map<string, WarningState>();

  constructor(private readonly windowMs = 5 * 60_000, private readonly now: Clock = Date.now, private readonly sink: Sink = line => console.warn(line)) {}

  warn(key: string, message: string, error: unknown): void {
    const current = this.now();
    const previous = this.states.get(key);
    if (previous && current - previous.lastLoggedAt < this.windowMs) {
      previous.suppressed++;
      return;
    }
    const repeat = previous?.suppressed ?? 0;
    this.states.set(key, { lastLoggedAt: current, suppressed: 0 });
    this.sink(`${message}: ${safeErrorMessage(error)}${repeat ? ` (${repeat} repeat${repeat === 1 ? "" : "s"} suppressed)` : ""}`);
  }
}
