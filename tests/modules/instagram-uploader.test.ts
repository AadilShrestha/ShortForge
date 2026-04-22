import { mkdir, rm, writeFile } from "fs/promises";
import { join, relative } from "path";

import { describe, expect, test } from "bun:test";

import { discoverMp4Files, uploadInstagramReels } from "../../src/modules/instagram-uploader";

function normalizeRelativePath(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).replace(/\\/g, "/");
}

async function createFixtureDirectory(prefix: string): Promise<string> {
  const fixtureDir = join(import.meta.dir, "__tmp__", `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(fixtureDir, { recursive: true });
  return fixtureDir;
}

describe("instagram-uploader", () => {
  test("discoverMp4Files returns nested mp4 files sorted by relative path", async () => {
    const fixtureDir = await createFixtureDirectory("instagram-discover");

    try {
      await mkdir(join(fixtureDir, "nested", "deep"), { recursive: true });
      await writeFile(join(fixtureDir, "clip-b.mp4"), "dummy");
      await writeFile(join(fixtureDir, "clip-a.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "deep", "clip-c.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "ignore.mov"), "ignore");

      const files = await discoverMp4Files(fixtureDir);
      const relativeFiles = files.map((filePath) => normalizeRelativePath(fixtureDir, filePath));

      expect(relativeFiles).toEqual([
        "clip-a.mp4",
        "clip-b.mp4",
        "nested/deep/clip-c.mp4",
      ]);
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadInstagramReels dry-run builds captions and does not require OAuth", async () => {
    const fixtureDir = await createFixtureDirectory("instagram-dryrun");

    try {
      await writeFile(join(fixtureDir, "001.mp4"), "dummy");
      await writeFile(join(fixtureDir, "002.mp4"), "dummy");

      const results = await uploadInstagramReels({
        dir: fixtureDir,
        igUserId: "17841400000000000",
        creditName: "Creator Name",
        creditUrl: "https://example.com/creator",
        captionTemplate: "Opening line",
        dryRun: true,
      });

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.success).toBe(true);
        expect(result.dryRun).toBe(true);

        if (!result.success || !result.dryRun) {
          throw new Error("Expected dry-run Instagram upload result.");
        }

        expect(result.igUserId).toBe("17841400000000000");
        expect(result.caption).toContain("Opening line");
        expect(result.caption).toContain("Credit: Creator Name");
        expect(result.caption).toContain("Credit URL: https://example.com/creator");
        expect(result.caption).toContain("#reels");
      }
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadInstagramReels rejects non-numeric igUserId", async () => {
    const fixtureDir = await createFixtureDirectory("instagram-invalid-id");

    try {
      await writeFile(join(fixtureDir, "clip.mp4"), "dummy");

      await expect(
        uploadInstagramReels({
          dir: fixtureDir,
          igUserId: "not-a-number",
          creditName: "Creator Name",
          dryRun: true,
        }),
      ).rejects.toThrow("invalid");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadInstagramReels dry-run uses explicit uploads in provided order", async () => {
    const fixtureDir = await createFixtureDirectory("instagram-explicit-uploads");

    try {
      await mkdir(join(fixtureDir, "nested"), { recursive: true });
      await writeFile(join(fixtureDir, "001.mp4"), "dummy");
      await writeFile(join(fixtureDir, "nested", "002.mp4"), "dummy");

      const results = await uploadInstagramReels({
        dir: fixtureDir,
        igUserId: "17841400000000000",
        creditName: "Creator Name",
        creditUrl: "https://example.com/creator",
        captionTemplate: "Opening line",
        dryRun: true,
        uploads: [
          {
            filePath: "nested/002.mp4",
            caption: "  custom caption  ",
            igUserId: " 17841400000000001 ",
          },
          {
            filePath: "001.mp4",
            caption: "   ",
            igUserId: "   ",
          },
        ],
      });

      expect(results).toHaveLength(2);

      const [firstResult, secondResult] = results;
      if (!firstResult.success || !firstResult.dryRun || !secondResult.success || !secondResult.dryRun) {
        throw new Error("Expected dry-run Instagram upload results.");
      }

      expect(firstResult.filePath).toBe(join(fixtureDir, "nested", "002.mp4"));
      expect(secondResult.filePath).toBe(join(fixtureDir, "001.mp4"));

      expect(firstResult.igUserId).toBe("17841400000000001");
      expect(firstResult.caption).toBe("custom caption");

      expect(secondResult.igUserId).toBe("17841400000000000");
      expect(secondResult.caption).toContain("Opening line");
      expect(secondResult.caption).toContain("Credit: Creator Name");
      expect(secondResult.caption).toContain("Credit URL: https://example.com/creator");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test("uploadInstagramReels rejects invalid per-upload igUserId override", async () => {
    const fixtureDir = await createFixtureDirectory("instagram-invalid-override-id");

    try {
      await writeFile(join(fixtureDir, "clip.mp4"), "dummy");

      await expect(
        uploadInstagramReels({
          dir: fixtureDir,
          igUserId: "17841400000000000",
          creditName: "Creator Name",
          dryRun: true,
          uploads: [
            {
              filePath: "clip.mp4",
              igUserId: "not-a-number",
            },
          ],
        }),
      ).rejects.toThrow("invalid");
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
