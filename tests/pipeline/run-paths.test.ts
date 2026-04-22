import { join } from "path";

import { describe, expect, test } from "bun:test";

import {
  extractVideoId,
  inferOutputDirFromMetadata,
  toOutputFolderName,
} from "../../web/lib/run-paths";

describe("run-paths", () => {
  test("inferOutputDirFromMetadata appends final-clips and slugs title safely", () => {
    const outputRoot = join("runs", "output");

    const outputDir = inferOutputDirFromMetadata(
      outputRoot,
      "  A <Great> / Video: Test?  ",
      "fallback-id",
    );

    expect(outputDir).toBe(join(outputRoot, "a-great-video-test", "final-clips"));
    expect(outputDir.endsWith(join("a-great-video-test", "final-clips"))).toBe(true);
  });

  test("toOutputFolderName avoids Windows reserved names", () => {
    const folderName = toOutputFolderName("CON", "AlphaBeta99");

    expect(folderName).toBe("con-alphabet");
    expect(folderName.startsWith("con-")).toBe(true);
  });

  test("toOutputFolderName sanitizes collision suffix and trims long base names", () => {
    expect(
      toOutputFolderName("Clip Name", "fallback123", {
        collisionSuffix: "  Batch #42 / nightly  ",
      }),
    ).toBe("clip-name-batch-42-nightly");

    const trimmedWithSuffix = toOutputFolderName("a".repeat(140), "fallback123", {
      collisionSuffix: "  Batch #42 / nightly  ",
    });

    expect(trimmedWithSuffix).toBe(`${"a".repeat(79)}-batch-42-nightly`);
    expect(trimmedWithSuffix.length).toBe(96);
  });

  test("extractVideoId prefers YouTube ids and falls back to local filename slug", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=31")).toBe(
      "dQw4w9WgXcQ",
    );

    expect(extractVideoId(join("clips", "My Local Clip!!.mp4"))).toBe("my-local-clip");
  });
});
