import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

import type { Config } from "../../src/config";
import { CheckpointManager } from "../../src/pipeline/checkpoint";
import { PipelineOrchestrator } from "../../src/pipeline/orchestrator";
import { PipelineStage } from "../../src/pipeline/types";

function createTestConfig(tmpRoot: string): Config {
  return {
    clipIdentifierProvider: "copilot",
    geminiApiKey: "test-key",
    copilotModel: "gpt-4.1",
    copilotModelFallbacks: ["gpt-5.3-codex", "gpt-5", "gpt-4.1"],
    copilotSingleRequestMode: true,
    clipIdentifierRetryAttempts: 4,
    clipIdentifierRetryBaseDelayMs: 1000,
    clipIdentifierRetryMaxDelayMs: 10_000,
    whisperModel: "base",
    maxParallelClips: 1,
    silenceThresholdDb: -35,
    silenceMinDuration: 0.8,
    outputWidth: 1080,
    outputHeight: 1920,
    clipMinDurationSec: 20,
    clipMaxDurationSec: 30,
    clipSpeed: 1.2,
    maxClips: 0,
    preferYouTubeTranscripts: true,
    captionAnimate: true,
    paths: {
      data: join(tmpRoot, "data"),
      output: join(tmpRoot, "output"),
      assets: join(tmpRoot, "assets"),
      subwaySurfers: join(tmpRoot, "assets", "subway-surfers"),
      checkpointDb: join(tmpRoot, "checkpoints.db"),
    },
  };
}

function cleanupTmpRoot(tmpRoot: string): void {
    try {
        rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
        // SQLite WAL files can remain briefly locked on Windows after close.
    }
}

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


describe("PipelineOrchestrator.run", () => {
    test("reports the run id before stage execution", async () => {
        const tmpRoot = join(import.meta.dir, "__tmp_run_created__", crypto.randomUUID());
        rmSync(tmpRoot, { recursive: true, force: true });
        mkdirSync(tmpRoot, { recursive: true });

        const config = createTestConfig(tmpRoot);
        const checkpoint = new CheckpointManager(config.paths.checkpointDb);
        const orchestrator = new PipelineOrchestrator(config, checkpoint);
        let createdRunId: string | null = null;

        try {
            await expect(
                orchestrator.run("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
                    sourceMode: "youtube_url",
                    onRunCreated: (runId: string): void => {
                        createdRunId = runId;
                        throw new Error("stop-after-run-created");
                    },
                }),
            ).rejects.toThrow("stop-after-run-created");

            expect(createdRunId).not.toBeNull();
            if (!createdRunId) {
                throw new Error("run id callback was not invoked.");
            }

            const runInfo = checkpoint.getRunInfo(createdRunId);
            expect(runInfo).not.toBeNull();
            expect(runInfo?.status).toBe("failed");

            const downloadResult = checkpoint.getStageResult(createdRunId, PipelineStage.DOWNLOAD);
            expect(downloadResult).toBeNull();
        } finally {
            checkpoint.close();
            cleanupTmpRoot(tmpRoot);
        }
    });
});

describe("PipelineOrchestrator.resume", () => {
    test("preserves canonical clip indexes for remaining clips", async () => {
        const tmpRoot = join(import.meta.dir, "__tmp_resume_clip_index__", crypto.randomUUID());
        rmSync(tmpRoot, { recursive: true, force: true });
        mkdirSync(tmpRoot, { recursive: true });

        const config = createTestConfig(tmpRoot);
        const checkpoint = new CheckpointManager(config.paths.checkpointDb);
        const orchestrator = new PipelineOrchestrator(config, checkpoint);

        const metadata = {
            videoId: "abcdefghijk",
            title: "Test Video",
            duration: 120,
            uploadDate: "20240101",
            filePath: join(tmpRoot, "data", "source.mp4"),
        };
        const transcript = {
            source: "whisper" as const,
            language: "en",
            segments: [],
            fullText: "",
            srtPath: null,
        };
        const clips = [
            {
                id: "clip-a",
                title: "Clip A",
                hookLine: "hook-a",
                startTime: 0,
                endTime: 20,
                duration: 20,
                reasoning: "reason-a",
                viralScore: 90,
                tags: ["tag-a"],
            },
            {
                id: "clip-b",
                title: "Clip B",
                hookLine: "hook-b",
                startTime: 20,
                endTime: 40,
                duration: 20,
                reasoning: "reason-b",
                viralScore: 80,
                tags: ["tag-b"],
            },
            {
                id: "clip-c",
                title: "Clip C",
                hookLine: "hook-c",
                startTime: 40,
                endTime: 60,
                duration: 20,
                reasoning: "reason-c",
                viralScore: 70,
                tags: ["tag-c"],
            },
        ];

        const run = checkpoint.createRun(
            "https://www.youtube.com/watch?v=abcdefghijk",
            "abcdefghijk",
            "Test Video",
        );
        checkpoint.startStage(run.id, PipelineStage.DOWNLOAD);
        checkpoint.completeStage(run.id, PipelineStage.DOWNLOAD, [metadata.filePath], metadata);
        checkpoint.startStage(run.id, PipelineStage.TRANSCRIBE);
        checkpoint.completeStage(run.id, PipelineStage.TRANSCRIBE, [], transcript);
        checkpoint.startStage(run.id, PipelineStage.IDENTIFY_CLIPS);
        checkpoint.completeStage(run.id, PipelineStage.IDENTIFY_CLIPS, ["./data/abcdefghijk/clips.json"], clips);
        checkpoint.updateClipProgress(
            run.id,
            "clip-a",
            0,
            PipelineStage.COMPOSE_REEL,
            "completed",
            {
                finalReelPath: join(tmpRoot, "output", "clip-a.mp4"),
            },
        );

        const observedIndexes = new Map<string, number>();
        const orchestratorWithTestHooks = orchestrator as unknown as {
            captionGenerator: { warmup: () => Promise<void> };
            processOneClip: (
                runId: string,
                clip: { id: string },
                clipIndex: number,
                metadata: unknown,
                dir: string,
                outputDir: string,
            ) => Promise<void>;
        };

        orchestratorWithTestHooks.captionGenerator = {
            warmup: async (): Promise<void> => {},
        };
        orchestratorWithTestHooks.processOneClip = async (
            resumeRunId: string,
            clip: { id: string },
            clipIndex: number,
        ): Promise<void> => {
            observedIndexes.set(clip.id, clipIndex);
            checkpoint.updateClipProgress(
                resumeRunId,
                clip.id,
                clipIndex,
                PipelineStage.COMPOSE_REEL,
                "completed",
                {
                    finalReelPath: join(tmpRoot, "output", `${clip.id}.mp4`),
                },
            );
        };

        try {
            await orchestrator.resume(run.id);

            expect(observedIndexes.get("clip-b")).toBe(1);
            expect(observedIndexes.get("clip-c")).toBe(2);

            const clipProgress = checkpoint.getRunClipProgress(run.id);
            const clipIndexById = new Map(clipProgress.map((clip) => [clip.clipId, clip.clipIndex]));
            expect(clipIndexById.get("clip-a")).toBe(0);
            expect(clipIndexById.get("clip-b")).toBe(1);
            expect(clipIndexById.get("clip-c")).toBe(2);
            expect(checkpoint.getRunInfo(run.id)?.status).toBe("completed");
        } finally {
            checkpoint.close();
            cleanupTmpRoot(tmpRoot);
        }
    });
});