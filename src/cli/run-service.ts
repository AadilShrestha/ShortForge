import { basename, dirname, extname, resolve } from "path";

import { loadConfig } from "../config";
import { Downloader, type RemoteVideoMetadata } from "../modules/downloader";
import { uploadInstagramReels } from "../modules/instagram-uploader";
import { uploadTikTokVideos } from "../modules/tiktok-uploader";
import { uploadYouTubeShorts } from "../modules/youtube-uploader";
import { CheckpointManager } from "../pipeline/checkpoint";
import type { ClipProgressSnapshot } from "../pipeline/checkpoint";
import { PipelineOrchestrator } from "../pipeline/orchestrator";
import {
  CLIP_STAGES,
  PipelineStage,
  StageStatus,
  type PipelineRun,
  type StageResult,
} from "../pipeline/types";
import { cleanRunArtifacts, ensureDir } from "../utils/fs";
import {
  getCliProfileById,
  loadCliProfileStore,
  type CliProfile,
} from "./profile-store";
import {
  CliRunStore,
  type CliRun,
  type CliRunStatus,
  type CliRunUpload,
  type ListCliRunsFilter,
  type UploadPlatform,
} from "./run-store";

const defaultCheckpointDbPath = "./data/checkpoints.db";

type RunUploadSelection = UploadPlatform | "all";

export type UploadTitleSource = "default" | "clip_title" | "filename";

export interface RunUploadClipOverride {
  clipIndex: number;
  title?: string | null;
  description?: string | null;
}

export interface RunUploadOptions {
  clipIndexes?: number[];
  randomCount?: number;
  maxClips?: number;
  titleSource?: UploadTitleSource;
  sharedDescription?: string | null;
  clipOverrides?: RunUploadClipOverride[];
}
type StageStatusView = StageStatus | "not_started";
type ResolveVideoMetadata = (sourceUrl: string) => Promise<RemoteVideoMetadata>;

interface DisplayTitleResolution {
  displayTitle: string | null;
  source: "input" | "metadata" | "none";
  lookupError: string | null;
}

interface RunTemplateSnapshot {
  youtubeDescriptionTemplate: string | null;
  tiktokCaptionTemplate: string | null;
  instagramCaptionTemplate: string | null;
}

export interface RunTemplateOverrides {
  youtubeDescriptionTemplate?: string | null;
  tiktokCaptionTemplate?: string | null;
  instagramCaptionTemplate?: string | null;
}

export interface CreateRunInput {
  profileId: string;
  sourceUrl?: string | null;
  displayTitle?: string | null;
  templateOverrides?: RunTemplateOverrides;
}

export interface DeleteRunOptions {
  deleteArtifacts?: boolean;
  deleteFinalOutput?: boolean;
}

export interface RunExecutionResult {
  runId: string;
  success: boolean;
  run: CliRun | null;
  error: string | null;
}

export interface RunStageSummary {
  stage: PipelineStage;
  status: StageStatusView;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface RunClipSummary {
  clipId: string;
  clipIndex: number;
  stage: PipelineStage;
  status: string;
  finalReelPath: string | null;
  updatedAt: string;
}

export interface RunDetail {
  run: CliRun;
  pipelineRun: PipelineRun | null;
  stages: RunStageSummary[];
  clips: RunClipSummary[];
  uploads: CliRunUpload[];
  clipCounts: {
    total: number;
    completed: number;
    failed: number;
  };
  nextActions: string[];
}

export interface CliRunServiceOptions {
  checkpointDbPath?: string;
  profilesFilePath?: string;
  runStore?: CliRunStore;
  resolveVideoMetadata?: ResolveVideoMetadata;
}

export class CliRunService {
  private checkpointDbPath: string;
  private profilesFilePath?: string;
  private runStore: CliRunStore;
  private ownsRunStore: boolean;
  private resolveVideoMetadata: ResolveVideoMetadata;

  constructor(options: CliRunServiceOptions = {}) {
    this.checkpointDbPath = resolveCheckpointDbPath(options.checkpointDbPath);
    this.profilesFilePath = options.profilesFilePath;

    if (options.resolveVideoMetadata) {
      this.resolveVideoMetadata = options.resolveVideoMetadata;
    } else {
      const downloader = new Downloader();
      this.resolveVideoMetadata = (sourceUrl) => downloader.fetchVideoMetadata(sourceUrl);
    }

    ensureDir(dirname(this.checkpointDbPath));

    if (options.runStore) {
      this.runStore = options.runStore;
      this.ownsRunStore = false;
    } else {
      this.runStore = new CliRunStore(this.checkpointDbPath);
      this.ownsRunStore = true;
    }
  }

  close(): void {
    if (this.ownsRunStore) {
      this.runStore.close();
    }
  }

  listRuns(filter: ListCliRunsFilter = {}): CliRun[] {
    return this.runStore.listRuns(filter);
  }

  getRunById(runId: string): CliRun | null {
    return this.runStore.getRunById(runId);
  }

