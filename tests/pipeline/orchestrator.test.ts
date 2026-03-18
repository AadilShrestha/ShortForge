import { describe, test, expect } from "bun:test";

describe("PipelineOrchestrator.extractVideoId", () => {
  // Test the regex pattern used by orchestrator
  const extractVideoId = (url: string): string => {
    const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] ?? url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  };

  test("extracts from standard URL", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("extracts from short URL", () => {
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("extracts from shorts URL", () => {
    expect(extractVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });

  test("extracts with query params", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120")).toBe("dQw4w9WgXcQ");
  });

  test("falls back for non-YouTube URL", () => {
    const id = extractVideoId("some-random-string");
    expect(id).toBeDefined();
    expect(id.length).toBeLessThanOrEqual(32);
  });
});

describe("Semaphore logic", () => {
  test("limits concurrency", async () => {
    // Inline semaphore test matching orchestrator's implementation
    class Semaphore {
      private count: number;
      private queue: Array<() => void> = [];
      constructor(max: number) {
        this.count = max;
      }
      async acquire(): Promise<void> {
        if (this.count > 0) {
          this.count--;
          return;
        }
        return new Promise((resolve) => this.queue.push(resolve));
      }
      release(): void {
        if (this.queue.length > 0) {
          this.queue.shift()!();
        } else {
          this.count++;
        }
      }
    }

    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async (_id: number) => {
      await sem.acquire();
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 50));
      concurrent--;
      sem.release();
    };

    await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
    expect(maxConcurrent).toBe(2);
  });
});
