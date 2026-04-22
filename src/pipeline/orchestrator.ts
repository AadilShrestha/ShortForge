import { createLogger } from "../utils/logger";
import { runDir, ensureDir } from "../utils/fs";
import { CheckpointManager } from "./checkpoint";
import { PipelineStage, StageStatus } from "./types";
import type { Config } from "../config";
import type { VideoMetadata, Transcript, ClipCandidate, ClipArtifacts } from "./types";
import { Downloader, type DownloadSourceMode } from "../modules/downloader";
import { Transcriber } from "../modules/transcriber";
import { ClipIdentifier } from "../modules/clip-identifier";
import { VideoProcessor } from "../modules/video-processor";
import { CaptionGenerator } from "../modules/caption-generator";
import { join } from "path";

const log = createLogger("orchestrator");

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
      const next = this.queue.shift()!;
      next();
    } else {
      this.count++;
    }
  }
}

type RunCreatedHandler = (runId: string) => void | Promise<void>;

interface PipelineRunOptions {
  sourceMode?: DownloadSourceMode;
  onRunCreated?: RunCreatedHandler;
}

export class PipelineOrchestrator {
  private checkpoint: CheckpointManager;
  private config: Config;
  private downloader = new Downloader();
  private transcriber = new Transcriber();
  private clipIdentifier: ClipIdentifier;
  private videoProcessor = new VideoProcessor();
  private captionGenerator = new CaptionGenerator();

  constructor(config: Config, checkpoint: CheckpointManager) {
    this.config = config;
    this.checkpoint = checkpoint;
    this.clipIdentifier = new ClipIdentifier(config);
  }

  async run(sourceInput: string, options?: PipelineRunOptions, _fromStage?: PipelineStage): Promise<string> {
    const sourceMode = options?.sourceMode ?? this.inferSourceMode(sourceInput);
    const videoId = this.extractVideoId(sourceInput);
    const run = this.checkpoint.createRun(sourceInput, videoId, "");
    const dir = runDir(this.config.paths.data, run.id);

    log.info(`Pipeline started: ${run.id}`);
    log.info(`Source (${sourceMode}): ${sourceInput}`);

    try {
      if (options?.onRunCreated) {
        await options.onRunCreated(run.id);
      }

      const metadata = await this.stageDownload(run.id, sourceInput, sourceMode, dir);
      const transcript = await this.stageTranscribe(run.id, metadata, dir);
      let clips = await this.stageIdentifyClips(run.id, transcript, metadata, dir);
      if (this.config.maxClips > 0) {
        clips = clips.slice(0, this.config.maxClips);
        log.info(`Limiting to ${clips.length} clips (maxClips=${this.config.maxClips})`);
      }
      await this.processClips(run.id, clips, metadata, dir);
      this.checkpoint.markRunComplete(run.id);
      log.info(`Pipeline completed: ${run.id}`);
    } catch (err) {
      log.error(`Pipeline failed: ${err}`);
      this.checkpoint.markRunFailed(run.id);
      throw err;
    }

    return run.id;
  }

