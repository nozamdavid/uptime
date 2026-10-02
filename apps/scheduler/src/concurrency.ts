/** FIFO concurrency limiter for work in one scheduler process. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  public constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error('Concurrency maximum must be >= 1');
  }

  public async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maximum) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    next?.();
  }
}
