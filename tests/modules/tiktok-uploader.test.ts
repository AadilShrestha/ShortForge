import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";

import { describe, expect, test } from "bun:test";

import { discoverMp4Files, uploadTikTokVideos } from "../../src/modules/tiktok-uploader";
import type { TikTokPrivacyLevel } from "../../src/modules/tiktok-uploader";

function normalizeRelativePath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).replace(/\\/g, "/");
}

async function createFixtureDirectory(prefix: string): Promise<string> {
  const fixtureDir = join(import.meta.dir, "__tmp__", `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(fixtureDir, { recursive: true });
  return fixtureDir;
}

describe("tiktok-uploader", () => {
  test("discoverMp4Files returns only mp4 files in deterministic order", async () => {
    const fixtureDir = await createFixtureDirectory("tiktok-discover");

    try {
      await mkdir(join(fixtureDir, "nested", "deep"), { recursive: true });
      await writeFile(join(fixtureDir, "B.mp4"), "dummy");
      await writeFile(join(fixtureDir, "a.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "02-clip.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "ignore.txt"), "ignore");
      await writeFile(join(fixtureDir, "nested", "deep", "Z.mp4"), "dummy");

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

  test("uploadTikTokVideos dry-run builds captions without OAuth", async () => {
    const fixtureDir = await createFixtureDirectory("tiktok-dryrun");

    try {
      await writeFile(join(fixtureDir, "001_my-first_clip.mp4"), "dummy");

      const results = await uploadTikTokVideos({
        dir: fixtureDir,
        privacyLevel: "FOLLOWER_OF_CREATOR",
        creditName: "Creator Name",
        creditUrl: "https://example.com/creator",
        captionTemplate: "Hook line",
        dryRun: true,
      });

      expect(results).toHaveLength(1);

      const [result] = results;
      expect(result.success).toBe(true);
      expect(result.dryRun).toBe(true);

      if (!result.success || !result.dryRun) {
        throw new Error("Expected dry-run TikTok upload result.");
      }

      expect(result.privacyLevel).toBe("FOLLOWER_OF_CREATOR");
      expect(result.caption).toContain("Hook line");
      expect(result.caption).toContain("Credit: Creator Name");
      expect(result.caption).toContain("Credit URL: https://example.com/creator");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadTikTokVideos dry-run uses explicit uploads in provided order with per-upload overrides", async () => {
    const fixtureDir = await createFixtureDirectory("tiktok-explicit-uploads");

    try {
      await mkdir(join(fixtureDir, "nested"), { recursive: true });
      await writeFile(join(fixtureDir, "001.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "002.mp4"), "dummy");

      const results = await uploadTikTokVideos({
        dir: fixtureDir,
        privacyLevel: "FOLLOWER_OF_CREATOR",
        creditName: "Creator Name",
        creditUrl: "https://example.com/creator",
        captionTemplate: "Hook line",
        dryRun: true,
        uploads: [
          {
            filePath: "nested/002.mp4",
            caption: "  custom caption  ",
            privacyLevel: "PUBLIC_TO_EVERYONE",
          },
          {
            filePath: "001.mp4",
            caption: "   ",
            privacyLevel: null,
          },
        ],
      });

      expect(results).toHaveLength(2);

      const [firstResult, secondResult] = results;
      if (!firstResult.success || !firstResult.dryRun || !secondResult.success || !secondResult.dryRun) {
        throw new Error("Expected dry-run TikTok upload results.");
      }

      expect(firstResult.filePath).toBe(join(fixtureDir, "nested", "002.mp4"));
      expect(secondResult.filePath).toBe(join(fixtureDir, "001.mp4"));

      expect(firstResult.caption).toBe("custom caption");
      expect(firstResult.privacyLevel).toBe("PUBLIC_TO_EVERYONE");

      expect(secondResult.caption).toContain("Hook line");
      expect(secondResult.caption).toContain("Credit: Creator Name");
      expect(secondResult.caption).toContain("Credit URL: https://example.com/creator");
      expect(secondResult.privacyLevel).toBe("FOLLOWER_OF_CREATOR");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadTikTokVideos rejects invalid per-upload privacy override", async () => {
    const fixtureDir = await createFixtureDirectory("tiktok-invalid-override-privacy");

    try {
      await writeFile(join(fixtureDir, "clip.mp4"), "dummy");

      await expect(
        uploadTikTokVideos({
          dir: fixtureDir,
          privacyLevel: "SELF_ONLY",
          creditName: "Creator Name",
          dryRun: true,
          uploads: [
            {
              filePath: "clip.mp4",
              privacyLevel: "INVALID_PRIVACY_LEVEL" as TikTokPrivacyLevel,
            },
          ],
        }),
      ).rejects.toThrow(/invalid|privacyLevel must be one of/i);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