  getRunDetail(runId: string): RunDetail {
    const run = this.refreshRunStatus(runId);
    const uploads = this.runStore.listUploadsForRun(run.id);

    if (!run.pipelineRunId) {
      return {
        run,
        pipelineRun: null,
        stages: Object.values(PipelineStage).map((stage) => ({
          stage,
          status: "not_started",
          startedAt: null,
          completedAt: null,
          error: null,
        })),
        clips: [],
        uploads,
        clipCounts: {
          total: 0,
          completed: 0,
          failed: 0,
        },
        nextActions: this.buildNextActions(run),
      };
    }

    const pipelineData = this.withCheckpoint((checkpoint) => {
      const pipelineRunId = run.pipelineRunId!;
      const pipelineRun = checkpoint.getRunInfo(pipelineRunId);
      const canonicalClipIndexById = buildCanonicalClipIndexById(checkpoint, pipelineRunId);
      const orderedClipProgress = getOrderedClipProgress(
        checkpoint.getRunClipProgress(pipelineRunId),
        canonicalClipIndexById,
      );
      const clips = orderedClipProgress.map((clip) => toClipSummary(clip));
      const stages = buildStageSummaries(checkpoint, pipelineRunId, orderedClipProgress);

      return {
        pipelineRun,
        stages,
        clips,
      };
    });

    return {
      run,
      pipelineRun: pipelineData.pipelineRun,
      stages: pipelineData.stages,
      clips: pipelineData.clips,
      uploads,
      clipCounts: {
        total: pipelineData.clips.length,
        completed: pipelineData.clips.filter((clip) => clip.status === "completed").length,
        failed: pipelineData.clips.filter((clip) => clip.status === "failed").length,
      },
      nextActions: this.buildNextActions(run),
    };
  }

  async createRun(input: CreateRunInput): Promise<CliRun> {
    const profile = await this.requireProfile(input.profileId);
    const sourceUrl = normalizeOptionalText(input.sourceUrl) ?? profile.defaultSourceUrl;
    if (!sourceUrl) {
      throw new Error(
        `Profile ${profile.id} has no defaultSourceUrl. Provide sourceUrl when creating a run.`,
      );
    }

    const templateSnapshot = this.resolveTemplateSnapshot(profile, input.templateOverrides);
    const displayTitleResolution = await this.resolveDisplayTitle(
      sourceUrl,
      normalizeOptionalText(input.displayTitle),
    );
    const run = this.runStore.createRun({
      profileId: profile.id,
      status: "pending",
      sourceUrl,
      displayTitle: displayTitleResolution.displayTitle,
      outputDir: profile.outputDir,
      templateSnapshot,
      payloadSnapshot: {
        profileSnapshot: {
          creditName: profile.creditName,
          creditUrl: profile.creditUrl,
          uploadPrivacy: profile.uploadPrivacy,
          uploadMode: profile.uploadMode,
          uploadTargets: {
            youtube: profile.uploadToYouTube,
            tiktok: profile.uploadToTikTok,
            instagram: profile.uploadToInstagram,
          },
          outputDir: profile.outputDir,
          oauthFilePath: profile.oauthFilePath,
        },
      },
    });

    const titleMessage =
      displayTitleResolution.source === "metadata"
        ? " Title resolved from source metadata."
        : displayTitleResolution.lookupError
          ? " Metadata title lookup failed; queued without auto title."
          : "";

    this.runStore.recordEvent({
      runId: run.id,
      eventType: "run.created",
      message: `Run queued for profile ${profile.id}.${titleMessage}`,
      payload: {
        sourceUrl,
        displayTitle: run.displayTitle,
        displayTitleSource: displayTitleResolution.source,
        displayTitleLookupError: displayTitleResolution.lookupError,
      },
    });

    return run;
  }

  async startRun(runId: string): Promise<CliRun> {
    const currentRun = this.requireRun(runId);
    this.assertRunStartable(currentRun);

    const profile = await this.requireProfile(currentRun.profileId);
    const sourceUrl = currentRun.sourceUrl ?? profile.defaultSourceUrl;
    if (!sourceUrl) {
      const message =
        `Run ${runId} cannot start: source URL is missing and profile ${profile.id} has no defaultSourceUrl.`;
      this.markRunFailed(runId, message);
      throw new Error(message);
    }

    this.runStore.updateRun(runId, {
      status: "running",
      outputDir: profile.outputDir,
      lastError: null,
    });
    this.runStore.recordEvent({ runId, eventType: "run.start_requested", message: `Starting run ${runId}.` });

    try {
      await this.withPipeline(profile, async (orchestrator) => {
        await orchestrator.run(sourceUrl, {
          onRunCreated: (pipelineRunId) => {
            this.runStore.updateRun(runId, {
              status: "running",
              pipelineRunId,
              outputDir: profile.outputDir,
            });
            this.runStore.recordEvent({
              runId,
              eventType: "run.pipeline_created",
              message: `Pipeline run created: ${pipelineRunId}`,
            });
          },
        });
      });

      const refreshed = this.refreshRunStatus(runId);
      const completed =
        refreshed.status === "completed"
          ? refreshed
          : this.runStore.updateRun(runId, { status: "completed", lastError: null });

      if (profile.uploadMode === "auto") {
        await this.uploadRun(runId, "all");
      }

      return this.requireRun(completed.id);
    } catch (error) {
      const message = toErrorMessage(error);
      this.markRunFailed(runId, message);
      throw new Error(`Run ${runId} failed: ${message}`);
    }
  }

