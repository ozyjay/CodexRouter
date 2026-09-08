/** A failed interrupt can be retried; completion still comes from the turn stream. */
export class TurnStopController {
  private requested = false;
  private disposed = false;

  constructor(private readonly interrupt: () => Promise<void>, private readonly update: (stopping: boolean) => void) {}

  request(): void {
    if (this.requested || this.disposed) return;
    this.requested = true;
    this.update(true);
    void this.interrupt().catch(() => {
      if (this.disposed) return;
      this.requested = false;
      this.update(false);
    });
  }

  dispose(): void { this.disposed = true; }
}
