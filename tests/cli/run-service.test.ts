import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";

import { createCliProfile, loadCliProfileStore, saveCliProfileStore } from "../../src/cli/profile-store";
import { CliRunService } from "../../src/cli/run-service";
import { CliRunStore } from "../../src/cli/run-store";
import { CheckpointManager } from "../../src/pipeline/checkpoint";
import { PipelineStage } from "../../src/pipeline/types";

describe("cli run service", () => {
  test("creates a pending run using profile defaults", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });
      expect(run.status).toBe("pending");
      expect(run.sourceUrl).toBe("https://www.youtube.com/watch?v=abcdefghijk");

      const detail = service.getRunDetail(run.id);
      expect(detail.pipelineRun).toBeNull();
      expect(detail.clips).toHaveLength(0);
      expect(detail.nextActions).toContain(`runs start ${run.id}`);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("getRunDetail includes retry start action for failed runs without pipeline run id", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        status: "failed",
        lastError: "pipeline bootstrap failed",
      });
      runStore.close();

      const detail = service.getRunDetail(run.id);
      expect(detail.nextActions).toContain(`runs start ${run.id}`);
      expect(detail.nextActions).not.toContain(`runs resume ${run.id}`);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("resumeRun guidance points to runs start when pipeline run id is missing", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        status: "failed",
      });
      runStore.close();

      await expect(service.resumeRun(run.id)).rejects.toThrow(`runs start ${run.id}`);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });


  test("createRun preserves explicit display title", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const resolverCalls: string[] = [];
    const service = createRunService(workspace, async (sourceUrl) => {
      resolverCalls.push(sourceUrl);
      return buildResolvedMetadata("Resolved metadata title");
    });

    try {
      const run = await service.createRun({
        profileId: "profile-a",
        displayTitle: "Manual title",
      });

      expect(run.displayTitle).toBe("Manual title");
      expect(resolverCalls).toHaveLength(0);

      const payload = getRunCreatedPayload(workspace, run.id);
      expect(payload.displayTitleSource).toBe("input");
      expect(payload.displayTitleLookupError).toBeNull();
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("createRun resolves display title from metadata when title is omitted", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace, async () => buildResolvedMetadata("Resolved metadata title"));

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      expect(run.displayTitle).toBe("Resolved metadata title");

      const payload = getRunCreatedPayload(workspace, run.id);
      expect(payload.displayTitleSource).toBe("metadata");
      expect(payload.displayTitleLookupError).toBeNull();
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("createRun still queues run when metadata resolution fails", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace, async () => {
      throw new Error("metadata unavailable");
    });

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      expect(run.displayTitle).toBeNull();

      const payload = getRunCreatedPayload(workspace, run.id);
      expect(payload.displayTitleSource).toBe("none");
      expect(payload.displayTitleLookupError).toBe("metadata unavailable");
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });


  test("refreshes run status from checkpoint and exposes clip outputs", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      const checkpoint = new CheckpointManager(workspace.dbPath);
      const pipelineRun = checkpoint.createRun(
        "https://www.youtube.com/watch?v=abcdefghijk",
        "abcdefghijk",
        "Test Video",
      );
      checkpoint.startStage(pipelineRun.id, PipelineStage.DOWNLOAD);
      checkpoint.completeStage(pipelineRun.id, PipelineStage.DOWNLOAD, ["./data/abcdefghijk.mp4"], {
        filePath: "./data/abcdefghijk.mp4",
      });
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-1",
        0,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-1.mp4",
        },
      );
      checkpoint.markRunComplete(pipelineRun.id);
      checkpoint.close();

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        pipelineRunId: pipelineRun.id,
        status: "running",
      });
      runStore.close();

      const refreshed = service.refreshRunStatus(run.id);
      expect(refreshed.status).toBe("completed");

      const detail = service.getRunDetail(run.id);
      expect(detail.pipelineRun?.id).toBe(pipelineRun.id);
      expect(detail.clips).toHaveLength(1);
      expect(detail.clips[0].finalReelPath).toBe("./output/test/clip-1.mp4");
      expect(detail.clipCounts.completed).toBe(1);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("returns clear upload errors for runs without pipeline outputs", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      await expect(service.uploadRun(run.id, "all")).rejects.toThrow(
        "has no pipelineRunId",
      );

      const checkpoint = new CheckpointManager(workspace.dbPath);
      const pipelineRun = checkpoint.createRun(
        "https://www.youtube.com/watch?v=abcdefghijk",
        "abcdefghijk",
        "Test Video",
      );
      checkpoint.markRunComplete(pipelineRun.id);
      checkpoint.close();

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        pipelineRunId: pipelineRun.id,
        status: "completed",
      });
      runStore.close();

      await expect(service.uploadRun(run.id, "all")).rejects.toThrow(
        "has no clip outputs available for upload",
      );
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("deletes run entries", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });
      const deleted = service.deleteRun(run.id);
      expect(deleted).toBe(true);
      expect(service.getRunById(run.id)).toBeNull();
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });
});

