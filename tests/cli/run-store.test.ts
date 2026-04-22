import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import { CliRunStore } from "../../src/cli/run-store";

describe("cli run store", () => {
  test("creates, filters, and updates runs", () => {
    const workspace = createWorkspace();

    const store = new CliRunStore(workspace.dbPath);
    try {
      const first = store.createRun({
        profileId: "profile-a",
        sourceUrl: "https://example.com/a",
        displayTitle: "Run A",
      });
      const second = store.createRun({
        profileId: "profile-b",
        sourceUrl: "https://example.com/b",
        status: "running",
      });

      expect(first.status).toBe("pending");
      expect(second.status).toBe("running");

      const byProfile = store.listRuns({ profileId: "profile-a" });
      expect(byProfile).toHaveLength(1);
      expect(byProfile[0].id).toBe(first.id);

      const running = store.listRuns({ status: "running" });
      expect(running).toHaveLength(1);
      expect(running[0].id).toBe(second.id);

      const updated = store.updateRun(first.id, {
        status: "completed",
        pipelineRunId: "pipeline-1",
        outputDir: "./output/a",
        templateSnapshot: {
          youtubeDescriptionTemplate: "Template",
        },
      });

      expect(updated.status).toBe("completed");
      expect(updated.pipelineRunId).toBe("pipeline-1");
      expect(updated.outputDir).toBe("./output/a");
      expect(updated.templateSnapshot).toEqual({
        youtubeDescriptionTemplate: "Template",
      });
    } finally {
      store.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("upserts uploads and cascades delete", () => {
    const workspace = createWorkspace();

    const store = new CliRunStore(workspace.dbPath);
    try {
      const run = store.createRun({
        profileId: "profile-a",
        sourceUrl: "https://example.com/a",
      });

      store.recordEvent({
        runId: run.id,
        eventType: "run.created",
        message: "created",
      });

      store.upsertUpload({
        runId: run.id,
        platform: "youtube",
        clipPath: "./clip-1.mp4",
        status: "pending",
      });

      store.upsertUpload({
        runId: run.id,
        platform: "youtube",
        clipPath: "./clip-1.mp4",
        status: "uploaded",
        externalUploadId: "yt-123",
      });

      const uploads = store.listUploadsForRun(run.id);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].status).toBe("uploaded");
      expect(uploads[0].externalUploadId).toBe("yt-123");

      const deleted = store.deleteRunById(run.id);
      expect(deleted).toBe(true);
      expect(store.listUploadsForRun(run.id)).toHaveLength(0);
      expect(store.listEventsForRun(run.id)).toHaveLength(0);
    } finally {
      store.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("rejects duplicate run IDs", () => {
    const workspace = createWorkspace();

    const store = new CliRunStore(workspace.dbPath);
    try {
      store.createRun({
        id: "run-fixed",
        profileId: "profile-a",
        sourceUrl: "https://example.com/a",
      });

      expect(() =>
        store.createRun({
          id: "run-fixed",
          profileId: "profile-a",
          sourceUrl: "https://example.com/b",
        }),
      ).toThrow("Run already exists");
    } finally {
      store.close();
      cleanupWorkspace(workspace.root);
    }
  });
});

interface Workspace {
  root: string;
  dbPath: string;
}

function createWorkspace(): Workspace {
  const root = join(import.meta.dir, "__tmp_run_store__", crypto.randomUUID());
  mkdirSync(root, { recursive: true });

  return {
    root,
    dbPath: join(root, "run-store.db"),
  };
}

function cleanupWorkspace(root: string): void {
  if (!existsSync(root)) {
    return;
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows can keep sqlite-wal/sqlite-shm handles briefly after close; ignore cleanup race.
  }
}
