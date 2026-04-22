import { Command } from "commander";
import chalk from "chalk";

import { dirname, resolve } from "path";

import { loadConfig } from "./config";
import { runInteractiveCli } from "./cli/interactive";
import {
  createCliProfile,
  deleteCliProfile,
  getCliProfileById,
  getDefaultCliProfile,
  loadCliProfileStore,
  saveCliProfileStore,
  setDefaultCliProfile,
  updateCliProfile,
} from "./cli/profile-store";
import type { ProfileUploadMode } from "./cli/profile-store";
import { CliRunService } from "./cli/run-service";
import type { RunDetail, RunUploadClipOverride, RunUploadOptions } from "./cli/run-service";
import type { CliRunStatus, UploadPlatform } from "./cli/run-store";

import { Downloader } from "./modules/downloader";
import { getGitHubCopilotAuthStatus, loginGitHubCopilot } from "./modules/github-auth";
import { buildInstagramAuthUrl, exchangeCodeForInstagramTokens } from "./modules/instagram-auth";
import { uploadInstagramReels } from "./modules/instagram-uploader";
import { LiveClipper } from "./modules/live-clipper";
import { buildTikTokAuthUrl, exchangeCodeForTikTokTokens } from "./modules/tiktok-auth";
import { uploadTikTokVideos } from "./modules/tiktok-uploader";
import {
  buildYouTubeAuthUrl,
  exchangeCodeForYouTubeTokens,
  reauthYouTubeWithLocalCallback,
} from "./modules/youtube-auth";
import { uploadYouTubeShorts } from "./modules/youtube-uploader";
import { CheckpointManager } from "./pipeline/checkpoint";
import { PipelineOrchestrator } from "./pipeline/orchestrator";
import { cleanRunArtifacts, ensureDir } from "./utils/fs";
import { createLogger } from "./utils/logger";

const log = createLogger("cli");

const program = new Command()
  .name("clips")
  .description("Reel Farmer - Automated short-form clip extraction pipeline")
  .version("1.0.0");


type PipelineCommandContext = {
  config: ReturnType<typeof loadConfig>;
  checkpoint: CheckpointManager;
  orchestrator: PipelineOrchestrator;
};

type PipelineCommandOptions = {
  configureConfig?: (config: PipelineCommandContext["config"]) => void;
};

function resolveCheckpointDbPath(): string {
  return "./data/checkpoints.db";
}

function createCheckpoint(dbPath: string): CheckpointManager {
  ensureDir(dirname(dbPath));
  return new CheckpointManager(dbPath);
}

async function withCheckpointOnly<T>(
  action: (checkpoint: CheckpointManager) => Promise<T> | T,
): Promise<T> {
  const checkpoint = createCheckpoint(resolveCheckpointDbPath());

  try {
    return await action(checkpoint);
  } finally {
    checkpoint.close();
  }
}

async function withPipeline<T>(
  action: (context: PipelineCommandContext) => Promise<T> | T,
  options?: PipelineCommandOptions,
): Promise<T> {
  const config = loadConfig();
  options?.configureConfig?.(config);

  const checkpoint = createCheckpoint(config.paths.checkpointDb);

  try {
    const orchestrator = new PipelineOrchestrator(config, checkpoint);
    return await action({ config, checkpoint, orchestrator });
  } finally {
    checkpoint.close();
  }
}

async function withRunService<T>(action: (service: CliRunService) => Promise<T> | T): Promise<T> {
  const service = new CliRunService({ checkpointDbPath: resolveCheckpointDbPath() });

  try {
    return await action(service);
  } finally {
    service.close();
  }
}


