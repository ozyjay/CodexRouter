export interface StreamThroughput {
  estimatedTokens: number;
  tokensPerSecond?: number;
}

/**
 * App Server delta events do not include authoritative token counts. This is
 * deliberately a local, display-only approximation based on generated text.
 */
export class StreamTokenEstimator {
  private characters = 0;
  private startedAt?: number;

  observe(delta: string, now = Date.now()): StreamThroughput {
    if (this.startedAt === undefined) this.startedAt = now;
    this.characters += delta.length;
    const estimatedTokens = Math.max(1, Math.ceil(this.characters / 4));
    const elapsedMs = now - this.startedAt;
    return {
      estimatedTokens,
      tokensPerSecond: elapsedMs >= 1_000 ? estimatedTokens / (elapsedMs / 1_000) : undefined
    };
  }
}
