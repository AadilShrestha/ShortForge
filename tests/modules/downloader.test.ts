import { describe, test, expect } from "bun:test";
import { Downloader } from "../../src/modules/downloader";

describe("Downloader", () => {
  test("listChannelVideos returns URLs for Prof. Jiang channel", async () => {
    const dl = new Downloader();
    const urls = await dl.listChannelVideos("https://www.youtube.com/@PredictiveHistory", 3);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.length).toBeLessThanOrEqual(3);
    for (const url of urls) {
      expect(url).toMatch(/youtube\.com\/watch\?v=/);
    }
  }, 30_000);

  test("download fetches metadata and video", async () => {
    const dl = new Downloader();
    const { mkdirSync, rmSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const tmpDir = join(import.meta.dir, "__tmp_dl__");
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });

    try {
      // Use a short Prof. Jiang video
      const meta = await dl.download("https://www.youtube.com/watch?v=dQw4w9WgXcQ", tmpDir);
      expect(meta.videoId).toBeDefined();
      expect(meta.title).toBeDefined();
      expect(meta.duration).toBeGreaterThan(0);
      expect(existsSync(meta.filePath)).toBe(true);
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