describe("cli run service clip ordering", () => {
  test("prefers IDENTIFY_CLIPS ordering for run detail and upload targets", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      const checkpoint = new CheckpointManager(workspace.dbPath);
      const pipelineRun = checkpoint.createRun(
        "https://www.youtube.com/watch?v=abcdefghijk",
        "abcdefghijk",
        "Test Video",
      );
      checkpoint.startStage(pipelineRun.id, PipelineStage.IDENTIFY_CLIPS);
      checkpoint.completeStage(pipelineRun.id, PipelineStage.IDENTIFY_CLIPS, ["./data/abcdefghijk/clips.json"], [
        { id: "clip-a", title: "Clip A" },
        { id: "clip-b", title: "Clip B" },
        { id: "clip-c", title: "Clip C" },
      ]);
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-b",
        0,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-b.mp4",
        },
      );
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-a",
        0,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-a.mp4",
        },
      );
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-c",
        7,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-c.mp4",
        },
      );
      checkpoint.markRunComplete(pipelineRun.id);
      checkpoint.close();

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        pipelineRunId: pipelineRun.id,
        status: "completed",
      });
      runStore.close();

      const detail = service.getRunDetail(run.id);
      expect(detail.clips.map((clip) => clip.clipId)).toEqual(["clip-a", "clip-b", "clip-c"]);
      expect(detail.clips.map((clip) => clip.clipIndex)).toEqual([0, 1, 2]);

      const uploadTargets = (
        service as unknown as {
          collectClipOutputs: (pipelineRunId: string) => Array<{
            clipId: string;
            clipIndex: number;
            filePath: string;
          }>;
        }
      ).collectClipOutputs(pipelineRun.id);

      expect(uploadTargets.map((clip) => clip.clipId)).toEqual(["clip-a", "clip-b", "clip-c"]);
      expect(uploadTargets.map((clip) => clip.clipIndex)).toEqual([0, 1, 2]);
      expect(uploadTargets.map((clip) => clip.filePath)).toEqual([
      	resolve("./output/test/clip-a.mp4"),
      	resolve("./output/test/clip-b.mp4"),
      	resolve("./output/test/clip-c.mp4"),
      ]);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("falls back to stored clip indexes when IDENTIFY_CLIPS data is malformed", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      const checkpoint = new CheckpointManager(workspace.dbPath);
      const pipelineRun = checkpoint.createRun(
        "https://www.youtube.com/watch?v=abcdefghijk",
        "abcdefghijk",
        "Test Video",
      );
      checkpoint.startStage(pipelineRun.id, PipelineStage.IDENTIFY_CLIPS);
      checkpoint.completeStage(
        pipelineRun.id,
        PipelineStage.IDENTIFY_CLIPS,
        ["./data/abcdefghijk/clips.json"],
        { clips: [{ id: "clip-b" }, { id: "clip-a" }] },
      );
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-b",
        3,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-b.mp4",
        },
      );
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-a",
        1,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-a.mp4",
        },
      );
      checkpoint.markRunComplete(pipelineRun.id);
      checkpoint.close();

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        pipelineRunId: pipelineRun.id,
        status: "completed",
      });
      runStore.close();

      const detail = service.getRunDetail(run.id);
      expect(detail.clips.map((clip) => clip.clipId)).toEqual(["clip-a", "clip-b"]);
      expect(detail.clips.map((clip) => clip.clipIndex)).toEqual([1, 3]);

      const uploadTargets = (
        service as unknown as {
          collectClipOutputs: (pipelineRunId: string) => Array<{
            clipId: string;
            clipIndex: number;
            filePath: string;
          }>;
        }
      ).collectClipOutputs(pipelineRun.id);

      expect(uploadTargets.map((clip) => clip.clipId)).toEqual(["clip-a", "clip-b"]);
      expect(uploadTargets.map((clip) => clip.clipIndex)).toEqual([1, 3]);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });
});