  async startRuns(runIds: string[]): Promise<RunExecutionResult[]> {
    const results: RunExecutionResult[] = [];

    for (const runId of runIds) {
      try {
        const run = await this.startRun(runId);
        results.push({
          runId,
          success: true,
          run,
          error: null,
        });
      } catch (error) {
        results.push({
          runId,
          success: false,
          run: null,
          error: toErrorMessage(error),
        });
      }
    }

    return results;
  }

  async startAllPending(profileId?: string): Promise<RunExecutionResult[]> {
    const pendingRuns = this.runStore.listRuns(
      profileId
        ? { profileId, status: "pending" }
        : { status: "pending" },
    );

    return this.startRuns(pendingRuns.map((run) => run.id));
  }

  async resumeRun(runId: string): Promise<CliRun> {
    const run = this.requireRun(runId);
    if (!run.pipelineRunId) {
      throw new Error(
        `Run ${runId} has no pipelineRunId and cannot be resumed. Use "runs start ${runId}" to retry.`,
      );
    }

    const profile = await this.requireProfile(run.profileId);

    this.runStore.updateRun(runId, {
      status: "running",
      outputDir: profile.outputDir,
      lastError: null,
    });
    this.runStore.recordEvent({ runId, eventType: "run.resume_requested", message: `Resuming run ${runId}.` });

    try {
      await this.withPipeline(profile, async (orchestrator) => {
        await orchestrator.resume(run.pipelineRunId!);
      });

      const refreshed = this.refreshRunStatus(runId);
      const completed =
        refreshed.status === "completed"
          ? refreshed
          : this.runStore.updateRun(runId, { status: "completed", lastError: null });

      if (profile.uploadMode === "auto") {
        await this.uploadRun(runId, "all");
      }

      return this.requireRun(completed.id);
    } catch (error) {
      const message = toErrorMessage(error);
      this.markRunFailed(runId, message);
      throw new Error(`Run ${runId} resume failed: ${message}`);
    }
  }

  refreshRunStatus(runId: string): CliRun {
    const run = this.requireRun(runId);
    if (!run.pipelineRunId) {
      return run;
    }

    const pipelineRun = this.withCheckpoint((checkpoint) => checkpoint.getRunInfo(run.pipelineRunId!));
    if (!pipelineRun) {
      return run;
    }

    const pipelineStatus = mapPipelineRunStatus(pipelineRun.status);
    const mergedStatus = mergeCliAndPipelineStatus(run.status, pipelineStatus);

    if (mergedStatus === run.status) {
      return run;
    }

    const patch: { status: CliRunStatus; lastError?: string | null } = { status: mergedStatus };
    if (mergedStatus !== "failed") {
      patch.lastError = null;
    }

    return this.runStore.updateRun(run.id, patch);
  }

  async uploadRun(
    runId: string,
    platform: RunUploadSelection,
    options: RunUploadOptions = {},
  ): Promise<CliRun> {
    const run = this.requireRun(runId);
    if (!run.pipelineRunId) {
      throw new Error(`Run ${runId} has no pipelineRunId. Start/complete the run before upload.`);
    }

    const profile = await this.requireProfile(run.profileId);
    const allClipOutputs = this.collectClipOutputs(run.pipelineRunId);
    if (allClipOutputs.length === 0) {
      throw new Error(`Run ${runId} has no clip outputs available for upload.`);
    }

    const clipOutputs = this.selectClipOutputsForUpload(allClipOutputs, options);
    if (clipOutputs.length === 0) {
      throw new Error(`Run ${runId} has no clip outputs after applying upload filters.`);
    }

    const selectedPlatforms = this.resolveUploadPlatforms(profile, platform);
    if (selectedPlatforms.length === 0) {
      throw new Error(
        `Run ${runId} has no enabled upload platforms. Enable a platform in the profile or choose a specific platform.`,
      );
    }

    this.runStore.updateRun(runId, { status: "uploading", lastError: null });
    this.runStore.recordEvent({
      runId,
      eventType: "run.upload_requested",
      message: `Uploading ${clipOutputs.length} clip(s) to ${selectedPlatforms.join(", ")} (from ${allClipOutputs.length} available).`,
    });

    const templateSnapshot = this.resolveTemplateSnapshot(profile, toRunTemplateOverrides(run.templateSnapshot));
    const failures: string[] = [];

    for (const uploadPlatform of selectedPlatforms) {
      for (const clip of clipOutputs) {
        this.runStore.upsertUpload({
          runId,
          platform: uploadPlatform,
          clipPath: clip.filePath,
          status: "pending",
          payload: { stage: "queued" },
        });
      }

      try {
        let platformFailures: string[];

        if (uploadPlatform === "youtube") {
          platformFailures = await this.uploadToYouTube(
            runId,
            profile,
            clipOutputs,
            templateSnapshot,
            options,
          );
        } else if (uploadPlatform === "tiktok") {
          platformFailures = await this.uploadToTikTok(
            runId,
            profile,
            clipOutputs,
            templateSnapshot,
            options,
          );
        } else {
          platformFailures = await this.uploadToInstagram(
            runId,
            profile,
            clipOutputs,
            templateSnapshot,
            options,
          );
        }

        failures.push(...platformFailures.map((message) => `${uploadPlatform}: ${message}`));
      } catch (error) {
        const message = toErrorMessage(error);
        failures.push(`${uploadPlatform}: ${message}`);

        for (const clip of clipOutputs) {
          this.runStore.upsertUpload({
            runId,
            platform: uploadPlatform,
            clipPath: clip.filePath,
            status: "failed",
            lastError: message,
            payload: { stage: "platform_exception" },
          });
        }
      }
    }

    if (failures.length > 0) {
      const errorMessage = failures.join(" | ");
      this.markRunFailed(runId, errorMessage);
      throw new Error(`Upload failed for run ${runId}: ${errorMessage}`);
    }

    const uploadedRun = this.runStore.updateRun(runId, {
      status: "uploaded",
      lastError: null,
    });
    this.runStore.recordEvent({
      runId,
      eventType: "run.upload_completed",
      message: `Upload completed for platform(s): ${selectedPlatforms.join(", ")}.`,
    });

    return uploadedRun;
  }

