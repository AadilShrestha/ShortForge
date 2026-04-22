import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";

import { describe, expect, test } from "bun:test";

import { discoverMp4Files, uploadYouTubeShorts } from "../../src/modules/youtube-uploader";

function normalizeRelativePath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).replace(/\\/g, "/");
}

async function createFixtureDirectory(prefix: string): Promise<string> {
  const fixtureDir = join(import.meta.dir, "__tmp__", `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(fixtureDir, { recursive: true });
  return fixtureDir;
}

describe("youtube-uploader", () => {
  test("discoverMp4Files returns nested mp4 files in deterministic order", async () => {
    const fixtureDir = await createFixtureDirectory("youtube-discover");

    try {
      await mkdir(join(fixtureDir, "nested", "deep"), { recursive: true });
      await writeFile(join(fixtureDir, "B.mp4"), "dummy");
      await writeFile(join(fixtureDir, "a.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "02-clip.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "deep", "Z.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "ignore.txt"), "ignore");

      const files = await discoverMp4Files(fixtureDir);
      const relativeFiles = files.map((filePath) => normalizeRelativePath(fixtureDir, filePath));

      expect(relativeFiles).toEqual([
        "a.mp4",
        "B.mp4",
        "nested/02-clip.mp4",
        "nested/deep/Z.mp4",
      ]);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadYouTubeShorts dry-run uses explicit uploads in provided order with per-upload overrides", async () => {
    const fixtureDir = await createFixtureDirectory("youtube-explicit-uploads");

    try {
      await mkdir(join(fixtureDir, "nested"), { recursive: true });
      const firstFilePath = join(fixtureDir, "nested", "002_custom-file.mp4");
      const secondFilePath = join(fixtureDir, "001_baseline_clip.mp4");
      await writeFile(firstFilePath, "dummy");
      await writeFile(secondFilePath, "dummy");

      const results = await uploadYouTubeShorts({
        dir: fixtureDir,
        privacyStatus: "private",
        creditName: "Creator Name",
        creditUrl: "https://example.com/creator",
        descriptionTemplate: "Opening description",
        dryRun: true,
        uploads: [
          {
            filePath: firstFilePath,
            title: "  custom title  ",
            description: "  custom description  ",
          },
          {
            filePath: secondFilePath,
            title: "   ",
            description: "   ",
          },
        ],
      });

      expect(results).toHaveLength(2);

      const [firstResult, secondResult] = results;
      if (!firstResult.success || !firstResult.dryRun || !secondResult.success || !secondResult.dryRun) {
        throw new Error("Expected dry-run YouTube upload results.");
      }

      expect(firstResult.filePath).toBe(firstFilePath);
      expect(secondResult.filePath).toBe(secondFilePath);

      expect(firstResult.title).toBe("custom title");
      expect(firstResult.description).toBe("custom description");
      expect(firstResult.privacyStatus).toBe("private");
      expect(firstResult.selfDeclaredMadeForKids).toBe(false);

      expect(secondResult.title).toBe("Baseline Clip");
      expect(secondResult.description).toContain("Opening description");
      expect(secondResult.description).toContain("Credit: Creator Name");
      expect(secondResult.description).toContain("Credit URL: https://example.com/creator");
      expect(secondResult.description).toContain("#shorts");
      expect(secondResult.privacyStatus).toBe("private");
      expect(secondResult.selfDeclaredMadeForKids).toBe(false);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadYouTubeShorts rejects empty uploads filePath", async () => {
    const fixtureDir = await createFixtureDirectory("youtube-empty-upload-filepath");

    try {
      await expect(
        uploadYouTubeShorts({
          dir: fixtureDir,
          creditName: "Creator Name",
          dryRun: true,
          uploads: [
            {
              filePath: "   ",
            },
          ],
        }),
      ).rejects.toThrow("uploads[].filePath is required.");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadYouTubeShorts dry-run honors explicit made-for-kids setting", async () => {
    const fixtureDir = await createFixtureDirectory("youtube-made-for-kids");

    try {
      const filePath = join(fixtureDir, "clip.mp4");
      await writeFile(filePath, "dummy");

      const results = await uploadYouTubeShorts({
        dir: fixtureDir,
        creditName: "Creator Name",
        selfDeclaredMadeForKids: true,
        dryRun: true,
        uploads: [{ filePath }],
      });

      expect(results).toHaveLength(1);
      const [firstResult] = results;
      if (!firstResult || !firstResult.success || !firstResult.dryRun) {
        throw new Error("Expected dry-run result.");
      }

      expect(firstResult.selfDeclaredMadeForKids).toBe(true);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