describe("cli run service stage summary and upload filters", () => {
  test("derives clip stage summaries from clip progress when stage rows are missing", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const run = await service.createRun({ profileId: "profile-a" });

      const checkpoint = new CheckpointManager(workspace.dbPath);
      const pipelineRun = checkpoint.createRun(
        "https://www.youtube.com/watch?v=abcdefghijk",
        "abcdefghijk",
        "Test Video",
      );
      checkpoint.startStage(pipelineRun.id, PipelineStage.IDENTIFY_CLIPS);
      checkpoint.completeStage(pipelineRun.id, PipelineStage.IDENTIFY_CLIPS, ["./data/abcdefghijk/clips.json"], [
        { id: "clip-a", title: "Clip A" },
        { id: "clip-b", title: "Clip B" },
      ]);
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-a",
        0,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          finalReelPath: "./output/test/clip-a.mp4",
        },
      );
      checkpoint.updateClipProgress(
        pipelineRun.id,
        "clip-b",
        1,
        PipelineStage.COMPOSE_REEL,
        "in_progress",
        {
          extractedVideoPath: "./output/test/clip-b-extracted.mp4",
          silenceRemovedPath: "./output/test/clip-b-clean.mp4",
          captionOverlayPath: "./output/test/clip-b-caption.webm",
        },
      );
      checkpoint.close();

      const runStore = new CliRunStore(workspace.dbPath);
      runStore.updateRun(run.id, {
        pipelineRunId: pipelineRun.id,
        status: "running",
      });
      runStore.close();

      const detail = service.getRunDetail(run.id);
      const stageByName = new Map(detail.stages.map((stage) => [stage.stage, stage]));
      expect(stageByName.get(PipelineStage.EXTRACT_CLIPS)?.status).toBe("completed");
      expect(stageByName.get(PipelineStage.REMOVE_SILENCE)?.status).toBe("completed");
      expect(stageByName.get(PipelineStage.GENERATE_CAPTIONS)?.status).toBe("completed");
      expect(stageByName.get(PipelineStage.COMPOSE_REEL)?.status).toBe("in_progress");
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });

  test("selectClipOutputsForUpload applies index filters and max caps", async () => {
    const workspace = createWorkspace();

    await createProfileFixture({
      profilesPath: workspace.profilesPath,
      id: "profile-a",
      defaultSourceUrl: "https://www.youtube.com/watch?v=abcdefghijk",
    });

    const service = createRunService(workspace);

    try {
      const selected = (
        service as unknown as {
          selectClipOutputsForUpload: (
            clipOutputs: Array<{
              clipId: string;
              clipIndex: number;
              clipTitle: string | null;
              filePath: string;
            }>,
            options: {
              clipIndexes?: number[];
              maxClips?: number;
            },
          ) => Array<{ clipIndex: number }>;
        }
      ).selectClipOutputsForUpload(
        [
          { clipId: "clip-a", clipIndex: 0, clipTitle: "Clip A", filePath: "a.mp4" },
          { clipId: "clip-b", clipIndex: 1, clipTitle: "Clip B", filePath: "b.mp4" },
          { clipId: "clip-c", clipIndex: 2, clipTitle: "Clip C", filePath: "c.mp4" },
        ],
        { clipIndexes: [2, 0, 1], maxClips: 2 },
      );

      expect(selected.map((clip) => clip.clipIndex)).toEqual([0, 1]);
    } finally {
      service.close();
      cleanupWorkspace(workspace.root);
    }
  });
});

interface Workspace {
  root: string;
  profilesPath: string;
  dbPath: string;
}

interface ProfileFixtureInput {
  profilesPath: string;
  id: string;
  defaultSourceUrl: string;
}

type MetadataResolver = (sourceUrl: string) => Promise<{
  videoId: string;
  title: string;
  duration: number;
  uploadDate: string;
}>;

function createRunService(
  workspace: Workspace,
  resolveVideoMetadata: MetadataResolver = async () => buildResolvedMetadata(),
): CliRunService {
  return new CliRunService({
    checkpointDbPath: workspace.dbPath,
    profilesFilePath: workspace.profilesPath,
    resolveVideoMetadata,
  });
}

function buildResolvedMetadata(title = "Resolved title from metadata"): {
  videoId: string;
  title: string;
  duration: number;
  uploadDate: string;
} {
  return {
    videoId: "resolved-video-id",
    title,
    duration: 120,
    uploadDate: "20240101",
  };
}

function getRunCreatedPayload(workspace: Workspace, runId: string): Record<string, unknown> {
  const runStore = new CliRunStore(workspace.dbPath);
  try {
    const createdEvent = runStore
      .listEventsForRun(runId)
      .find((event) => event.eventType === "run.created");
    if (!createdEvent || !isRecord(createdEvent.payload)) {
      throw new Error("run.created payload missing");
    }

    return createdEvent.payload;
  } finally {
    runStore.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}


function createWorkspace(): Workspace {
  const root = join(import.meta.dir, "__tmp_run_service__", crypto.randomUUID());
  mkdirSync(root, { recursive: true });

  return {
    root,
    profilesPath: join(root, "profiles.json"),
    dbPath: join(root, "checkpoints.db"),
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

async function createProfileFixture(input: ProfileFixtureInput): Promise<void> {
  const store = await loadCliProfileStore(input.profilesPath);
  createCliProfile(store, {
    id: input.id,
    creatorName: "Creator",
    creditName: "Credit",
    defaultSourceUrl: input.defaultSourceUrl,
    outputDir: "./output/test",
    oauthFilePath: "./data/youtube-oauth.json",
    uploadMode: "manual",
    uploadToYouTube: true,
    uploadToTikTok: false,
    uploadToInstagram: false,
  });

  await saveCliProfileStore(store, input.profilesPath);
}