  deleteRun(runId: string, options: DeleteRunOptions = {}): boolean {
    const existing = this.runStore.getRunById(runId);
    if (!existing) {
      return false;
    }

    if (options.deleteArtifacts && existing.pipelineRunId) {
      cleanRunArtifacts("./data", existing.pipelineRunId, !options.deleteFinalOutput);
    }

    return this.runStore.deleteRunById(runId);
  }

  private async uploadToYouTube(
    runId: string,
    profile: CliProfile,
    clipOutputs: ClipUploadTarget[],
    templates: RunTemplateSnapshot,
    options: RunUploadOptions,
  ): Promise<string[]> {
    const clipOverrides = this.buildClipOverrideMap(options.clipOverrides);
    const sharedDescription = normalizeOptionalText(options.sharedDescription);
    const titleSource = options.titleSource ?? "default";

    const results = await uploadYouTubeShorts({
      dir: profile.outputDir,
      privacyStatus: profile.uploadPrivacy,
      creditName: profile.creditName,
      creditUrl: profile.creditUrl ?? undefined,
      oauthFilePath: profile.oauthFilePath,
      descriptionTemplate: templates.youtubeDescriptionTemplate ?? undefined,
      uploads: clipOutputs.map((clip) => {
        const override = clipOverrides.get(clip.clipIndex);
        const overrideTitle = normalizeOptionalText(override?.title);
        const overrideDescription = normalizeOptionalText(override?.description);

        let title: string | undefined;
        if (overrideTitle) {
          title = overrideTitle;
        } else if (titleSource === "clip_title" && clip.clipTitle) {
          title = clip.clipTitle;
        } else if (titleSource === "filename") {
          title = basename(clip.filePath, extname(clip.filePath));
        }

        const description = overrideDescription ?? sharedDescription ?? undefined;
        return {
          filePath: clip.filePath,
          title,
          description,
        };
      }),
    });

    const failures: string[] = [];

    for (const result of results) {
      if (!result.success) {
        failures.push(`${result.filePath} (${result.error})`);
        this.runStore.upsertUpload({
          runId,
          platform: "youtube",
          clipPath: result.filePath,
          status: "failed",
          lastError: result.error,
          payload: result,
        });
        continue;
      }

      this.runStore.upsertUpload({
        runId,
        platform: "youtube",
        clipPath: result.filePath,
        status: "uploaded",
        externalUploadId: result.dryRun ? null : result.videoId,
        uploadedUrl: result.dryRun ? null : `https://youtu.be/${result.videoId}`,
        lastError: null,
        payload: result,
      });
    }

    return failures;
  }

