import { describe, test, expect, afterEach } from "bun:test";
import { rmSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import {
  ensureDir,
  runDir,
  fileExists,
  listFiles,
  randomItem,
  cleanRunArtifacts,
} from "../../src/utils/fs";

const TMP = join(import.meta.dir, "__tmp_fs__");

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("ensureDir", () => {
  test("creates nested directories", () => {
    const nested = join(TMP, "a", "b", "c");
    ensureDir(nested);
    expect(existsSync(nested)).toBe(true);
  });

  test("is idempotent", () => {
    ensureDir(TMP);
    ensureDir(TMP);
    expect(existsSync(TMP)).toBe(true);
  });
});

describe("runDir", () => {
  test("creates run subdirectories", () => {
    const dir = runDir(TMP, "test-run");
    expect(dir).toBe(join(TMP, "runs", "test-run"));
    for (const sub of ["downloads", "clips", "desilenced", "captions", "transcripts"]) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
  });
});

describe("fileExists", () => {
  test("returns true for existing file", async () => {
    ensureDir(TMP);
    const fp = join(TMP, "exists.txt");
    writeFileSync(fp, "hello");
    expect(await fileExists(fp)).toBe(true);
  });

  test("returns false for non-existing file", async () => {
    expect(await fileExists(join(TMP, "nope.txt"))).toBe(false);
  });
});

describe("listFiles", () => {
  test("lists all files", () => {
    ensureDir(TMP);
    writeFileSync(join(TMP, "a.txt"), "");
    writeFileSync(join(TMP, "b.mp4"), "");
    writeFileSync(join(TMP, "c.txt"), "");
    const files = listFiles(TMP);
    expect(files.length).toBe(3);
  });

  test("filters by extension", () => {
    ensureDir(TMP);
    writeFileSync(join(TMP, "a.txt"), "");
    writeFileSync(join(TMP, "b.mp4"), "");
    const files = listFiles(TMP, ".mp4");
    expect(files.length).toBe(1);
    expect(files[0]).toEndWith("b.mp4");
  });

  test("returns empty for non-existing dir", () => {
    expect(listFiles("/nonexistent/dir")).toEqual([]);
  });
});

describe("randomItem", () => {
  test("returns an element from the array", () => {
    const arr = [1, 2, 3, 4, 5];
    const item = randomItem(arr);
    expect(arr).toContain(item);
  });

  test("works with single element", () => {
    expect(randomItem(["only"])).toBe("only");
  });
});

describe("cleanRunArtifacts", () => {
  test("removes entire run dir when keepFinal=false", () => {
    const dir = runDir(TMP, "clean-test");
    writeFileSync(join(dir, "downloads", "video.mp4"), "");
    cleanRunArtifacts(TMP, "clean-test", false);
    expect(existsSync(join(TMP, "runs", "clean-test"))).toBe(false);
  });

  test("keeps transcripts when keepFinal=true", () => {
    const dir = runDir(TMP, "keep-test");
    writeFileSync(join(dir, "downloads", "video.mp4"), "");
    writeFileSync(join(dir, "transcripts", "t.srt"), "");
    cleanRunArtifacts(TMP, "keep-test", true);
    expect(existsSync(join(dir, "transcripts"))).toBe(true);
    expect(existsSync(join(dir, "downloads"))).toBe(false);
  });

  test("no-op for non-existing run", () => {
    cleanRunArtifacts(TMP, "nope", false);
  });
});