program
  .command("pipeline")
  .description("Run the full pipeline for a YouTube video")
  .argument("<url>", "YouTube video URL")
  .action(async (url: string) => {
    try {
      await withPipeline(async ({ orchestrator }) => {
        const runId = await orchestrator.run(url);
        log.info(`Done! Run ID: ${runId}`);
        log.info(`Output: ./output/`);
      });
    } catch (err) {
      log.error(`Pipeline failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("live")
  .description("Continuously monitor a YouTube live stream and emit clip reels")
  .argument("<url>", "YouTube live URL")
  .option("--poll-seconds <n>", "Polling interval in seconds", "20")
  .option("--window-seconds <n>", "Trailing analysis window in seconds", "240")
  .option("--max-clips <n>", "Stop after N clips (0 = run continuously)", "0")
  .option("--min-gap-seconds <n>", "Minimum gap between emitted clip ranges", "20")
  .action(
    async (
      url: string,
      opts: { pollSeconds: string; windowSeconds: string; maxClips: string; minGapSeconds: string },
    ) => {
      const config = loadConfig();
      const liveClipper = new LiveClipper(config);

      try {
        const result = await liveClipper.run(url, {
          pollSeconds: parseIntegerOption(opts.pollSeconds, "poll-seconds", 5, 300),
          windowSeconds: parseIntegerOption(opts.windowSeconds, "window-seconds", 45, 900),
          maxClips: parseIntegerOption(opts.maxClips, "max-clips", 0, 500),
          minGapSeconds: parseIntegerOption(opts.minGapSeconds, "min-gap-seconds", 0, 600),
        });

        log.info(
          `Live clipping finished: ${result.clipsGenerated} clips (videoId=${result.videoId}, runId=${result.runId})`,
        );
        log.info(`Output directory: ${result.outputDir}`);
      } catch (err) {
        log.error(`Live clipping failed: ${err}`);
        process.exit(1);
      }
    },
  );

program
  .command("batch")
  .description("Process all videos from a YouTube channel")
  .argument("<channel-url>", "YouTube channel URL")
  .option("-l, --limit <n>", "Maximum videos to process", "10")
  .option("--skip-existing", "Skip already processed videos")
  .action(async (channelUrl: string, opts: { limit: string; skipExisting?: boolean }) => {
    const downloader = new Downloader();

    try {
      await withPipeline(async ({ checkpoint, orchestrator }) => {
        const urls = await downloader.listChannelVideos(channelUrl, parseInt(opts.limit));
        log.info(`Found ${urls.length} videos`);

        const existingRuns = checkpoint.getAllRuns();
        const processedUrls = new Set(
          existingRuns.filter((r) => r.status === "completed").map((r) => r.videoUrl),
        );

        for (let i = 0; i < urls.length; i++) {
          const url = urls[i];
          if (opts.skipExisting && processedUrls.has(url)) {
            log.info(`[${i + 1}/${urls.length}] Skipping (already processed): ${url}`);
            continue;
          }

          log.info(`[${i + 1}/${urls.length}] Processing: ${url}`);
          try {
            await orchestrator.run(url);
          } catch (err) {
            log.error(`Failed: ${err}`);
            log.info("Continuing with next video...");
          }
        }
      });
    } catch (err) {
      log.error(`Batch failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("resume")
  .description("Resume a previously interrupted pipeline run")
  .argument("<run-id>", "Pipeline run ID")
  .action(async (runId: string) => {
    try {
      await withPipeline(async ({ orchestrator }) => {
        await orchestrator.resume(runId);
        log.info("Resume completed");
      });
    } catch (err) {
      log.error(`Resume failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show status of pipeline runs")
  .argument("[run-id]", "Optional specific run ID")
  .action(async (runId?: string) => {
    try {
      await withCheckpointOnly((checkpoint) => {
        if (runId) {
          const run = checkpoint.getRunInfo(runId);
          if (!run) {
            throw new Error(`Run not found: ${runId}`);
          }

          console.log(chalk.bold(`\nRun: ${run.id}`));
          console.log(`  Video: ${run.videoUrl}`);
          console.log(`  Status: ${colorStatus(run.status)}`);
          console.log(`  Stage: ${run.currentStage}`);
          console.log(`  Created: ${run.createdAt}`);
          console.log(`  Updated: ${run.updatedAt}`);
          return;
        }

        const runs = checkpoint.getAllRuns();
        if (runs.length === 0) {
          console.log("No pipeline runs found.");
          return;
        }

        console.log(chalk.bold(`\n${runs.length} pipeline runs:\n`));
        for (const run of runs) {
          console.log(
            `  ${chalk.dim(run.id.slice(0, 8))} ${colorStatus(run.status)} ${chalk.cyan(run.currentStage)} ${run.videoTitle || run.videoId}`,
          );
        }
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(message);
      process.exit(1);
    }
  });

program
  .command("clean")
  .description("Clean intermediate artifacts for a run")
  .argument("<run-id>", "Pipeline run ID")
  .option("--all", "Remove all artifacts including final output")
  .action(async (runId: string, opts: { all?: boolean }) => {
    const config = loadConfig();
    cleanRunArtifacts(config.paths.data, runId, !opts.all);
    log.info(`Cleaned artifacts for run: ${runId}`);
  });

const profilesCommand = program.command("profiles").description("Manage local CLI profiles");

profilesCommand
  .command("list")
  .description("List saved CLI profiles")
  .option("--file <path>", "Profiles JSON path override")
  .action(async (opts: { file?: string }) => {
    const store = await loadCliProfileStore(opts.file);

    if (store.profiles.length === 0) {
      console.log("No CLI profiles found.");
      return;
    }

    console.log(chalk.bold(`\n${store.profiles.length} profile(s):\n`));
    for (const profile of store.profiles) {
      const defaultLabel = store.defaultProfileId === profile.id ? chalk.green("default") : chalk.dim("saved");
      console.log(`  ${chalk.cyan(profile.id)} [${defaultLabel}]`);
      console.log(`    creator: ${profile.creatorName}`);
      console.log(`    source: ${profile.defaultSourceUrl ?? "(none)"}`);
      console.log(`    output: ${profile.outputDir}`);
      console.log(`    privacy: ${profile.uploadPrivacy}`);
      console.log(`    uploadMode: ${profile.uploadMode}`);
      console.log(
        `    uploadTargets: youtube=${profile.uploadToYouTube} tiktok=${profile.uploadToTikTok} instagram=${profile.uploadToInstagram}`,
      );
      console.log(`    youtubeDescriptionTemplate: ${profile.youtubeDescriptionTemplate ?? "(none)"}`);
      console.log(`    tiktokCaptionTemplate: ${profile.tiktokCaptionTemplate ?? "(none)"}`);
      console.log(`    instagramCaptionTemplate: ${profile.instagramCaptionTemplate ?? "(none)"}`);
    }
  });

profilesCommand
  .command("show")
  .description("Show one CLI profile (or the default)")
  .argument("[profile-id]", "Profile ID (uses default when omitted)")
  .option("--file <path>", "Profiles JSON path override")
  .action(async (profileId: string | undefined, opts: { file?: string }) => {
    const store = await loadCliProfileStore(opts.file);
    const profile = profileId ? getCliProfileById(store, profileId) : getDefaultCliProfile(store);

    if (!profile) {
      log.error(profileId ? `Profile not found: ${profileId}` : "No default profile configured.");
      process.exit(1);
    }

    console.log(chalk.bold(`\nProfile: ${profile.id}`));
    console.log(`  creatorName: ${profile.creatorName}`);
    console.log(`  defaultSourceUrl: ${profile.defaultSourceUrl ?? ""}`);
    console.log(`  creditName: ${profile.creditName}`);
    console.log(`  creditUrl: ${profile.creditUrl ?? ""}`);
    console.log(`  defaultDescription: ${profile.defaultDescription ?? ""}`);
    console.log(`  outputDir: ${profile.outputDir}`);
    console.log(`  oauthFilePath: ${profile.oauthFilePath}`);
    console.log(`  uploadPrivacy: ${profile.uploadPrivacy}`);
    console.log(`  uploadMode: ${profile.uploadMode}`);
    console.log(`  uploadToYouTube: ${profile.uploadToYouTube}`);
    console.log(`  uploadToTikTok: ${profile.uploadToTikTok}`);
    console.log(`  uploadToInstagram: ${profile.uploadToInstagram}`);
    console.log(`  youtubeDescriptionTemplate: ${profile.youtubeDescriptionTemplate ?? ""}`);
    console.log(`  tiktokCaptionTemplate: ${profile.tiktokCaptionTemplate ?? ""}`);
    console.log(`  instagramCaptionTemplate: ${profile.instagramCaptionTemplate ?? ""}`);
    console.log(`  createdAt: ${profile.createdAt}`);
    console.log(`  updatedAt: ${profile.updatedAt}`);
    console.log(`  default: ${store.defaultProfileId === profile.id ? "yes" : "no"}`);
  });

profilesCommand
  .command("add")
  .description("Create a CLI profile")
  .argument("<profile-id>", "Profile ID")
  .requiredOption("--creator-name <name>", "Creator display name")
  .requiredOption("--credit-name <name>", "Credit attribution name")
  .option("--default-source-url <url>", "Default source URL for pipeline-profile")
  .option("--credit-url <url>", "Credit channel/profile URL")
  .option("--default-description <text>", "Default upload description")
  .option("--output-dir <path>", "Default output directory", "./output")
  .option("--oauth-file-path <path>", "OAuth file path", "./data/youtube-oauth.json")
  .option("--upload-privacy <private|unlisted|public>", "Default upload privacy", "unlisted")
  .option("--upload-mode <manual|auto>", "Default upload mode", "manual")
  .option("--upload-youtube <true|false>", "Enable YouTube uploads by default", "true")
  .option("--upload-tiktok <true|false>", "Enable TikTok uploads by default", "true")
  .option("--upload-instagram <true|false>", "Enable Instagram uploads by default", "true")
  .option("--youtube-description-template <text>", "Default YouTube description template")
  .option("--tiktok-caption-template <text>", "Default TikTok caption template")
  .option("--instagram-caption-template <text>", "Default Instagram caption template")
  .option("--file <path>", "Profiles JSON path override")
  .action(
    async (
      profileId: string,
      opts: {
        creatorName: string;
        creditName: string;
        defaultSourceUrl?: string;
        creditUrl?: string;
        defaultDescription?: string;
        outputDir: string;
        oauthFilePath: string;
        uploadPrivacy: string;
        uploadMode: string;
        uploadYoutube: string;
        uploadTiktok: string;
        uploadInstagram: string;
        youtubeDescriptionTemplate?: string;
        tiktokCaptionTemplate?: string;
        instagramCaptionTemplate?: string;
        file?: string;
      },
    ) => {
      try {
        const store = await loadCliProfileStore(opts.file);
        const profile = createCliProfile(store, {
          id: profileId,
          creatorName: opts.creatorName,
          defaultSourceUrl: opts.defaultSourceUrl,
          creditName: opts.creditName,
          creditUrl: opts.creditUrl,
          defaultDescription: opts.defaultDescription,
          outputDir: opts.outputDir,
          oauthFilePath: opts.oauthFilePath,
          uploadPrivacy: parseYouTubePrivacy(opts.uploadPrivacy),
          uploadMode: parseUploadMode(opts.uploadMode),
          uploadToYouTube: parseBooleanOption(opts.uploadYoutube, "upload-youtube"),
          uploadToTikTok: parseBooleanOption(opts.uploadTiktok, "upload-tiktok"),
          uploadToInstagram: parseBooleanOption(opts.uploadInstagram, "upload-instagram"),
          youtubeDescriptionTemplate: opts.youtubeDescriptionTemplate,
          tiktokCaptionTemplate: opts.tiktokCaptionTemplate,
          instagramCaptionTemplate: opts.instagramCaptionTemplate,
        });

        await saveCliProfileStore(store, opts.file);
        log.info(`Profile created: ${profile.id}`);
      } catch (err) {
        log.error(`Could not create profile: ${err}`);
        process.exit(1);
      }
    },
  );

profilesCommand
  .command("update")
  .description("Update fields on an existing CLI profile")
  .argument("<profile-id>", "Profile ID")
  .option("--creator-name <name>", "Creator display name")
  .option("--default-source-url <url>", "Default source URL")
  .option("--credit-name <name>", "Credit attribution name")
  .option("--credit-url <url>", "Credit channel/profile URL")
  .option("--default-description <text>", "Default upload description")
  .option("--output-dir <path>", "Default output directory")
  .option("--oauth-file-path <path>", "OAuth file path")
  .option("--upload-privacy <private|unlisted|public>", "Default upload privacy")
  .option("--upload-mode <manual|auto>", "Default upload mode")
  .option("--upload-youtube <true|false>", "Enable YouTube uploads by default")
  .option("--upload-tiktok <true|false>", "Enable TikTok uploads by default")
  .option("--upload-instagram <true|false>", "Enable Instagram uploads by default")
  .option("--youtube-description-template <text>", "Default YouTube description template")
  .option("--tiktok-caption-template <text>", "Default TikTok caption template")
  .option("--instagram-caption-template <text>", "Default Instagram caption template")
  .option("--file <path>", "Profiles JSON path override")
  .action(
    async (
      profileId: string,
      opts: {
        creatorName?: string;
        defaultSourceUrl?: string;
        creditName?: string;
        creditUrl?: string;
        defaultDescription?: string;
        outputDir?: string;
        oauthFilePath?: string;
        uploadPrivacy?: string;
        uploadMode?: string;
        uploadYoutube?: string;
        uploadTiktok?: string;
        uploadInstagram?: string;
        youtubeDescriptionTemplate?: string;
        tiktokCaptionTemplate?: string;
        instagramCaptionTemplate?: string;
        file?: string;
      },
    ) => {
      try {
        if (
          opts.creatorName === undefined &&
          opts.defaultSourceUrl === undefined &&
          opts.creditName === undefined &&
          opts.creditUrl === undefined &&
          opts.defaultDescription === undefined &&
          opts.outputDir === undefined &&
          opts.oauthFilePath === undefined &&
          opts.uploadPrivacy === undefined &&
          opts.uploadMode === undefined &&
          opts.uploadYoutube === undefined &&
          opts.uploadTiktok === undefined &&
          opts.uploadInstagram === undefined &&
          opts.youtubeDescriptionTemplate === undefined &&
          opts.tiktokCaptionTemplate === undefined &&
          opts.instagramCaptionTemplate === undefined
        ) {
          throw new Error("Provide at least one field to update.");
        }

        const store = await loadCliProfileStore(opts.file);
        const profile = updateCliProfile(store, profileId, {
          creatorName: opts.creatorName,
          defaultSourceUrl: opts.defaultSourceUrl,
          creditName: opts.creditName,
          creditUrl: opts.creditUrl,
          defaultDescription: opts.defaultDescription,
          outputDir: opts.outputDir,
          oauthFilePath: opts.oauthFilePath,
          uploadPrivacy:
            opts.uploadPrivacy !== undefined ? parseYouTubePrivacy(opts.uploadPrivacy) : undefined,
          uploadMode: opts.uploadMode !== undefined ? parseUploadMode(opts.uploadMode) : undefined,
          uploadToYouTube:
            opts.uploadYoutube !== undefined ? parseBooleanOption(opts.uploadYoutube, "upload-youtube") : undefined,
          uploadToTikTok:
            opts.uploadTiktok !== undefined ? parseBooleanOption(opts.uploadTiktok, "upload-tiktok") : undefined,
          uploadToInstagram:
            opts.uploadInstagram !== undefined
              ? parseBooleanOption(opts.uploadInstagram, "upload-instagram")
              : undefined,
          youtubeDescriptionTemplate: opts.youtubeDescriptionTemplate,
          tiktokCaptionTemplate: opts.tiktokCaptionTemplate,
          instagramCaptionTemplate: opts.instagramCaptionTemplate,
        });

        await saveCliProfileStore(store, opts.file);
        log.info(`Profile updated: ${profile.id}`);
      } catch (err) {
        log.error(`Could not update profile: ${err}`);
        process.exit(1);
      }
    },
  );

profilesCommand
  .command("remove")
  .description("Delete a CLI profile")
  .argument("<profile-id>", "Profile ID")
  .option("--file <path>", "Profiles JSON path override")
  .action(async (profileId: string, opts: { file?: string }) => {
    try {
      const store = await loadCliProfileStore(opts.file);
      const deleted = deleteCliProfile(store, profileId);
      if (!deleted) {
        throw new Error(`Profile not found: ${profileId}`);
      }

      await saveCliProfileStore(store, opts.file);
      log.info(`Profile removed: ${profileId}`);
    } catch (err) {
      log.error(`Could not remove profile: ${err}`);
      process.exit(1);
    }
  });

profilesCommand
  .command("use")
  .description("Set default CLI profile")
  .argument("<profile-id>", "Profile ID")
  .option("--file <path>", "Profiles JSON path override")
  .action(async (profileId: string, opts: { file?: string }) => {
    try {
      const store = await loadCliProfileStore(opts.file);
      const profile = setDefaultCliProfile(store, profileId);

      await saveCliProfileStore(store, opts.file);
      log.info(`Default profile set: ${profile.id}`);
    } catch (err) {
      log.error(`Could not set default profile: ${err}`);
      process.exit(1);
    }
  });

const runsCommand = program.command("runs").description("Manage queued CLI runs");

runsCommand
  .command("create")
  .description("Queue a run in pending state")
  .requiredOption("--profile <profile-id>", "Profile ID")
  .option("--url <url>", "Override source URL for this run")
  .option("--title <text>", "Optional display title for run listings")
  .option("--youtube-description-template <text>", "Run-level YouTube description template override")
  .option("--tiktok-caption-template <text>", "Run-level TikTok caption template override")
  .option("--instagram-caption-template <text>", "Run-level Instagram caption template override")
  .action(
    async (opts: {
      profile: string;
      url?: string;
      title?: string;
      youtubeDescriptionTemplate?: string;
      tiktokCaptionTemplate?: string;
      instagramCaptionTemplate?: string;
    }) => {
      try {
        const run = await withRunService((service) =>
          service.createRun({
            profileId: opts.profile,
            sourceUrl: opts.url,
            displayTitle: opts.title,
            templateOverrides: {
              youtubeDescriptionTemplate: opts.youtubeDescriptionTemplate,
              tiktokCaptionTemplate: opts.tiktokCaptionTemplate,
              instagramCaptionTemplate: opts.instagramCaptionTemplate,
            },
          }),
        );

        log.info(`Run queued: ${run.id}`);
        console.log(`  profile: ${run.profileId}`);
        console.log(`  status: ${run.status}`);
        console.log(`  source: ${run.sourceUrl ?? ""}`);
      } catch (err) {
        log.error(`Could not queue run: ${err}`);
        process.exit(1);
      }
    },
  );

runsCommand
  .command("list")
  .description("List queued and historical CLI runs")
  .option("--profile <profile-id>", "Filter by profile ID")
  .option(
    "--status <pending|running|failed|completed|uploading|uploaded>",
    "Filter by run status",
  )
  .action(async (opts: { profile?: string; status?: string }) => {
    try {
      const runs = await withRunService((service) =>
        service.listRuns({
          profileId: opts.profile,
          status: opts.status ? parseCliRunStatus(opts.status) : undefined,
        }),
      );

      if (runs.length === 0) {
        console.log("No queued runs found.");
        return;
      }

      console.log(chalk.bold(`\n${runs.length} queued run(s):\n`));
      for (const run of runs) {
        const runTitle = run.displayTitle ?? "(untitled)";
        console.log(
          `  ${chalk.dim(`${run.id}:${runTitle}`)} ${colorStatus(run.status)} profile=${chalk.cyan(run.profileId)} source=${run.sourceUrl ?? "(none)"}`,
        );
        console.log(`    pipelineRunId: ${run.pipelineRunId ?? "(none)"}`);
        console.log(`    outputDir: ${run.outputDir ?? "(none)"}`);
      }
    } catch (err) {
      log.error(`Could not list runs: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("show")
  .description("Show detailed run state including clip outputs and upload matrix")
  .argument("<run-id>", "CLI run ID")
  .action(async (runId: string) => {
    try {
      const detail = await withRunService((service) => service.getRunDetail(runId));
      printRunDetail(detail);
    } catch (err) {
      log.error(`Could not show run: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("start")
  .description("Start a queued run")
  .argument("<run-id>", "CLI run ID")
  .action(async (runId: string) => {
    try {
      const run = await withRunService((service) => service.startRun(runId));
      log.info(`Run started/completed: ${run.id} (${run.status})`);
    } catch (err) {
      log.error(`Could not start run: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("start-selected")
  .description("Start selected queued runs")
  .argument("<run-ids...>", "CLI run IDs")
  .action(async (runIds: string[]) => {
    try {
      const results = await withRunService((service) => service.startRuns(runIds));
      const failed = results.filter((result) => !result.success);

      for (const result of results) {
        if (result.success) {
          console.log(`  ${chalk.green("ok")} ${result.runId}`);
          continue;
        }

        console.log(`  ${chalk.red("failed")} ${result.runId}: ${result.error}`);
      }

      console.log(
        `Start-selected summary: total=${results.length}, success=${results.length - failed.length}, failed=${failed.length}`,
      );

      if (failed.length > 0) {
        process.exit(1);
      }
    } catch (err) {
      log.error(`Could not start selected runs: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("start-all")
  .description("Start all pending runs (optionally for one profile)")
  .option("--profile <profile-id>", "Profile ID filter")
  .action(async (opts: { profile?: string }) => {
    try {
      const results = await withRunService((service) => service.startAllPending(opts.profile));
      const failed = results.filter((result) => !result.success);

      for (const result of results) {
        if (result.success) {
          console.log(`  ${chalk.green("ok")} ${result.runId}`);
          continue;
        }

        console.log(`  ${chalk.red("failed")} ${result.runId}: ${result.error}`);
      }

      console.log(
        `Start-all summary: total=${results.length}, success=${results.length - failed.length}, failed=${failed.length}`,
      );

      if (failed.length > 0) {
        process.exit(1);
      }
    } catch (err) {
      log.error(`Could not start pending runs: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("resume")
  .description("Resume an incomplete run using stored pipelineRunId")
  .argument("<run-id>", "CLI run ID")
  .action(async (runId: string) => {
    try {
      const run = await withRunService((service) => service.resumeRun(runId));
      log.info(`Run resumed: ${run.id} (${run.status})`);
    } catch (err) {
      log.error(`Could not resume run: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("delete")
  .description("Delete a queued run (with optional artifact cleanup)")
  .argument("<run-id>", "CLI run ID")
  .option("--delete-artifacts", "Delete pipeline artifacts associated with this run")
  .option("--delete-final-output", "When deleting artifacts, also remove final outputs")
  .action(async (runId: string, opts: { deleteArtifacts?: boolean; deleteFinalOutput?: boolean }) => {
    try {
      const deleted = await withRunService((service) =>
        service.deleteRun(runId, {
          deleteArtifacts: Boolean(opts.deleteArtifacts),
          deleteFinalOutput: Boolean(opts.deleteFinalOutput),
        }),
      );

      if (!deleted) {
        log.error(`Run not found: ${runId}`);
        process.exit(1);
      }

      log.info(`Run deleted: ${runId}`);
    } catch (err) {
      log.error(`Could not delete run: ${err}`);
      process.exit(1);
    }
  });

runsCommand
  .command("upload")
  .description("Upload clips for one run")
  .argument("<run-id>", "CLI run ID")
  .option(
    "--platform <youtube|tiktok|instagram|all>",
    "Platform to upload",
    "all",
  )
  .option(
    "--clip-indexes <indexes>",
    "1-based clip indexes/ranges to upload (e.g. 1,3,5-7)",
  )
  .option("--random-count <count>", "Randomly choose this many clips after filtering")
  .option("--max-clips <count>", "Upload at most this many clips")
  .option(
    "--title-source <default|clip_title|filename>",
    "YouTube title source when no per-clip override is provided",
    "default",
  )
  .option("--description <text>", "Shared description/caption for all selected clips")
  .option(
    "--metadata-file <path>",
    "JSON file with per-clip overrides ({ index, title?, description? })",
  )
  .action(
    async (
      runId: string,
      opts: {
        platform: string;
        clipIndexes?: string;
        randomCount?: string;
        maxClips?: string;
        titleSource?: string;
        description?: string;
        metadataFile?: string;
      },
    ) => {
      try {
        const platform = parseRunUploadPlatform(opts.platform);
        const uploadOptions = await resolveRunUploadOptionsFromCli(opts);
        const run = await withRunService((service) => service.uploadRun(runId, platform, uploadOptions));
        log.info(`Run upload completed: ${run.id} (${run.status})`);
      } catch (err) {
        log.error(`Could not upload run: ${err}`);
        process.exit(1);
      }
    },
  );


program
  .command("pipeline-profile")
  .description("Run pipeline using a saved profile")
  .argument("[profile-id]", "Profile ID (uses default profile when omitted)")
  .option("--url <url>", "Override source URL instead of profile default")
  .option("--profiles-file <path>", "Profiles JSON path override")
  .action(async (profileId: string | undefined, opts: { url?: string; profilesFile?: string }) => {
    const store = await loadCliProfileStore(opts.profilesFile);
    const profile = profileId ? getCliProfileById(store, profileId) : getDefaultCliProfile(store);

    if (!profile) {
      log.error(profileId ? `Profile not found: ${profileId}` : "No default profile configured.");
      process.exit(1);
    }

    const sourceUrl = opts.url?.trim() || profile.defaultSourceUrl;
    if (!sourceUrl) {
      log.error(`Profile ${profile.id} has no defaultSourceUrl. Pass --url to override.`);
      process.exit(1);
    }

    try {
      await withPipeline(
        async ({ orchestrator }) => {
          const runId = await orchestrator.run(sourceUrl);
          log.info(`Done! Run ID: ${runId}`);
          log.info(`Profile: ${profile.id}`);
          log.info(`Output: ${profile.outputDir}`);
        },
        {
          configureConfig(config) {
            config.paths.output = profile.outputDir;
          },
        },
      );
    } catch (err) {
      log.error(`Pipeline profile run failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("interactive")
  .alias("i")
  .description("Start an interactive command menu")
  .action(async () => {
    await runInteractiveCli(runInteractiveCommand);
  });


program
  .command("github-auth-login")
  .description("Run browser-assisted GitHub Copilot auth for clip identification")
  .option("--host <url>", "GitHub host URL (default: https://github.com)")
  .action(async (opts: { host?: string }) => {
    try {
      const authStatus = await loginGitHubCopilot({ host: opts.host });
      const statusSuffix = authStatus.statusMessage ? ` (${authStatus.statusMessage})` : "";
      log.info(`GitHub Copilot authentication ready${statusSuffix}.`);
    } catch (err) {
      log.error(`GitHub Copilot auth failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("github-auth-status")
  .description("Show GitHub Copilot authentication status")
  .action(async () => {
    try {
      const authStatus = await getGitHubCopilotAuthStatus();
      console.log(`authenticated: ${authStatus.isAuthenticated ? "yes" : "no"}`);
      console.log(`status: ${authStatus.statusMessage || "(none)"}`);
      if (!authStatus.isAuthenticated) {
        log.info("Run `bun run src/index.ts github-auth-login` to authenticate.");
        process.exit(1);
      }
    } catch (err) {
      log.error(`Could not read GitHub Copilot auth status: ${err}`);
      process.exit(1);
    }
  });

program
  .command("youtube-auth-url")
  .description("Print YouTube OAuth consent URL for upload access")
  .action(() => {
    try {
      const authUrl = buildYouTubeAuthUrl();
      console.log(authUrl);
    } catch (err) {
      log.error(`Could not build YouTube auth URL: ${err}`);
      process.exit(1);
    }
  });

program
  .command("youtube-auth-exchange")
  .description("Exchange YouTube OAuth code and persist refresh token")
  .argument("<code>", "Authorization code returned by Google OAuth")
  .action(async (code: string) => {
    try {
      await exchangeCodeForYouTubeTokens(code);
      const oauthPath = Bun.env.YOUTUBE_OAUTH_FILE?.trim() || "./data/youtube-oauth.json";
      log.info(`YouTube OAuth tokens saved: ${oauthPath}`);
    } catch (err) {
      log.error(`YouTube token exchange failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("youtube-auth-reauth")
  .description("Run browser-assisted YouTube OAuth reauth and persist refresh token")
  .option("--timeout-sec <seconds>", "Seconds to wait for OAuth callback", "180")
  .option("--redirect-uri <uri>", "Override redirect URI for callback listener and token exchange")
  .option("--oauth-file <path>", "Override OAuth file path for persisted refresh token")
  .option("--no-open-browser", "Do not open a browser automatically")
  .action(
    async (opts: {
      timeoutSec: string;
      redirectUri?: string;
      oauthFile?: string;
      openBrowser?: boolean;
    }) => {
      try {
        const timeoutSec = parseIntegerOption(opts.timeoutSec, "timeout-sec", 5, 3600);

        let authUrlPrinted = false;
        await reauthYouTubeWithLocalCallback({
          redirectUri: opts.redirectUri,
          oauthFilePath: opts.oauthFile,
          timeoutMs: timeoutSec * 1000,
          openBrowser: opts.openBrowser !== false,
          onAuthUrl(authUrl) {
            authUrlPrinted = true;
            log.info("Authorize YouTube upload access by opening this URL:");
            console.log(authUrl);
            log.info("Waiting for OAuth callback...");
          },
          onBrowserOpenFailure(error) {
            log.warn(error.message);
            if (!authUrlPrinted) {
              log.warn("Browser open failed before URL print. Re-run with --no-open-browser if needed.");
            }
          },
        });

        const oauthPath = opts.oauthFile?.trim() || Bun.env.YOUTUBE_OAUTH_FILE?.trim() || "./data/youtube-oauth.json";
        log.info(`YouTube OAuth tokens saved: ${oauthPath}`);
      } catch (err) {
        log.error(`YouTube reauth failed: ${err}`);
        process.exit(1);
      }
    },
  );

program
  .command("upload-shorts")
  .description("Upload all .mp4 clips in a directory as YouTube Shorts")
  .option("--dir <path>", "Directory containing .mp4 files", "./output")
  .option("--privacy <private|unlisted|public>", "Privacy status for uploaded videos", "unlisted")
  .requiredOption("--credit-name <name>", "Original creator credit name")
  .option("--credit-url <url>", "Original creator profile/channel URL")
  .option("--dry-run", "Print metadata and skip uploads")
  .action(
    async (opts: {
      dir: string;
      privacy: string;
      creditName: string;
      creditUrl?: string;
      dryRun?: boolean;
    }) => {
      try {
        const privacyStatus = parseYouTubePrivacy(opts.privacy);
        const results = await uploadYouTubeShorts({
          dir: opts.dir,
          privacyStatus,
          creditName: opts.creditName,
          creditUrl: opts.creditUrl,
          dryRun: Boolean(opts.dryRun),
        });

        let successCount = 0;
        let failureCount = 0;

        for (const result of results) {
          if (!result.success) {
            failureCount += 1;
            log.error(`Failed: ${result.filePath} (${result.error})`);
            continue;
          }

          successCount += 1;

          if (result.dryRun) {
            log.info(`[DRY RUN] ${result.filePath}`);
            console.log(`  title: ${result.title}`);
            console.log(`  privacy: ${result.privacyStatus}`);
            console.log(`  description: ${result.description.replace(/\n/g, " | ")}`);
            continue;
          }

          log.info(`Uploaded: ${result.filePath} -> https://youtu.be/${result.videoId}`);
        }

        log.info(
          `Upload summary: total=${results.length}, success=${successCount}, failed=${failureCount}`,
        );

        if (failureCount > 0) {
          process.exit(1);
        }
      } catch (err) {
        log.error(`Upload shorts failed: ${err}`);
        process.exit(1);
      }
    },
  );

program
  .command("tiktok-auth-url")
  .description("Print TikTok OAuth consent URL for upload access")
  .action(() => {
    try {
      const authUrl = buildTikTokAuthUrl();
      console.log(authUrl);
    } catch (err) {
      log.error(`Could not build TikTok auth URL: ${err}`);
      process.exit(1);
    }
  });

program
  .command("tiktok-auth-exchange")
  .description("Exchange TikTok OAuth code and persist refresh token")
  .argument("<code>", "Authorization code returned by TikTok OAuth")
  .action(async (code: string) => {
    try {
      await exchangeCodeForTikTokTokens(code);
      const oauthPath = Bun.env.TIKTOK_OAUTH_FILE?.trim() || "./data/tiktok-oauth.json";
      log.info(`TikTok OAuth tokens saved: ${oauthPath}`);
    } catch (err) {
      log.error(`TikTok token exchange failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("upload-tiktok")
  .description("Upload all .mp4 clips in a directory to TikTok")
  .option("--dir <path>", "Directory containing .mp4 files", "./output")
  .option(
    "--privacy <level>",
    "TikTok privacy level: self|friends|followers|public", "self",
  )
  .requiredOption("--credit-name <name>", "Original creator credit name")
  .option("--credit-url <url>", "Original creator profile/channel URL")
  .option("--caption-prefix <text>", "Optional text prepended before default caption")
  .option("--dry-run", "Print metadata and skip uploads")
  .action(
    async (opts: {
      dir: string;
      privacy: string;
      creditName: string;
      creditUrl?: string;
      captionPrefix?: string;
      dryRun?: boolean;
    }) => {
      try {
        const privacyLevel = parseTikTokPrivacy(opts.privacy);
        const results = await uploadTikTokVideos({
          dir: opts.dir,
          privacyLevel,
          creditName: opts.creditName,
          creditUrl: opts.creditUrl,
          captionTemplate: opts.captionPrefix,
          dryRun: Boolean(opts.dryRun),
        });

        let successCount = 0;
        let failureCount = 0;

        for (const result of results) {
          if (!result.success) {
            failureCount += 1;
            const publishDetails = result.publishId ? `, publishId=${result.publishId}` : "";
            const statusDetails = result.status ? `, status=${result.status}` : "";
            log.error(`Failed: ${result.filePath} (${result.error}${publishDetails}${statusDetails})`);
            continue;
          }

          successCount += 1;

          if (result.dryRun) {
            log.info(`[DRY RUN] ${result.filePath}`);
            console.log(`  privacy: ${result.privacyLevel}`);
            console.log(`  caption: ${result.caption.replace(/\n/g, " | ")}`);
            continue;
          }

          const postDetails = result.postId ? `, postId=${result.postId}` : "";
          log.info(`Uploaded to TikTok: ${result.filePath} (publishId=${result.publishId}${postDetails})`);
        }

        log.info(
          `TikTok upload summary: total=${results.length}, success=${successCount}, failed=${failureCount}`,
        );

        if (failureCount > 0) {
          process.exit(1);
        }
      } catch (err) {
        log.error(`TikTok upload failed: ${err}`);
        process.exit(1);
      }
    },
  );

program
  .command("instagram-auth-url")
  .description("Print Instagram OAuth consent URL for upload access")
  .action(() => {
    try {
      const authUrl = buildInstagramAuthUrl();
      console.log(authUrl);
    } catch (err) {
      log.error(`Could not build Instagram auth URL: ${err}`);
      process.exit(1);
    }
  });

program
  .command("instagram-auth-exchange")
  .description("Exchange Instagram OAuth code and persist access token")
  .argument("<code>", "Authorization code returned by Meta OAuth")
  .action(async (code: string) => {
    try {
      await exchangeCodeForInstagramTokens(code);
      const oauthPath = Bun.env.INSTAGRAM_OAUTH_FILE?.trim() || "./data/instagram-oauth.json";
      log.info(`Instagram OAuth token saved: ${oauthPath}`);
    } catch (err) {
      log.error(`Instagram token exchange failed: ${err}`);
      process.exit(1);
    }
  });

program
  .command("upload-instagram-reels")
  .description("Upload all .mp4 clips in a directory as Instagram Reels")
  .option("--dir <path>", "Directory containing .mp4 files", "./output")
  .option("--ig-user-id <id>", "Instagram user id (numeric), overrides INSTAGRAM_IG_USER_ID")
  .requiredOption("--credit-name <name>", "Original creator credit name")
  .option("--credit-url <url>", "Original creator profile/channel URL")
  .option("--caption-prefix <text>", "Optional text prepended before default caption")
  .option("--dry-run", "Print metadata and skip uploads")
  .action(
    async (opts: {
      dir: string;
      igUserId?: string;
      creditName: string;
      creditUrl?: string;
      captionPrefix?: string;
      dryRun?: boolean;
    }) => {
      try {
        const igUserId = opts.igUserId?.trim() || Bun.env.INSTAGRAM_IG_USER_ID?.trim();
        if (!igUserId) {
          throw new Error(
            "Instagram user id is required. Pass --ig-user-id or set INSTAGRAM_IG_USER_ID.",
          );
        }

        const results = await uploadInstagramReels({
          dir: opts.dir,
          igUserId,
          creditName: opts.creditName,
          creditUrl: opts.creditUrl,
          captionTemplate: opts.captionPrefix,
          dryRun: Boolean(opts.dryRun),
        });

        let successCount = 0;
        let failureCount = 0;

        for (const result of results) {
          if (!result.success) {
            failureCount += 1;
            log.error(`Failed: ${result.filePath} (${result.error})`);
            continue;
          }

          successCount += 1;

          if (result.dryRun) {
            log.info(`[DRY RUN] ${result.filePath}`);
            console.log(`  igUserId: ${result.igUserId}`);
            console.log(`  caption: ${result.caption.replace(/\n/g, " | ")}`);
            continue;
          }

          log.info(
            `Uploaded to Instagram: ${result.filePath} (containerId=${result.containerId}, mediaId=${result.mediaId})`,
          );
        }

        log.info(
          `Instagram upload summary: total=${results.length}, success=${successCount}, failed=${failureCount}`,
        );

        if (failureCount > 0) {
          process.exit(1);
        }
      } catch (err) {
        log.error(`Instagram upload failed: ${err}`);
        process.exit(1);
      }
    },
  );


function parseIntegerOption(value: string, optionName: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid --${optionName} value "${value}". Use an integer between ${min} and ${max}.`);
  }

  return parsed;
}

function parseUploadMode(value: string): ProfileUploadMode {
  const normalized = value.trim().toLowerCase();
  if (normalized === "manual") {
    return "manual";
  }
  if (normalized === "auto") {
    return "auto";
  }

  throw new Error(`Invalid upload mode value "${value}". Use manual or auto.`);
}

function parseBooleanOption(value: string, optionName: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }

  throw new Error(`Invalid --${optionName} value "${value}". Use true or false.`);
}




const cliRunStatusValues: CliRunStatus[] = [
  "pending",
  "running",
  "failed",
  "completed",
  "uploading",
  "uploaded",
];

function parseCliRunStatus(value: string): CliRunStatus {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "failed" ||
    normalized === "completed" ||
    normalized === "uploading" ||
    normalized === "uploaded"
  ) {
    return normalized;
  }

  throw new Error(
    `Invalid run status value "${value}". Use one of: ${cliRunStatusValues.join(", ")}.`,
  );
}

function parseRunUploadPlatform(value: string): UploadPlatform | "all" {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "youtube" ||
    normalized === "tiktok" ||
    normalized === "instagram" ||
    normalized === "all"
  ) {
    return normalized;
  }

  throw new Error(
    `Invalid platform value "${value}". Use youtube, tiktok, instagram, or all.`,
  );
}

type RunUploadCliOptions = {
  clipIndexes?: string;
  randomCount?: string;
  maxClips?: string;
  titleSource?: string;
  description?: string;
  metadataFile?: string;
};

async function resolveRunUploadOptionsFromCli(opts: RunUploadCliOptions): Promise<RunUploadOptions> {
  const clipIndexes = opts.clipIndexes ? parseClipIndexSelection(opts.clipIndexes) : undefined;
  const randomCount =
    opts.randomCount !== undefined
      ? parsePositiveIntegerOption(opts.randomCount, "random-count")
      : undefined;
  const maxClips =
    opts.maxClips !== undefined
      ? parsePositiveIntegerOption(opts.maxClips, "max-clips")
      : undefined;
  const titleSource = parseUploadTitleSource(opts.titleSource ?? "default");
  const sharedDescription = normalizeOptionalText(opts.description);
  const clipOverrides = opts.metadataFile
    ? await loadRunUploadClipOverrides(opts.metadataFile)
    : undefined;

  return {
    clipIndexes,
    randomCount,
    maxClips,
    titleSource,
    sharedDescription,
    clipOverrides,
  };
}

function parseClipIndexSelection(value: string): number[] {
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    throw new Error("Invalid --clip-indexes value. Provide at least one index.");
  }

  const selectedIndexes = new Set<number>();
  for (const token of tokens) {
    if (token.includes("-")) {
      const [startRaw, endRaw] = token.split("-", 2).map((part) => part.trim());
      const start = parsePositiveIntegerOption(startRaw, "clip-indexes");
      const end = parsePositiveIntegerOption(endRaw, "clip-indexes");
      if (start > end) {
        throw new Error(
          `Invalid --clip-indexes range "${token}". Start index must be <= end index.`,
        );
      }

      for (let index = start; index <= end; index++) {
        selectedIndexes.add(index - 1);
      }
      continue;
    }

    const parsed = parsePositiveIntegerOption(token, "clip-indexes");
    selectedIndexes.add(parsed - 1);
  }

  return [...selectedIndexes].sort((left, right) => left - right);
}

function parsePositiveIntegerOption(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${optionName} value "${value}". Use a positive integer.`);
  }

  return parsed;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseUploadTitleSource(value: string): RunUploadOptions["titleSource"] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "default" || normalized === "clip_title" || normalized === "filename") {
    return normalized;
  }

  throw new Error(
    `Invalid --title-source value "${value}". Use default, clip_title, or filename.`,
  );
}

async function loadRunUploadClipOverrides(filePath: string): Promise<RunUploadClipOverride[]> {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) {
    throw new Error("--metadata-file requires a non-empty path.");
  }

  let payload: unknown;
  try {
    const raw = await Bun.file(normalizedPath).text();
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Could not parse --metadata-file ${normalizedPath}: ${toErrorMessage(error)}`);
  }

  if (Array.isArray(payload)) {
    return parseRunUploadClipOverrideEntries(payload, normalizedPath);
  }

  if (isPlainObject(payload) && Array.isArray(payload.clips)) {
    return parseRunUploadClipOverrideEntries(payload.clips, normalizedPath);
  }

  if (isPlainObject(payload)) {
    return parseRunUploadClipOverrideMap(payload);
  }

  throw new Error(
    `Invalid --metadata-file ${normalizedPath}. Use an array of { index, title?, description? } entries or an object keyed by 1-based clip indexes.`,
  );
}

function parseRunUploadClipOverrideEntries(
  entries: unknown[],
  sourceLabel: string,
): RunUploadClipOverride[] {
  const overrides: RunUploadClipOverride[] = [];
  for (const [offset, candidate] of entries.entries()) {
    if (!isPlainObject(candidate)) {
      throw new Error(
        `Invalid --metadata-file entry at index ${offset} in ${sourceLabel}. Expected an object with an index field.`,
      );
    }

    const indexValue = candidate.index;
    if (typeof indexValue !== "number" || !Number.isInteger(indexValue) || indexValue <= 0) {
      throw new Error(
        `Invalid --metadata-file entry at index ${offset} in ${sourceLabel}. "index" must be a positive integer (1-based clip index).`,
      );
    }

    overrides.push({
      clipIndex: indexValue - 1,
      title: normalizeOptionalText(typeof candidate.title === "string" ? candidate.title : null),
      description: normalizeOptionalText(
        typeof candidate.description === "string" ? candidate.description : null,
      ),
    });
  }

  return overrides;
}

function parseRunUploadClipOverrideMap(payload: Record<string, unknown>): RunUploadClipOverride[] {
  const overrides: RunUploadClipOverride[] = [];
  for (const [key, value] of Object.entries(payload)) {
    const parsedKey = Number.parseInt(key, 10);
    if (!Number.isInteger(parsedKey) || parsedKey <= 0) {
      throw new Error(
        `Invalid --metadata-file key "${key}". Keys must be 1-based clip indexes (for example: "1", "2").`,
      );
    }

    if (typeof value === "string") {
      overrides.push({
        clipIndex: parsedKey - 1,
        description: normalizeOptionalText(value),
      });
      continue;
    }

    if (!isPlainObject(value)) {
      throw new Error(
        `Invalid --metadata-file value for key "${key}". Use a string description or an object with title/description fields.`,
      );
    }

    overrides.push({
      clipIndex: parsedKey - 1,
      title: normalizeOptionalText(typeof value.title === "string" ? value.title : null),
      description: normalizeOptionalText(typeof value.description === "string" ? value.description : null),
    });
  }

  return overrides;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function printRunDetail(detail: RunDetail): void {
  const { run, pipelineRun, stages, clips, uploads, clipCounts, nextActions } = detail;

  console.log(chalk.bold(`\nRun: ${run.id}`));
  console.log(`  profileId: ${run.profileId}`);
  console.log(`  status: ${colorStatus(run.status)}`);
  console.log(`  sourceUrl: ${run.sourceUrl ?? ""}`);
  console.log(`  displayTitle: ${run.displayTitle ?? ""}`);
  console.log(`  pipelineRunId: ${run.pipelineRunId ?? ""}`);
  console.log(`  outputDir: ${run.outputDir ?? ""}`);
  console.log(`  lastError: ${run.lastError ?? ""}`);
  console.log(`  createdAt: ${run.createdAt}`);
  console.log(`  updatedAt: ${run.updatedAt}`);

  if (pipelineRun) {
    console.log(chalk.bold("\nPipeline status:"));
    console.log(`  status: ${colorStatus(pipelineRun.status)}`);
    console.log(`  stage: ${pipelineRun.currentStage}`);
    console.log(`  videoTitle: ${pipelineRun.videoTitle || ""}`);
  }

  console.log(chalk.bold("\nStage progress:"));
  for (const stage of stages) {
    const stageStatus =
      stage.status === "not_started" ? chalk.gray(stage.status) : colorStatus(stage.status);
    const timeLabel = stage.completedAt ?? stage.startedAt ?? "";
    const errorLabel = stage.error ? ` error=${stage.error}` : "";
    console.log(`  ${stage.stage}: ${stageStatus}${timeLabel ? ` (${timeLabel})` : ""}${errorLabel}`);
  }

  console.log(chalk.bold("\nClip outputs:"));
  console.log(
    `  counts: total=${clipCounts.total}, completed=${clipCounts.completed}, failed=${clipCounts.failed}`,
  );

  const uploadsByClipPath = new Map<string, Map<string, (typeof uploads)[number]>>();
  for (const upload of uploads) {
    const pathKey = normalizeClipPathKey(upload.clipPath);
    const uploadsByPlatform = uploadsByClipPath.get(pathKey) ?? new Map();
    const existing = uploadsByPlatform.get(upload.platform);
    if (!existing) {
      uploadsByPlatform.set(upload.platform, upload);
      uploadsByClipPath.set(pathKey, uploadsByPlatform);
      continue;
    }

    const existingStatusRank = uploadStatusRank(existing.status);
    const nextStatusRank = uploadStatusRank(upload.status);
    if (
      nextStatusRank > existingStatusRank ||
      (nextStatusRank === existingStatusRank &&
        upload.updatedAt.localeCompare(existing.updatedAt) > 0)
    ) {
      uploadsByPlatform.set(upload.platform, upload);
    }
  }

  if (clips.length === 0) {
    console.log("  (no clip progress yet)");
  } else {
    for (const clip of clips) {
      const clipPath = clip.finalReelPath ?? "";
      const clipUploadRows = clipPath
        ? [...(uploadsByClipPath.get(normalizeClipPathKey(clipPath))?.values() ?? [])].sort((left, right) =>
          left.platform.localeCompare(right.platform),
        )
        : [];
      console.log(
        `  [${String(clip.clipIndex + 1).padStart(2, "0")}] ${colorStatus(clip.status)} ${clip.finalReelPath ?? "(pending output)"}`,
      );

      if (clipUploadRows.length === 0) {
        console.log("    uploads: (none)");
        continue;
      }

      for (const upload of clipUploadRows) {
        const externalLabel = upload.externalUploadId ? ` id=${upload.externalUploadId}` : "";
        const errorLabel = upload.lastError ? ` error=${upload.lastError}` : "";
        console.log(
          `    ${upload.platform}: ${colorStatus(upload.status)}${externalLabel}${errorLabel}`,
        );
      }
    }
  }

  if (nextActions.length > 0) {
    console.log(chalk.bold("\nNext actions:"));
    for (const action of nextActions) {
      console.log(`  - clips ${action}`);
    }
  }
}

function normalizeClipPathKey(filePath: string): string {
  const normalized = resolve(filePath).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function uploadStatusRank(status: string): number {
  if (status === "uploaded") {
    return 3;
  }

  if (status === "failed") {
    return 2;
  }

  if (status === "pending") {
    return 1;
  }

  return 0;
}

type YouTubePrivacy = "private" | "unlisted" | "public";

function parseYouTubePrivacy(value: string): YouTubePrivacy {
  if (value === "private" || value === "unlisted" || value === "public") {
    return value;
  }

  throw new Error(`Invalid privacy value "${value}". Use private, unlisted, or public.`);
}

type TikTokPrivacy =
  | "SELF_ONLY"
  | "MUTUAL_FOLLOW_FRIENDS"
  | "FOLLOWER_OF_CREATOR"
  | "PUBLIC_TO_EVERYONE";

function parseTikTokPrivacy(value: string): TikTokPrivacy {
  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case "self":
    case "private":
    case "self_only":
      return "SELF_ONLY";
    case "friends":
    case "mutual_follow_friends":
      return "MUTUAL_FOLLOW_FRIENDS";
    case "followers":
    case "follower_of_creator":
      return "FOLLOWER_OF_CREATOR";
    case "public":
    case "public_to_everyone":
      return "PUBLIC_TO_EVERYONE";
    default:
      throw new Error(
        "Invalid TikTok privacy value. Use self, friends, followers, public, or API values SELF_ONLY/MUTUAL_FOLLOW_FRIENDS/FOLLOWER_OF_CREATOR/PUBLIC_TO_EVERYONE.",
      );
  }
}

function colorStatus(status: string): string {
  switch (status) {
    case "completed":
      return chalk.green(status);
    case "failed":
      return chalk.red(status);
    case "running":
      return chalk.yellow(status);
    default:
      return chalk.gray(status);
  }
}

await parseCli(process.argv);


async function parseCli(argv: string[]): Promise<void> {
  if (argv.length <= 2) {
    await runInteractiveCli(runInteractiveCommand);
    return;
  }

  await program.parseAsync(argv);
}

async function runInteractiveCommand(args: string[]): Promise<void> {
  const entryPath = process.argv[1];
  if (!entryPath) {
    throw new Error("Could not resolve CLI entry path.");
  }

  const spawned = Bun.spawn({
    cmd: [process.execPath, entryPath, ...args],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });

  const exitCode = await spawned.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}.`);
  }
}