  private async uploadToTikTok(
    runId: string,
    profile: CliProfile,
    clipOutputs: ClipUploadTarget[],
    templates: RunTemplateSnapshot,
    options: RunUploadOptions,
  ): Promise<string[]> {
    const clipOverrides = this.buildClipOverrideMap(options.clipOverrides);
    const sharedDescription = normalizeOptionalText(options.sharedDescription);

    const results = await uploadTikTokVideos({
      dir: profile.outputDir,
      creditName: profile.creditName,
      creditUrl: profile.creditUrl ?? undefined,
      captionTemplate: templates.tiktokCaptionTemplate ?? undefined,
      uploads: clipOutputs.map((clip) => {
        const override = clipOverrides.get(clip.clipIndex);
        const overrideDescription = normalizeOptionalText(override?.description);
        const caption = overrideDescription ?? sharedDescription ?? undefined;

        return {
          filePath: clip.filePath,
          caption,
        };
      }),
    });

    const failures: string[] = [];

    for (const result of results) {
      if (!result.success) {
        failures.push(`${result.filePath} (${result.error})`);
        this.runStore.upsertUpload({
          runId,
          platform: "tiktok",
          clipPath: result.filePath,
          status: "failed",
          externalUploadId: result.publishId ?? null,
          lastError: result.error,
          payload: result,
        });
        continue;
      }

      this.runStore.upsertUpload({
        runId,
        platform: "tiktok",
        clipPath: result.filePath,
        status: "uploaded",
        externalUploadId: result.dryRun ? null : result.publishId,
        uploadedUrl: result.dryRun ? null : result.postId ?? null,
        lastError: null,
        payload: result,
      });
    }

    return failures;
  }

  private async uploadToInstagram(
    runId: string,
    profile: CliProfile,
    clipOutputs: ClipUploadTarget[],
    templates: RunTemplateSnapshot,
    options: RunUploadOptions,
  ): Promise<string[]> {
    const igUserId = Bun.env.INSTAGRAM_IG_USER_ID?.trim();
    if (!igUserId) {
      throw new Error(
        "INSTAGRAM_IG_USER_ID is required for Instagram uploads. Set it before uploading to Instagram.",
      );
    }

    const clipOverrides = this.buildClipOverrideMap(options.clipOverrides);
    const sharedDescription = normalizeOptionalText(options.sharedDescription);

    const results = await uploadInstagramReels({
      dir: profile.outputDir,
      igUserId,
      creditName: profile.creditName,
      creditUrl: profile.creditUrl ?? undefined,
      captionTemplate: templates.instagramCaptionTemplate ?? undefined,
      uploads: clipOutputs.map((clip) => {
        const override = clipOverrides.get(clip.clipIndex);
        const overrideDescription = normalizeOptionalText(override?.description);
        const caption = overrideDescription ?? sharedDescription ?? undefined;

        return {
          filePath: clip.filePath,
          igUserId,
          caption,
        };
      }),
    });

    const failures: string[] = [];

    for (const result of results) {
      if (!result.success) {
        failures.push(`${result.filePath} (${result.error})`);
        this.runStore.upsertUpload({
          runId,
          platform: "instagram",
          clipPath: result.filePath,
          status: "failed",
          lastError: result.error,
          payload: result,
        });
        continue;
      }

      this.runStore.upsertUpload({
        runId,
        platform: "instagram",
        clipPath: result.filePath,
        status: "uploaded",
        externalUploadId: result.dryRun ? null : result.mediaId,
        uploadedUrl: result.dryRun ? null : result.containerId,
        lastError: null,
        payload: result,
      });
    }

    return failures;
  }

  private resolveUploadPlatforms(profile: CliProfile, selection: RunUploadSelection): UploadPlatform[] {
    if (selection !== "all") {
      return [selection];
    }

    const enabledPlatforms: UploadPlatform[] = [];
    if (profile.uploadToYouTube) {
      enabledPlatforms.push("youtube");
    }
    if (profile.uploadToTikTok) {
      enabledPlatforms.push("tiktok");
    }
    if (profile.uploadToInstagram) {
      enabledPlatforms.push("instagram");
    }

    return enabledPlatforms;
  }

  private buildClipOverrideMap(
    clipOverrides: RunUploadOptions["clipOverrides"],
  ): Map<number, RunUploadClipOverride> {
    const overrideMap = new Map<number, RunUploadClipOverride>();
    if (!clipOverrides || clipOverrides.length === 0) {
      return overrideMap;
    }

    for (const override of clipOverrides) {
      if (!Number.isInteger(override.clipIndex) || override.clipIndex < 0) {
        throw new Error("clipOverrides[].clipIndex must be a non-negative integer.");
      }

      overrideMap.set(override.clipIndex, override);
    }

    return overrideMap;
  }

  private selectClipOutputsForUpload(
    clipOutputs: ClipUploadTarget[],
    options: RunUploadOptions,
  ): ClipUploadTarget[] {
    let selected = [...clipOutputs].sort((left, right) => left.clipIndex - right.clipIndex);

    if (options.clipIndexes && options.clipIndexes.length > 0) {
      const selectedIndexes = new Set<number>();
      for (const clipIndex of options.clipIndexes) {
        if (!Number.isInteger(clipIndex) || clipIndex < 0) {
          throw new Error("clipIndexes must be non-negative integers.");
        }

        selectedIndexes.add(clipIndex);
      }

      selected = selected.filter((clip) => selectedIndexes.has(clip.clipIndex));
    }

    if (options.randomCount !== undefined) {
      if (!Number.isInteger(options.randomCount) || options.randomCount <= 0) {
        throw new Error("randomCount must be a positive integer.");
      }

      if (options.randomCount > selected.length) {
        throw new Error(
          `randomCount ${options.randomCount} exceeds available clips (${selected.length}) after filtering.`,
        );
      }

      selected = pickRandomItems(selected, options.randomCount).sort(
        (left, right) => left.clipIndex - right.clipIndex,
      );
    }

    if (options.maxClips !== undefined) {
      if (!Number.isInteger(options.maxClips) || options.maxClips <= 0) {
        throw new Error("maxClips must be a positive integer.");
      }

      selected = selected.slice(0, options.maxClips);
    }

    return selected;
  }

