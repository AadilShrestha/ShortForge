import { describe, test, expect } from "bun:test";
import { Downloader } from "../../src/modules/downloader";

describe("Downloader", () => {
  test("fetchVideoMetadata parses yt-dlp metadata output", async () => {
    const dl = new Downloader();
    const internals = dl as unknown as {
      runYtDlpWithCookieFallback: (
        argsWithoutBinary: string[],
        mode: "pipe" | "inherit",
      ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };

    internals.runYtDlpWithCookieFallback = async (argsWithoutBinary, mode) => {
      expect(argsWithoutBinary).toEqual([
        "--dump-json",
        "--no-download",
        "https://www.youtube.com/watch?v=abcdefghijk",
      ]);
      expect(mode).toBe("pipe");

      return {
        exitCode: 0,
        stdout: JSON.stringify({
          id: "abcdefghijk",
          title: "Resolved Title",
          duration: 93,
          upload_date: "20240102",
        }),
        stderr: "",
      };
    };

    const metadata = await dl.fetchVideoMetadata("https://www.youtube.com/watch?v=abcdefghijk");
    expect(metadata).toEqual({
      videoId: "abcdefghijk",
      title: "Resolved Title",
      duration: 93,
      uploadDate: "20240102",
    });
  });

  test("fetchVideoMetadata surfaces yt-dlp failures", async () => {
    const dl = new Downloader();
    const internals = dl as unknown as {
      runYtDlpWithCookieFallback: (
        argsWithoutBinary: string[],
        mode: "pipe" | "inherit",
      ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };

    internals.runYtDlpWithCookieFallback = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "yt-dlp unavailable",
    });

    await expect(dl.fetchVideoMetadata("https://www.youtube.com/watch?v=abcdefghijk")).rejects.toThrow(
      "yt-dlp metadata failed: yt-dlp unavailable",
    );
  });


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

  test("download prefers 720p-plus format selector before lower fallbacks", async () => {
    const dl = new Downloader();
    const internals = dl as unknown as {
      fetchVideoMetadata: (videoUrl: string) => Promise<{
        videoId: string;
        title: string;
        duration: number;
        uploadDate: string;
      }>;
      runYtDlpWithCookieFallback: (
        argsWithoutBinary: string[],
        mode: "pipe" | "inherit",
      ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };

    internals.fetchVideoMetadata = async () => ({
      videoId: "video720",
      title: "Format Preference Test",
      duration: 42,
      uploadDate: "20240102",
    });

    let capturedFormat = "";
    internals.runYtDlpWithCookieFallback = async (argsWithoutBinary, mode) => {
      expect(mode).toBe("inherit");
      expect(argsWithoutBinary[0]).toBe("-f");
      capturedFormat = argsWithoutBinary[1] ?? "";

      const outputArgIndex = argsWithoutBinary.indexOf("-o");
      if (outputArgIndex === -1 || !argsWithoutBinary[outputArgIndex + 1]) {
        throw new Error("Expected -o output path argument.");
      }
      const outputPath = argsWithoutBinary[outputArgIndex + 1]!;
      await Bun.write(outputPath, "dummy");

      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    };

    const { mkdirSync, rmSync, existsSync } = await import("fs");
    const { join } = await import("path");
    const tmpDir = join(import.meta.dir, "__tmp_dl_format__");
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });

    try {
      await dl.download("https://www.youtube.com/watch?v=abcdefghijk", tmpDir);
      expect(capturedFormat).toContain("bestvideo[height>=720][height<=1080]+bestaudio");
      expect(capturedFormat).toContain("/best[height>=720][height<=1080]");
      expect(capturedFormat).toContain("/bestvideo+bestaudio/best");
    } finally {
      if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