  async resume(runId: string): Promise<void> {
    const run = this.checkpoint.getRunInfo(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    log.info(`Resuming pipeline: ${runId}`);
    const dir = runDir(this.config.paths.data, runId);
    const sourceMode = this.inferSourceMode(run.videoUrl);

    try {
      let metadata: VideoMetadata;
      const dlResult = this.checkpoint.getStageResult<VideoMetadata>(runId, PipelineStage.DOWNLOAD);
      if (dlResult?.status === StageStatus.COMPLETED) {
        metadata = dlResult.data;
        log.info("Skipping DOWNLOAD (completed)");
      } else {
        metadata = await this.stageDownload(runId, run.videoUrl, sourceMode, dir);
      }

      let transcript: Transcript;
      const txResult = this.checkpoint.getStageResult<Transcript>(runId, PipelineStage.TRANSCRIBE);
      if (txResult?.status === StageStatus.COMPLETED) {
        transcript = txResult.data;
        log.info("Skipping TRANSCRIBE (completed)");
      } else {
        transcript = await this.stageTranscribe(runId, metadata, dir);
      }

      let clips: ClipCandidate[];
      const idResult = this.checkpoint.getStageResult<ClipCandidate[]>(
        runId,
        PipelineStage.IDENTIFY_CLIPS,
      );
      if (idResult?.status === StageStatus.COMPLETED) {
        clips = idResult.data;
        log.info("Skipping IDENTIFY_CLIPS (completed)");
      } else {
        clips = await this.stageIdentifyClips(runId, transcript, metadata, dir);
      }

      const clipIndexById = new Map<string, number>(
        clips.map((clip, index) => [clip.id, index]),
      );
      const completedIds = new Set(this.checkpoint.getCompletedClipIds(runId));
      const remainingClips = clips.filter((c) => !completedIds.has(c.id));

      if (remainingClips.length === 0) {
        log.info("All clips already processed");
      } else {
        log.info(`Resuming ${remainingClips.length}/${clips.length} clips`);
        await this.processClips(runId, remainingClips, metadata, dir, clipIndexById);
      }

      this.checkpoint.markRunComplete(runId);
      log.info(`Pipeline resumed and completed: ${runId}`);
    } catch (err) {
      log.error(`Resume failed: ${err}`);
      this.checkpoint.markRunFailed(runId);
      throw err;
    }
  }

  private async stageDownload(
    runId: string,
    sourceInput: string,
    sourceMode: DownloadSourceMode,
    dir: string,
  ): Promise<VideoMetadata> {
    this.checkpoint.startStage(runId, PipelineStage.DOWNLOAD);
    const downloadDir = join(dir, "downloads");
    const metadata = await this.downloader.downloadFromSource(sourceInput, downloadDir, sourceMode);
    this.checkpoint.completeStage(runId, PipelineStage.DOWNLOAD, [metadata.filePath], metadata);
    return metadata;
  }

  private async stageTranscribe(
    runId: string,
    metadata: VideoMetadata,
    dir: string,
  ): Promise<Transcript> {
    this.checkpoint.startStage(runId, PipelineStage.TRANSCRIBE);
    const transcriptDir = join(dir, "transcripts");
    const transcript = await this.transcriber.transcribe(metadata, transcriptDir, this.config);
    this.checkpoint.completeStage(
      runId,
      PipelineStage.TRANSCRIBE,
      [transcript.srtPath ?? ""],
      transcript,
    );
    return transcript;
  }

  private async stageIdentifyClips(
    runId: string,
    transcript: Transcript,
    metadata: VideoMetadata,
    dir: string,
  ): Promise<ClipCandidate[]> {
    this.checkpoint.startStage(runId, PipelineStage.IDENTIFY_CLIPS);
    const clips = await this.clipIdentifier.identify(transcript, metadata);
    const clipsPath = join(dir, "clips.json");
    await Bun.write(clipsPath, JSON.stringify(clips, null, 2));
    this.checkpoint.completeStage(runId, PipelineStage.IDENTIFY_CLIPS, [clipsPath], clips);
    log.info(`Identified ${clips.length} clips`);
    return clips;
  }

  private async processClips(
    runId: string,
    clips: ClipCandidate[],
    metadata: VideoMetadata,
    dir: string,
    clipIndexById?: ReadonlyMap<string, number>,
  ): Promise<void> {
    const semaphore = new Semaphore(this.config.maxParallelClips);
    const outputDir = join(this.config.paths.output, metadata.videoId);
    ensureDir(outputDir);

    await this.captionGenerator.warmup();

    log.info(`Processing ${clips.length} clips (parallel: ${this.config.maxParallelClips})`);

    const results = await Promise.allSettled(
      clips.map(async (clip, index) => {
        const canonicalClipIndex = clipIndexById?.get(clip.id) ?? index;

        await semaphore.acquire();
        try {
          log.info(`[${index + 1}/${clips.length}] Processing: "${clip.title}"`);
          await this.processOneClip(runId, clip, canonicalClipIndex, metadata, dir, outputDir);
          log.info(`[${index + 1}/${clips.length}] Completed: "${clip.title}"`);
        } finally {
          semaphore.release();
        }
      }),
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      log.warn(`${failed.length}/${clips.length} clips failed`);
      for (const f of failed) {
        if (f.status === "rejected") log.error(`  ${f.reason}`);
      }
    }

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    log.info(`${succeeded}/${clips.length} clips processed successfully`);
  }

  private async processOneClip(
    runId: string,
    clip: ClipCandidate,
    clipIndex: number,
    metadata: VideoMetadata,
    dir: string,
    outputDir: string,
  ): Promise<ClipArtifacts> {
    const artifacts: Partial<ClipArtifacts> = { clipId: clip.id };
    const progress = this.checkpoint.getClipProgress(runId, clip.id);

    // Extract
    if (progress?.artifactPaths?.extractedVideoPath) {
      artifacts.extractedVideoPath = progress.artifactPaths.extractedVideoPath;
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "in_progress",
        {},
      );
      artifacts.extractedVideoPath = await this.videoProcessor.extractClip(
        metadata.filePath,
        clip,
        join(dir, "clips"),
      );
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.EXTRACT_CLIPS,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
        },
      );
    }

    // Remove silence
    if (progress?.artifactPaths?.silenceRemovedPath) {
      artifacts.silenceRemovedPath = progress.artifactPaths.silenceRemovedPath;
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.REMOVE_SILENCE,
        "in_progress",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
        },
      );
      const desilencedPath = join(dir, "desilenced", `${clip.id}_clean.mp4`);
      const result = await this.videoProcessor.removeSilence(
        artifacts.extractedVideoPath,
        desilencedPath,
        this.config,
      );
      artifacts.silenceRemovedPath = result.path;
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.REMOVE_SILENCE,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
        },
      );
    }

    // Generate captions
    if (progress?.artifactPaths?.captionOverlayPath) {
      artifacts.captionOverlayPath = progress.artifactPaths.captionOverlayPath;
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.GENERATE_CAPTIONS,
        "in_progress",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
        },
      );

      const overlayPath = join(dir, "captions", `${clip.id}_captions.webm`);
      artifacts.captionOverlayPath = await this.captionGenerator.generate(
        artifacts.silenceRemovedPath,
        overlayPath,
        this.config,
      );

      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.GENERATE_CAPTIONS,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath,
        },
      );
    }

    // Compose reel
    if (progress?.artifactPaths?.finalReelPath) {
      artifacts.finalReelPath = progress.artifactPaths.finalReelPath;
    } else {
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.COMPOSE_REEL,
        "in_progress",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath,
        },
      );
      const reelFilename = this.buildReadableReelFilename(clip, clipIndex);
      const reelPath = join(outputDir, reelFilename);
      artifacts.finalReelPath = await this.videoProcessor.composeReel(
        artifacts.silenceRemovedPath,
        this.config,
        reelPath,
        artifacts.captionOverlayPath,
      );
      this.checkpoint.updateClipProgress(
        runId,
        clip.id,
        clipIndex,
        PipelineStage.COMPOSE_REEL,
        "completed",
        {
          extractedVideoPath: artifacts.extractedVideoPath,
          silenceRemovedPath: artifacts.silenceRemovedPath,
          captionOverlayPath: artifacts.captionOverlayPath,
          finalReelPath: artifacts.finalReelPath,
        },
      );
    }

    return artifacts as ClipArtifacts;
  }

  private buildReadableReelFilename(clip: ClipCandidate, clipIndex: number): string {
    const prefix = String(clipIndex + 1).padStart(2, "0");
    const slug = clip.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70);

    const safeSlug = slug.length > 0 ? slug : "clip";
    return `${prefix}-${safeSlug}.mp4`;
  }

  private inferSourceMode(sourceInput: string): DownloadSourceMode {
    const normalizedSource = sourceInput.trim().toLowerCase();
    if (normalizedSource.startsWith("http://") || normalizedSource.startsWith("https://")) {
      return "youtube_url";
    }

    return "local_video";
  }


  private extractVideoId(url: string): string {
    const match = url.match(/(?:v=|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match?.[1] ?? url.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
  }
}