  private collectClipOutputs(pipelineRunId: string): ClipUploadTarget[] {
    const clipOutputs = this.withCheckpoint((checkpoint) => {
      const canonicalClipIndexById = buildCanonicalClipIndexById(checkpoint, pipelineRunId);
      const clipTitleById = buildClipTitleById(checkpoint, pipelineRunId);
      const orderedClipProgress = getOrderedClipProgress(
        checkpoint.getRunClipProgress(pipelineRunId),
        canonicalClipIndexById,
      );

      return orderedClipProgress
        .map((clip) => {
          const finalReelPath = normalizeOptionalText(clip.artifactPaths.finalReelPath);
          if (!finalReelPath) {
            return null;
          }

          return {
            clipId: clip.clipId,
            clipIndex: clip.resolvedClipIndex,
            clipTitle: clipTitleById.get(clip.clipId) ?? null,
            filePath: resolve(finalReelPath),
          } satisfies ClipUploadTarget;
        })
        .filter((clip): clip is ClipUploadTarget => clip !== null);
    });

    return clipOutputs;
  }

  private async resolveDisplayTitle(
    sourceUrl: string,
    explicitDisplayTitle: string | null,
  ): Promise<DisplayTitleResolution> {
    if (explicitDisplayTitle) {
      return {
        displayTitle: explicitDisplayTitle,
        source: "input",
        lookupError: null,
      };
    }

    if (!isHttpUrl(sourceUrl)) {
      return {
        displayTitle: null,
        source: "none",
        lookupError: null,
      };
    }

    try {
      const metadata = await this.resolveVideoMetadata(sourceUrl);
      const metadataTitle = normalizeOptionalText(metadata.title);
      if (!metadataTitle) {
        return {
          displayTitle: null,
          source: "none",
          lookupError: "metadata title missing",
        };
      }

      return {
        displayTitle: metadataTitle,
        source: "metadata",
        lookupError: null,
      };
    } catch (error) {
      return {
        displayTitle: null,
        source: "none",
        lookupError: toErrorMessage(error),
      };
    }
  }


  private resolveTemplateSnapshot(
    profile: CliProfile,
    overrides?: RunTemplateOverrides,
  ): RunTemplateSnapshot {
    const youtubeOverride = normalizeTemplateOverride(overrides?.youtubeDescriptionTemplate);
    const tiktokOverride = normalizeTemplateOverride(overrides?.tiktokCaptionTemplate);
    const instagramOverride = normalizeTemplateOverride(overrides?.instagramCaptionTemplate);

    return {
      youtubeDescriptionTemplate:
        youtubeOverride === undefined ? profile.youtubeDescriptionTemplate : youtubeOverride,
      tiktokCaptionTemplate:
        tiktokOverride === undefined ? profile.tiktokCaptionTemplate : tiktokOverride,
      instagramCaptionTemplate:
        instagramOverride === undefined ? profile.instagramCaptionTemplate : instagramOverride,
    };
  }


  private async requireProfile(profileId: string): Promise<CliProfile> {
    const store = await loadCliProfileStore(this.profilesFilePath);
    const profile = getCliProfileById(store, profileId);
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    return profile;
  }

  private requireRun(runId: string): CliRun {
    const run = this.runStore.getRunById(runId);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }

    return run;
  }

  private assertRunStartable(run: CliRun): void {
    if (run.status === "running" || run.status === "uploading") {
      throw new Error(`Run ${run.id} is currently ${run.status}; it cannot be started again.`);
    }

    if (run.status === "uploaded") {
      throw new Error(`Run ${run.id} is already uploaded. Create a new run instead of restarting this one.`);
    }
  }

  private markRunFailed(runId: string, errorMessage: string): void {
    this.runStore.updateRun(runId, {
      status: "failed",
      lastError: errorMessage,
    });
    this.runStore.recordEvent({
      runId,
      eventType: "run.failed",
      message: errorMessage,
    });
  }

  private buildNextActions(run: CliRun): string[] {
    const actions: string[] = [];

    if (run.status === "pending") {
      actions.push(`runs start ${run.id}`);
      return actions;
    }

    if (run.status === "running") {
      actions.push(`runs show ${run.id}`);
      return actions;
    }

    if (run.status === "failed") {
      if (run.pipelineRunId) {
        actions.push(`runs resume ${run.id}`);
      } else {
        actions.push(`runs start ${run.id}`);
      }
      actions.push(`runs show ${run.id}`);
      return actions;
    }

    if (run.status === "completed") {
      actions.push(`runs upload ${run.id} --platform all`);
      actions.push(`runs show ${run.id}`);
      return actions;
    }

    if (run.status === "uploading") {
      actions.push(`runs show ${run.id}`);
      return actions;
    }

    if (run.status === "uploaded") {
      actions.push(`runs show ${run.id}`);
      return actions;
    }

    return actions;
  }

