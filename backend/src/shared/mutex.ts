/**
 * Mutex — simple in-process async mutual exclusion.
 *
 * P2 baseline: prevents concurrent read-modify-write races in file stores.
 * P3 may replace with database transactions.
 */

type QueueEntry = {
  resolve: () => void;
};

export class Mutex {
  private locked = false;
  private queue: QueueEntry[] = [];

  async lock(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.locked) {
        this.locked = true;
        resolve();
        return;
      }
      this.queue.push({ resolve });
    });
  }

  unlock(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.locked = false;
    }
  }

  /** Run an async function under the mutex lock. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.lock();
    try {
      return await fn();
    } finally {
      this.unlock();
    }
  }
}