  private withCheckpoint<T>(action: (checkpoint: CheckpointManager) => T): T {
    ensureDir(dirname(this.checkpointDbPath));
    const checkpoint = new CheckpointManager(this.checkpointDbPath);

    try {
      return action(checkpoint);
    } finally {
      checkpoint.close();
    }
  }

  private async withPipeline(
    profile: CliProfile,
    action: (orchestrator: PipelineOrchestrator) => Promise<void>,
  ): Promise<void> {
    const config = loadConfig();
    config.paths.checkpointDb = this.checkpointDbPath;
    config.paths.output = profile.outputDir;

    ensureDir(config.paths.data);
    ensureDir(config.paths.output);

    const checkpoint = new CheckpointManager(config.paths.checkpointDb);

    try {
      const orchestrator = new PipelineOrchestrator(config, checkpoint);
      await action(orchestrator);
    } finally {
      checkpoint.close();
    }
  }
}

interface ClipUploadTarget {
  clipId: string;
  clipIndex: number;
  clipTitle: string | null;
  filePath: string;
}

interface IndexedClipProgress extends ClipProgressSnapshot {
  resolvedClipIndex: number;
}

function buildCanonicalClipIndexById(
  checkpoint: CheckpointManager,
  runId: string,
): Map<string, number> {
  const stageResult = checkpoint.getStageResult<unknown>(runId, PipelineStage.IDENTIFY_CLIPS);
  const canonicalClipIndexById = new Map<string, number>();

  if (stageResult?.status !== StageStatus.COMPLETED || !Array.isArray(stageResult.data)) {
    return canonicalClipIndexById;
  }

  for (const [index, candidate] of stageResult.data.entries()) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") {
      continue;
    }

    const clipId = candidate.id.trim();
    if (!clipId || canonicalClipIndexById.has(clipId)) {
      continue;
    }

    canonicalClipIndexById.set(clipId, index);
  }

  return canonicalClipIndexById;
}

const pipelineStageOrder = Object.values(PipelineStage);

function buildClipTitleById(checkpoint: CheckpointManager, runId: string): Map<string, string> {
  const stageResult = checkpoint.getStageResult<unknown>(runId, PipelineStage.IDENTIFY_CLIPS);
  const clipTitleById = new Map<string, string>();
  if (stageResult?.status !== StageStatus.COMPLETED || !Array.isArray(stageResult.data)) {
    return clipTitleById;
  }

  for (const candidate of stageResult.data) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") {
      continue;
    }

    const clipId = candidate.id.trim();
    if (!clipId || clipTitleById.has(clipId)) {
      continue;
    }

    const clipTitle = normalizeOptionalText(
      typeof candidate.title === "string" ? candidate.title : null,
    );
    if (clipTitle) {
      clipTitleById.set(clipId, clipTitle);
    }
  }

  return clipTitleById;
}

function buildStageSummaries(
  checkpoint: CheckpointManager,
  runId: string,
  orderedClipProgress: IndexedClipProgress[],
): RunStageSummary[] {
  const identifyResult = checkpoint.getStageResult<unknown>(runId, PipelineStage.IDENTIFY_CLIPS);
  const expectedClipCount =
    identifyResult?.status === StageStatus.COMPLETED && Array.isArray(identifyResult.data)
      ? identifyResult.data.filter(
        (candidate) =>
          isRecord(candidate) &&
          typeof candidate.id === "string" &&
          candidate.id.trim().length > 0,
      ).length
      : orderedClipProgress.length;

  return Object.values(PipelineStage).map((stage) => {
    const stageResult = checkpoint.getStageResult(runId, stage);
    if (stageResult) {
      return toStageSummary(stage, stageResult);
    }

    if (!CLIP_STAGES.includes(stage as (typeof CLIP_STAGES)[number])) {
      return toStageSummary(stage, null);
    }

    return toClipStageSummary(stage, orderedClipProgress, expectedClipCount);
  });
}

function toClipStageSummary(
  stage: PipelineStage,
  orderedClipProgress: IndexedClipProgress[],
  expectedClipCount: number,
): RunStageSummary {
  const reachedStage = orderedClipProgress.filter((clip) => isClipAtOrBeyondStage(clip, stage));
  if (reachedStage.length === 0) {
    return {
      stage,
      status: "not_started",
      startedAt: null,
      completedAt: null,
      error: null,
    };
  }

  const startedAt = reachedStage.reduce<string | null>(
    (earliest, clip) =>
      earliest === null || clip.updatedAt.localeCompare(earliest) < 0 ? clip.updatedAt : earliest,
    null,
  );

  const failedAtStage = reachedStage.find((clip) => clip.stage === stage && clip.status === "failed");
  if (failedAtStage) {
    return {
      stage,
      status: StageStatus.FAILED,
      startedAt,
      completedAt: failedAtStage.updatedAt,
      error: null,
    };
  }

  const requiredClipCount = expectedClipCount > 0 ? expectedClipCount : orderedClipProgress.length;
  const completedCount = reachedStage.filter((clip) => hasClipCompletedStage(clip, stage)).length;
  if (requiredClipCount > 0 && completedCount >= requiredClipCount) {
    const completedAt = reachedStage.reduce<string | null>(
      (latest, clip) =>
        latest === null || clip.updatedAt.localeCompare(latest) > 0 ? clip.updatedAt : latest,
      null,
    );
    return {
      stage,
      status: StageStatus.COMPLETED,
      startedAt,
      completedAt,
      error: null,
    };
  }

  return {
    stage,
    status: StageStatus.IN_PROGRESS,
    startedAt,
    completedAt: null,
    error: null,
  };
}

function isClipAtOrBeyondStage(clip: IndexedClipProgress, stage: PipelineStage): boolean {
  return stageOrderIndex(clip.stage) >= stageOrderIndex(stage);
}

function hasClipCompletedStage(clip: IndexedClipProgress, stage: PipelineStage): boolean {
  const clipStageIndex = stageOrderIndex(clip.stage);
  const stageIndex = stageOrderIndex(stage);
  if (clipStageIndex > stageIndex) {
    return true;
  }

  return clipStageIndex === stageIndex && clip.status === "completed";
}

function stageOrderIndex(stage: PipelineStage): number {
  return pipelineStageOrder.indexOf(stage);
}

function getOrderedClipProgress(
  clipProgress: ClipProgressSnapshot[],
  canonicalClipIndexById: ReadonlyMap<string, number>,
): IndexedClipProgress[] {
  return clipProgress
    .map((clip) => ({
      ...clip,
      resolvedClipIndex: canonicalClipIndexById.get(clip.clipId) ?? clip.clipIndex,
    }))
    .sort(compareOrderedClipProgress);
}

function compareOrderedClipProgress(
  left: IndexedClipProgress,
  right: IndexedClipProgress,
): number {
  if (left.resolvedClipIndex !== right.resolvedClipIndex) {
    return left.resolvedClipIndex - right.resolvedClipIndex;
  }

  if (left.clipIndex !== right.clipIndex) {
    return left.clipIndex - right.clipIndex;
  }

  if (left.updatedAt !== right.updatedAt) {
    return left.updatedAt.localeCompare(right.updatedAt);
  }

  return left.clipId.localeCompare(right.clipId);
}

function pickRandomItems<T>(items: T[], count: number): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(Math.random() * (i + 1));
    const current = shuffled[i];
    shuffled[i] = shuffled[swapIndex];
    shuffled[swapIndex] = current;
  }

  return shuffled.slice(0, count);
}

function toStageSummary(stage: PipelineStage, result: StageResult | null): RunStageSummary {
  if (!result) {
    return {
      stage,
      status: "not_started",
      startedAt: null,
      completedAt: null,
      error: null,
    };
  }

  return {
    stage,
    status: result.status,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    error: result.error,
  };
}

function toClipSummary(clip: IndexedClipProgress): RunClipSummary {
  return {
    clipId: clip.clipId,
    clipIndex: clip.resolvedClipIndex,
    stage: clip.stage,
    status: clip.status,
    finalReelPath: normalizeOptionalText(clip.artifactPaths.finalReelPath),
    updatedAt: clip.updatedAt,
  };
}

function mapPipelineRunStatus(status: PipelineRun["status"]): CliRunStatus {
  if (status === "completed") {
    return "completed";
  }

  if (status === "failed") {
    return "failed";
  }

  return "running";
}

function mergeCliAndPipelineStatus(current: CliRunStatus, pipeline: CliRunStatus): CliRunStatus {
  if (pipeline === "failed") {
    return "failed";
  }

  if (pipeline === "running") {
    if (
      current === "uploading" ||
      current === "uploaded" ||
      current === "failed"
    ) {
      return current;
    }

    return "running";
  }

  if (pipeline === "completed") {
    if (
      current === "uploading" ||
      current === "uploaded" ||
      current === "failed"
    ) {
      return current;
    }

    return "completed";
  }

  return current;
}


function toRunTemplateOverrides(value: unknown): RunTemplateOverrides | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return {
    youtubeDescriptionTemplate: toOptionalTemplateValue(value.youtubeDescriptionTemplate),
    tiktokCaptionTemplate: toOptionalTemplateValue(value.tiktokCaptionTemplate),
    instagramCaptionTemplate: toOptionalTemplateValue(value.instagramCaptionTemplate),
  };
}

function toOptionalTemplateValue(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  return normalizeOptionalText(value);
}

function normalizeTemplateOverride(value: string | null | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeOptionalText(value);
}


function resolveCheckpointDbPath(explicitPath?: string): string {
  const normalized = explicitPath?.trim();
  if (normalized && normalized.length > 0) {
    return normalized;
  }

  return defaultCheckpointDbPath;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}


function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
