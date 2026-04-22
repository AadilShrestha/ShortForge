import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import { createInterface, type Interface } from "node:readline/promises";

import { loadCliProfileStore, type CliProfile } from "./profile-store";
import { CliRunService, type RunDetail } from "./run-service";
import type { CliRun, CliRunStatus, UploadPlatform } from "./run-store";

export type InteractiveCommandExecutor = (args: string[]) => Promise<void>;

type MenuOption<T> = {
  value: T;
  label: string;
};

type MenuSelection<T> = { type: "select"; value: T } | { type: "back" } | { type: "quit" };

type MultiMenuSelection<T> = { type: "select"; values: T[] } | { type: "back" } | { type: "quit" };

type ProfileSelectionResult = { type: "selected"; profileId: string } | { type: "quit" };

type DashboardResult = { type: "switch_profile" } | { type: "quit" };

type ProfileSelectionAction = "select" | "create" | "manage";

type ProfileManageAction = "list" | "show" | "use" | "delete";

type DashboardAction =
  | "queue_run"
  | "list_runs"
  | "youtube_reauth"
  | "github_auth"
  | "start_one"
  | "start_selected"
  | "start_all"
  | "resume"
  | "show_run"
  | "upload"
  | "delete"
  | "manage_profiles"
  | "switch_profile";

type UploadPlatformSelection = "all" | "youtube" | "tiktok" | "instagram";

type PromptValueResult<T> = { type: "value"; value: T } | { type: "back" };

type UploadDescriptionMode = "default" | "shared" | "file";

type UploadPreflightInput = {
  profile: CliProfile;
  uploadPlatforms: ReadonlyArray<UploadPlatform>;
  fileExists?: (filePath: string) => boolean;
  env?: {
    YOUTUBE_CLIENT_ID?: string;
    YOUTUBE_CLIENT_SECRET?: string;
    TIKTOK_CLIENT_KEY?: string;
    TIKTOK_CLIENT_SECRET?: string;
    TIKTOK_OAUTH_FILE?: string;
    INSTAGRAM_CLIENT_ID?: string;
    INSTAGRAM_CLIENT_SECRET?: string;
    INSTAGRAM_OAUTH_FILE?: string;
    INSTAGRAM_IG_USER_ID?: string;
  };
};

type UploadSummaryInput = {
  selectedPlatform: UploadPlatformSelection;
  resolvedPlatforms: ReadonlyArray<UploadPlatform>;
  clipSelectionMode: "all" | "not_uploaded" | "pick" | "random";
  selectedClipCount: number | null;
  randomCount: number | null;
  maxClips: number | null;
  descriptionMode: UploadDescriptionMode;
  metadataFile: string | null;
};

const defaultTikTokOAuthFilePath = "./data/tiktok-oauth.json";
const defaultInstagramOAuthFilePath = "./data/instagram-oauth.json";

class InteractiveQuitSignal extends Error {
  constructor() {
    super("Interactive session ended.");
  }
}

export async function runInteractiveCli(execute: InteractiveCommandExecutor): Promise<void> {
  const rl = createInterface({ input, output });
  const rawNavigation = supportsRawNavigation();
  let activeProfileId: string | null = null;

  try {
    let running = true;

    while (running) {
      if (!activeProfileId) {
        const profileSelection = await runProfileSelectionStep(rl, execute, rawNavigation);
        if (profileSelection.type === "quit") {
          running = false;
          continue;
        }

        activeProfileId = profileSelection.profileId;
        continue;
      }

      const dashboardResult = await runProfileDashboard(
        rl,
        execute,
        activeProfileId,
        rawNavigation,
      );

      if (dashboardResult.type === "quit") {
        running = false;
        continue;
      }

      activeProfileId = null;
    }
  } catch (error) {
    if (!isReadlineClosedError(error) && !isInteractiveQuitSignal(error) && !isPromptAbortError(error)) {
      throw error;
    }
  } finally {
    disableRawModeIfNeeded();
    rl.close();
  }
}

async function runProfileSelectionStep(
  rl: Interface,
  execute: InteractiveCommandExecutor,
  rawNavigation: boolean,
): Promise<ProfileSelectionResult> {
  while (true) {
    const selection = await selectMenu(
      rl,
      {
        title: "clips interactive — profile selection",
        subtitle: "Select or create a profile before managing runs.",
        options: [
          { value: "select", label: "Select existing profile" },
          { value: "create", label: "Create new profile" },
          { value: "manage", label: "Manage profiles" },
        ] satisfies MenuOption<ProfileSelectionAction>[],
        allowBack: false,
      },
      rawNavigation,
    );

    if (selection.type === "quit") {
      return { type: "quit" };
    }

    if (selection.type !== "select") {
      continue;
    }

    try {
      if (selection.value === "select") {
        const profileSelection = await selectProfileFromStore(
          rl,
          {
            title: "Select profile",
            subtitle: "Choose the profile to activate.",
            allowBack: true,
            emptyMessage: "No CLI profiles found. Create one first.",
          },
          rawNavigation,
        );

        if (profileSelection.type === "quit") {
          return { type: "quit" };
        }

        if (profileSelection.type === "back") {
          continue;
        }

        await execute(["profiles", "show", profileSelection.value]);
        await maybePauseAfterAction(rl, rawNavigation);

        return {
          type: "selected",
          profileId: profileSelection.value,
        };
      }

      if (selection.value === "create") {
        const profileId = await runCreateProfileWizard(rl, execute, rawNavigation);
        if (!profileId) {
          continue;
        }

        return {
          type: "selected",
          profileId,
        };
      }

      await runProfileManagementMenu(rl, execute, rawNavigation);
    } catch (error) {
      if (isReadlineClosedError(error) || isInteractiveQuitSignal(error) || isPromptAbortError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.log(`Action failed: ${message}`);
      await maybePauseAfterAction(rl, rawNavigation);
    }
  }
}

async function runProfileDashboard(
  rl: Interface,
  execute: InteractiveCommandExecutor,
  profileId: string,
  rawNavigation: boolean,
): Promise<DashboardResult> {
  while (true) {
    const selection = await selectMenu(
      rl,
      {
        title: `clips interactive — profile ${profileId}`,
        subtitle: "Queue-first run workflow.",
        options: [
          { value: "queue_run", label: "Queue run" },
          { value: "list_runs", label: "List runs" },
          { value: "youtube_reauth", label: "Reauthenticate YouTube OAuth" },
          { value: "github_auth", label: "Authenticate GitHub Copilot" },
          { value: "start_one", label: "Start one run" },
          { value: "start_selected", label: "Start selected runs" },
          { value: "start_all", label: "Start all pending" },
          { value: "resume", label: "Resume incomplete run" },
          { value: "show_run", label: "Show run detail" },
          { value: "upload", label: "Upload run" },
          { value: "delete", label: "Delete run" },
          { value: "manage_profiles", label: "Manage profiles" },
          { value: "switch_profile", label: "Switch profile" },
        ] satisfies MenuOption<DashboardAction>[],
        allowBack: true,
      },
      rawNavigation,
    );

    if (selection.type === "quit") {
      return { type: "quit" };
    }

    if (selection.type === "back") {
      return { type: "switch_profile" };
    }

    if (selection.value === "switch_profile") {
      return { type: "switch_profile" };
    }

    try {
      await executeDashboardAction(rl, execute, profileId, selection.value, rawNavigation);
      await maybePauseAfterAction(rl, rawNavigation);
    } catch (error) {
      if (isReadlineClosedError(error) || isInteractiveQuitSignal(error) || isPromptAbortError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.log(`Action failed: ${message}`);
      await maybePauseAfterAction(rl, rawNavigation);
    }
  }
}

async function executeDashboardAction(
  rl: Interface,
  execute: InteractiveCommandExecutor,
  profileId: string,
  action: DashboardAction,
  rawNavigation: boolean,
): Promise<void> {
  if (action === "queue_run") {
    const sourceUrlInput = await askOptionalWithBack(
      rl,
      "Source URL override (leave blank to use profile default, type /back to cancel): ",
    );
    if (sourceUrlInput.type === "back") {
      console.log("Queue run canceled.");
      return;
    }

    const titleInput = await askOptionalWithBack(
      rl,
      "Run display title (optional, type /back to cancel): ",
    );
    if (titleInput.type === "back") {
      console.log("Queue run canceled.");
      return;
    }

    const youtubeTemplateInput = await askOptionalWithBack(
      rl,
      "YouTube description template override (optional, type /back to cancel): ",
    );
    if (youtubeTemplateInput.type === "back") {
      console.log("Queue run canceled.");
      return;
    }

    const tiktokTemplateInput = await askOptionalWithBack(
      rl,
      "TikTok caption template override (optional, type /back to cancel): ",
    );
    if (tiktokTemplateInput.type === "back") {
      console.log("Queue run canceled.");
      return;
    }

    const instagramTemplateInput = await askOptionalWithBack(
      rl,
      "Instagram caption template override (optional, type /back to cancel): ",
    );
    if (instagramTemplateInput.type === "back") {
      console.log("Queue run canceled.");
      return;
    }

    const args = ["runs", "create", "--profile", profileId];
    appendOptionalOption(args, "--url", sourceUrlInput.value);
    appendOptionalOption(args, "--title", titleInput.value);
    appendOptionalOption(args, "--youtube-description-template", youtubeTemplateInput.value);
    appendOptionalOption(args, "--tiktok-caption-template", tiktokTemplateInput.value);
    appendOptionalOption(args, "--instagram-caption-template", instagramTemplateInput.value);

    await execute(args);
    return;
  }

  if (action === "list_runs") {
    await execute(["runs", "list", "--profile", profileId]);
    return;
  }

  if (action === "youtube_reauth") {
    const profileStore = await loadCliProfileStore();
    const profile = profileStore.profiles.find((entry) => entry.id === profileId) ?? null;
    if (!profile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    await execute(["youtube-auth-reauth", "--oauth-file", profile.oauthFilePath]);
    return;
  }

  if (action === "github_auth") {
    await execute(["github-auth-login"]);
    return;
  }

  if (action === "start_one") {
    const runSelection = await selectRunFromStore(
      rl,
      profileId,
      {
        title: "Select run to start",
        subtitle: "Choose one run to start now.",
        allowBack: true,
        emptyMessage: `No startable runs found for profile "${profileId}".`,
        statuses: ["pending", "failed"],
        runFilter: isRunStartableFromInteractiveMenu,
      },
      rawNavigation,
    );

    if (runSelection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (runSelection.type === "back") {
      return;
    }

    await execute(["runs", "start", runSelection.value]);
    return;
  }

  if (action === "start_selected") {
    const runSelections = await selectRunsFromStore(
      rl,
      profileId,
      {
        title: "Select runs to start",
        subtitle: "Choose one or more runs.",
        allowBack: true,
        emptyMessage: `No startable runs found for profile "${profileId}".`,
        statuses: ["pending", "failed"],
        runFilter: isRunStartableFromInteractiveMenu,
      },
      rawNavigation,
    );

    if (runSelections.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (runSelections.type === "back") {
      return;
    }

    await execute(["runs", "start-selected", ...runSelections.values]);
    return;
  }

  if (action === "start_all") {
    await execute(["runs", "start-all", "--profile", profileId]);
    return;
  }

  if (action === "resume") {
    const runSelection = await selectRunFromStore(
      rl,
      profileId,
      {
        title: "Select run to resume",
        subtitle: "Choose one run to resume.",
        allowBack: true,
        emptyMessage: `No resumable runs found for profile "${profileId}".`,
        statuses: ["failed", "running"],
        runFilter: isRunResumableFromInteractiveMenu,
      },
      rawNavigation,
    );

    if (runSelection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (runSelection.type === "back") {
      return;
    }

    await execute(["runs", "resume", runSelection.value]);
    return;
  }

  if (action === "show_run") {
    const runSelection = await selectRunFromStore(
      rl,
      profileId,
      {
        title: "Select run to inspect",
        subtitle: "Choose one run to inspect.",
        allowBack: true,
        emptyMessage: `No runs found for profile "${profileId}".`,
      },
      rawNavigation,
    );

    if (runSelection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (runSelection.type === "back") {
      return;
    }

    await execute(["runs", "show", runSelection.value]);
    return;
  }

  if (action === "upload") {
    const runSelection = await selectRunFromStore(
      rl,
      profileId,
      {
        title: "Select run to upload",
        subtitle: "Choose one run to upload.",
        allowBack: true,
        emptyMessage: `No runs found for profile "${profileId}".`,
        statuses: ["completed", "uploaded", "failed"],
      },
      rawNavigation,
    );

    if (runSelection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (runSelection.type === "back") {
      return;
    }

    const platformSelection = await selectMenu(
      rl,
      {
        title: "Upload platform",
        subtitle: "Choose one platform or all enabled platforms.",
        options: [
          { value: "all", label: "all" },
          { value: "youtube", label: "youtube" },
          { value: "tiktok", label: "tiktok" },
          { value: "instagram", label: "instagram" },
        ] satisfies MenuOption<UploadPlatformSelection>[],
        allowBack: true,
      },
      rawNavigation,
    );

    if (platformSelection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (platformSelection.type === "back") {
      return;
    }

    const runDetail = withRunService((service) => service.getRunDetail(runSelection.value));
    const uploadableClips = runDetail.clips.filter((clip) => clip.finalReelPath !== null);
    if (uploadableClips.length === 0) {
      throw new Error("Selected run has no clip outputs available for upload.");
    }

    const profileStore = await loadCliProfileStore();
    const activeProfile = profileStore.profiles.find((entry) => entry.id === profileId) ?? null;
    if (!activeProfile) {
      throw new Error(`Profile not found: ${profileId}`);
    }

    const selectedPlatform = platformSelection.value;
    const uploadStatusPlatforms = resolveUploadStatusPlatforms(activeProfile, selectedPlatform);
    const notUploadedClipIndexes = collectNotUploadedClipIndexes(
      runDetail,
      uploadableClips,
      uploadStatusPlatforms,
    );

    const preflightFailures = collectUploadPreflightFailures({
      profile: activeProfile,
      uploadPlatforms: uploadStatusPlatforms,
    });
    if (preflightFailures.length > 0) {
      console.log("\nUpload preflight checks failed:");
      for (const failure of preflightFailures) {
        console.log(`  - ${failure}`);
      }

      throw new Error("Upload prerequisites are missing. Fix the issues above and retry.");
    }

    const clipSelectionPreview = buildClipSelectionPreview(
      selectedPlatform,
      uploadableClips.length,
      notUploadedClipIndexes.length,
    );
    console.log(`\nUpload preview: ${clipSelectionPreview}`);
    console.log(`Target upload platform(s): ${uploadStatusPlatforms.join(", ")}`);

    const continueUploadInput = await askYesNoWithBack(
      rl,
      "Continue to clip selection?",
      true,
    );
    if (continueUploadInput.type === "back") {
      return;
    }

    if (!continueUploadInput.value) {
      console.log("Upload canceled.");
      return;
    }

    const args = ["runs", "upload", runSelection.value, "--platform", selectedPlatform];

    let resolvedDescriptionMode: UploadDescriptionMode = "default";
    let selectedClipCount: number | null = uploadableClips.length;
    let randomCount: number | null = null;
    let appliedMaxClips: number | null = null;
    let metadataFilePath: string | null = null;

    const clipSelectionMode = await selectMenu(
      rl,
      {
        title: "Clip selection",
        subtitle: `Choose upload set (${uploadableClips.length} clips available, ${notUploadedClipIndexes.length} not uploaded).`,
        options: [
          { value: "all", label: `Upload all available clips (${uploadableClips.length})` },
          {
            value: "not_uploaded",
            label: `Upload clips not yet uploaded (${notUploadedClipIndexes.length})`,
          },
          { value: "pick", label: "Select specific clips" },
          { value: "random", label: "Pick random clips" },
        ],
        allowBack: true,
      },
      rawNavigation,
    );

    if (clipSelectionMode.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (clipSelectionMode.type === "back") {
      return;
    }

    if (clipSelectionMode.value === "pick") {
      const clipSelection = await selectMenuMulti(
        rl,
        {
          title: "Select clips to upload",
          subtitle: "Toggle one or more clips (Enter confirms).",
          options: uploadableClips.map((clip) => ({
            value: clip.clipIndex,
            label: `[${String(clip.clipIndex + 1).padStart(2, "0")}] ${clip.finalReelPath}`,
          })),
          allowBack: true,
        },
        rawNavigation,
      );

      if (clipSelection.type === "quit") {
        throw new InteractiveQuitSignal();
      }

      if (clipSelection.type === "back") {
        return;
      }

      const selectedIndexes = [...clipSelection.values].sort((left, right) => left - right);
      args.push("--clip-indexes", selectedIndexes.map((index) => String(index + 1)).join(","));
      selectedClipCount = selectedIndexes.length;
    } else if (clipSelectionMode.value === "random") {
      const randomCountInput = await askRequiredWithBack(
        rl,
        `How many random clips? (1-${uploadableClips.length}, type /back to cancel): `,
      );
      if (randomCountInput.type === "back") {
        return;
      }

      const randomCountRaw = randomCountInput.value;
      const parsedRandomCount = Number.parseInt(randomCountRaw, 10);
      if (
        !Number.isInteger(parsedRandomCount) ||
        parsedRandomCount <= 0 ||
        parsedRandomCount > uploadableClips.length
      ) {
        throw new Error(
          `Invalid random clip count "${randomCountRaw}". Use an integer between 1 and ${uploadableClips.length}.`,
        );
      }

      args.push("--random-count", String(parsedRandomCount));
      randomCount = parsedRandomCount;
      selectedClipCount = parsedRandomCount;
    } else if (clipSelectionMode.value === "not_uploaded") {
      if (notUploadedClipIndexes.length === 0) {
        throw new Error("All available clips are already uploaded for the selected platform(s).");
      }

      args.push(
        "--clip-indexes",
        notUploadedClipIndexes.map((index) => String(index + 1)).join(","),
      );
      selectedClipCount = notUploadedClipIndexes.length;
    }

    const includesYouTube = selectedPlatform === "youtube" || selectedPlatform === "all";
    if (includesYouTube) {
      const applyYouTubeCapInput = await askYesNoWithBack(
        rl,
        "Apply YouTube upload cap of 6 clips for this batch?",
        true,
      );
      if (applyYouTubeCapInput.type === "back") {
        return;
      }

      if (applyYouTubeCapInput.value) {
        args.push("--max-clips", "6");
        appliedMaxClips = 6;
      }

      const titleSourceSelection = await selectMenu(
        rl,
        {
          title: "YouTube title source",
          subtitle: "Choose how titles are generated when uploading to YouTube.",
          options: [
            { value: "default", label: "Default title generation" },
            { value: "clip_title", label: "Use clip title from IDENTIFY_CLIPS" },
            { value: "filename", label: "Use raw filename" },
          ],
          allowBack: true,
        },
        rawNavigation,
      );

      if (titleSourceSelection.type === "quit") {
        throw new InteractiveQuitSignal();
      }

      if (titleSourceSelection.type === "back") {
        return;
      }

      args.push("--title-source", titleSourceSelection.value);
    } else if (selectedPlatform === "tiktok") {
      const applyTikTokCapInput = await askYesNoWithBack(
        rl,
        "Apply TikTok batch cap of 15 clips for this upload?",
        true,
      );
      if (applyTikTokCapInput.type === "back") {
        return;
      }

      if (applyTikTokCapInput.value) {
        args.push("--max-clips", "15");
        appliedMaxClips = 15;
      }
    } else if (selectedPlatform === "instagram") {
      const applyInstagramCapInput = await askYesNoWithBack(
        rl,
        "Apply Instagram Content Publishing cap of 50 clips for this 24h batch?",
        true,
      );
      if (applyInstagramCapInput.type === "back") {
        return;
      }

      if (applyInstagramCapInput.value) {
        args.push("--max-clips", "50");
        appliedMaxClips = 50;
      }
    }

    const descriptionMode = await selectMenu(
      rl,
      {
        title: "Description/Caption mode",
        subtitle: "Choose default, shared text, or per-clip override file.",
        options: [
          { value: "default", label: "Use profile defaults/templates" },
          { value: "shared", label: "Use one shared description/caption" },
          { value: "file", label: "Load per-clip overrides from JSON file" },
        ],
        allowBack: true,
      },
      rawNavigation,
    );

    if (descriptionMode.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (descriptionMode.type === "back") {
      return;
    }

    resolvedDescriptionMode = descriptionMode.value;

    if (descriptionMode.value === "shared") {
      const sharedDescriptionInput = await askRequiredWithBack(
        rl,
        "Shared description/caption text (type /back to cancel): ",
      );
      if (sharedDescriptionInput.type === "back") {
        return;
      }

      args.push("--description", sharedDescriptionInput.value);
    } else if (descriptionMode.value === "file") {
      const metadataFileInput = await askRequiredWithBack(
        rl,
        "Per-clip override JSON path (entries: index/title/description, type /back to cancel): ",
      );
      if (metadataFileInput.type === "back") {
        return;
      }

      args.push("--metadata-file", metadataFileInput.value);
      metadataFilePath = metadataFileInput.value;
    }

    const uploadSummary = buildUploadSummary({
      selectedPlatform,
      resolvedPlatforms: uploadStatusPlatforms,
      clipSelectionMode: clipSelectionMode.value,
      selectedClipCount,
      randomCount,
      maxClips: appliedMaxClips,
      descriptionMode: resolvedDescriptionMode,
      metadataFile: resolvedDescriptionMode === "file" ? metadataFilePath : null,
    });

    console.log(`\nUpload plan: ${uploadSummary}`);
    const confirmUploadInput = await askYesNoWithBack(
      rl,
      "Confirm and start upload now?",
      true,
    );
    if (confirmUploadInput.type === "back") {
      return;
    }

    if (!confirmUploadInput.value) {
      console.log("Upload canceled before execution.");
      return;
    }

    await execute(args);
    return;
  }

  if (action === "delete") {
    const runSelection = await selectRunFromStore(
      rl,
      profileId,
      {
        title: "Select run to delete",
        subtitle: "Choose one run to delete.",
        allowBack: true,
        emptyMessage: `No runs found for profile "${profileId}".`,
      },
      rawNavigation,
    );

    if (runSelection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (runSelection.type === "back") {
      return;
    }

    const deleteArtifactsInput = await askYesNoWithBack(
      rl,
      "Delete pipeline artifacts too?",
      false,
    );
    if (deleteArtifactsInput.type === "back") {
      return;
    }

    const args = ["runs", "delete", runSelection.value];
    if (deleteArtifactsInput.value) {
      args.push("--delete-artifacts");

      const deleteFinalOutputInput = await askYesNoWithBack(
        rl,
        "Delete final output files too?",
        false,
      );
      if (deleteFinalOutputInput.type === "back") {
        return;
      }

      if (deleteFinalOutputInput.value) {
        args.push("--delete-final-output");
      }
    }

    await execute(args);
    return;
  }

  await runProfileManagementMenu(rl, execute, rawNavigation);
}

async function runProfileManagementMenu(
  rl: Interface,
  execute: InteractiveCommandExecutor,
  rawNavigation: boolean,
): Promise<void> {
  let managing = true;

  while (managing) {
    const selection = await selectMenu(
      rl,
      {
        title: "Profile management",
        subtitle: "Create, inspect, and update default profile settings.",
        options: [
          { value: "list", label: "List profiles" },
          { value: "show", label: "Show profile" },
          { value: "use", label: "Set default profile" },
          { value: "delete", label: "Delete profile" },
        ] satisfies MenuOption<ProfileManageAction>[],
        allowBack: true,
      },
      rawNavigation,
    );

    if (selection.type === "quit") {
      throw new InteractiveQuitSignal();
    }

    if (selection.type === "back") {
      managing = false;
      continue;
    }

    try {
      if (selection.value === "list") {
        await execute(["profiles", "list"]);
      } else {
        const profileSelection = await selectProfileFromStore(
          rl,
          {
            title: "Select profile",
            subtitle:
              selection.value === "show"
                ? "Choose one profile to inspect."
                : selection.value === "use"
                  ? "Choose one profile to set as default."
                  : "Choose one profile to delete.",
            allowBack: true,
            emptyMessage: "No CLI profiles found.",
          },
          rawNavigation,
        );

        if (profileSelection.type === "quit") {
          throw new InteractiveQuitSignal();
        }

        if (profileSelection.type === "back") {
          continue;
        }

        if (selection.value === "show") {
          await execute(["profiles", "show", profileSelection.value]);
        } else if (selection.value === "use") {
          await execute(["profiles", "use", profileSelection.value]);
        } else {
          const confirmed = await askYesNoWithBack(
            rl,
            `Delete profile "${profileSelection.value}"?`,
            false,
          );
          if (confirmed.type === "back") {
            continue;
          }

          if (!confirmed.value) {
            console.log("Delete cancelled.");
            await maybePauseAfterAction(rl, rawNavigation);
            continue;
          }

          await execute(["profiles", "remove", profileSelection.value]);
        }
      }

      await maybePauseAfterAction(rl, rawNavigation);
    } catch (error) {
      if (isReadlineClosedError(error) || isInteractiveQuitSignal(error) || isPromptAbortError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.log(`Profile action failed: ${message}`);
      await maybePauseAfterAction(rl, rawNavigation);
    }
  }
}

async function runCreateProfileWizard(
  rl: Interface,
  execute: InteractiveCommandExecutor,
  rawNavigation: boolean,
): Promise<string | null> {
  const idInput = await askRequiredWithBack(
    rl,
    "Profile ID (short key, type /back to cancel): ",
  );
  if (idInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const creatorNameInput = await askRequiredWithBack(
    rl,
    "Creator display name (type /back to cancel): ",
  );
  if (creatorNameInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const creditNameInput = await askDefaultWithBack(
    rl,
    "Credit name",
    creatorNameInput.value,
  );
  if (creditNameInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const defaultSourceUrlInput = await askOptionalWithBack(
    rl,
    "Default source URL (optional, type /back to cancel): ",
  );
  if (defaultSourceUrlInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const creditUrlInput = await askOptionalWithBack(
    rl,
    "Credit URL (optional, type /back to cancel): ",
  );
  if (creditUrlInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const defaultDescriptionInput = await askOptionalWithBack(
    rl,
    "Default upload description (optional, type /back to cancel): ",
  );
  if (defaultDescriptionInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const outputDirInput = await askDefaultWithBack(rl, "Output directory", "./output");
  if (outputDirInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const oauthFilePathInput = await askDefaultWithBack(
    rl,
    "OAuth file path",
    "./data/youtube-oauth.json",
  );
  if (oauthFilePathInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const uploadPrivacyInput = await askDefaultWithBack(
    rl,
    "Upload privacy (private|unlisted|public)",
    "unlisted",
  );
  if (uploadPrivacyInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const uploadModeInput = await askDefaultWithBack(rl, "Upload mode (manual|auto)", "manual");
  if (uploadModeInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const uploadYoutubeInput = await askYesNoWithBack(
    rl,
    "Enable YouTube uploads by default?",
    true,
  );
  if (uploadYoutubeInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const uploadTiktokInput = await askYesNoWithBack(
    rl,
    "Enable TikTok uploads by default?",
    true,
  );
  if (uploadTiktokInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const uploadInstagramInput = await askYesNoWithBack(
    rl,
    "Enable Instagram uploads by default?",
    true,
  );
  if (uploadInstagramInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const youtubeDescriptionTemplateInput = await askOptionalWithBack(
    rl,
    "YouTube description template default (optional, type /back to cancel): ",
  );
  if (youtubeDescriptionTemplateInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const tiktokCaptionTemplateInput = await askOptionalWithBack(
    rl,
    "TikTok caption template default (optional, type /back to cancel): ",
  );
  if (tiktokCaptionTemplateInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const instagramCaptionTemplateInput = await askOptionalWithBack(
    rl,
    "Instagram caption template default (optional, type /back to cancel): ",
  );
  if (instagramCaptionTemplateInput.type === "back") {
    console.log("Profile creation canceled.");
    return null;
  }

  const args = [
    "profiles",
    "add",
    idInput.value,
    "--creator-name",
    creatorNameInput.value,
    "--credit-name",
    creditNameInput.value,
    "--output-dir",
    outputDirInput.value,
    "--oauth-file-path",
    oauthFilePathInput.value,
    "--upload-privacy",
    uploadPrivacyInput.value,
    "--upload-mode",
    uploadModeInput.value,
    "--upload-youtube",
    String(uploadYoutubeInput.value),
    "--upload-tiktok",
    String(uploadTiktokInput.value),
    "--upload-instagram",
    String(uploadInstagramInput.value),
  ];

  appendOptionalOption(args, "--default-source-url", defaultSourceUrlInput.value);
  appendOptionalOption(args, "--credit-url", creditUrlInput.value);
  appendOptionalOption(args, "--default-description", defaultDescriptionInput.value);
  appendOptionalOption(args, "--youtube-description-template", youtubeDescriptionTemplateInput.value);
  appendOptionalOption(args, "--tiktok-caption-template", tiktokCaptionTemplateInput.value);
  appendOptionalOption(args, "--instagram-caption-template", instagramCaptionTemplateInput.value);

  await execute(args);
  await maybePauseAfterAction(rl, rawNavigation);

  return idInput.value;
}

interface MenuConfig<T> {
  title: string;
  subtitle?: string;
  options: MenuOption<T>[];
  allowBack: boolean;
  quickSelectDigits?: boolean;
}

interface SelectionListConfig {
  title: string;
  subtitle?: string;
  allowBack: boolean;
  emptyMessage: string;
  statuses?: ReadonlyArray<CliRunStatus>;
  runFilter?: (run: CliRun) => boolean;
}

async function selectMenu<T>(
  rl: Interface,
  menu: MenuConfig<T>,
  rawNavigation: boolean,
): Promise<MenuSelection<T>> {
  if (rawNavigation) {
    return selectMenuRaw(menu);
  }

  return selectMenuTyped(rl, menu);
}

async function selectMenuTyped<T>(rl: Interface, menu: MenuConfig<T>): Promise<MenuSelection<T>> {
  while (true) {
    console.log(`\n=== ${menu.title} ===`);
    if (menu.subtitle) {
      console.log(menu.subtitle);
    }

    for (let i = 0; i < menu.options.length; i++) {
      console.log(`${i + 1}) ${menu.options[i].label}`);
    }

    if (menu.allowBack) {
      console.log("b) Back");
    }
    console.log("q) Quit");
    console.log("Tip: press Enter for default 1 or type 1-9 for quick select.");

    const response = await rl.question("Choose an option [1]: ");
    const parsedSelection = parseTypedMenuSelectionInput(response, menu.options.length, menu.allowBack);

    if (parsedSelection.type === "quit") {
      return { type: "quit" };
    }

    if (parsedSelection.type === "back") {
      return { type: "back" };
    }

    if (parsedSelection.type === "select") {
      return {
        type: "select",
        value: menu.options[parsedSelection.index].value,
      };
    }

    console.log(parsedSelection.message);
  }
}

type ParsedTypedMenuSelectionInput =
  | { type: "select"; index: number }
  | { type: "back" }
  | { type: "quit" }
  | { type: "invalid"; message: string };

export function parseTypedMenuSelectionInput(
  rawValue: string,
  optionCount: number,
  allowBack: boolean,
): ParsedTypedMenuSelectionInput {
  if (!Number.isInteger(optionCount) || optionCount <= 0) {
    return { type: "invalid", message: "No menu options are available." };
  }

  const value = rawValue.trim().toLowerCase();
  if (value === "q" || value === "quit") {
    return { type: "quit" };
  }

  if (allowBack && (value === "b" || value === "back")) {
    return { type: "back" };
  }

  if (value.length === 0) {
    return { type: "select", index: 0 };
  }

  if (!/^\d+$/.test(value)) {
    return {
      type: "invalid",
      message: `Invalid option "${rawValue.trim()}". Use a number from 1 to ${optionCount},${
        allowBack ? " b/back," : ""
      } or q.`,
    };
  }

  const selectedIndex = Number.parseInt(value, 10) - 1;
  if (selectedIndex < 0 || selectedIndex >= optionCount) {
    return {
      type: "invalid",
      message: `Option out of range. Use a number from 1 to ${optionCount}.`,
    };
  }

  return { type: "select", index: selectedIndex };
}

async function selectMenuRaw<T>(menu: MenuConfig<T>): Promise<MenuSelection<T>> {
  if (!supportsRawNavigation()) {
    throw new Error("Raw navigation is unavailable in this terminal.");
  }

  const rawInput = input as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode(mode: boolean): void;
  };

  const options = menu.options;
  let selectedIndex = 0;
  const wasRaw = Boolean(rawInput.isRaw);

  emitKeypressEvents(rawInput);
  rawInput.setRawMode(true);

  const quickSelectDigits = menu.quickSelectDigits === true;

  const render = (): void => {
    output.write("\x1Bc");
    console.log(`=== ${menu.title} ===`);
    if (menu.subtitle) {
      console.log(menu.subtitle);
    }
    console.log("");

    for (let i = 0; i < options.length; i++) {
      const pointer = i === selectedIndex ? ">" : " ";
      const label = i === selectedIndex ? `[${options[i].label}]` : options[i].label;
      console.log(` ${pointer} ${label}`);
    }

    console.log("");
    const escapeHint = menu.allowBack ? "ESC/back" : "ESC disabled";
    const digitHint = quickSelectDigits ? " • 1-9 quick select" : "";
    console.log(`↑/↓ navigate • Enter select • ${escapeHint} • q quit${digitHint}`);
  };

  render();

  return new Promise<MenuSelection<T>>((resolve) => {
    const finish = (selection: MenuSelection<T>): void => {
      rawInput.off("keypress", onKeypress);
      rawInput.setRawMode(wasRaw);
      resolve(selection);
    };

    const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        finish({ type: "quit" });
        return;
      }

      if (key.name === "up") {
        selectedIndex = selectedIndex === 0 ? options.length - 1 : selectedIndex - 1;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = selectedIndex === options.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }

      if (key.name === "return") {
        finish({
          type: "select",
          value: options[selectedIndex].value,
        });
        return;
      }

      if (quickSelectDigits && key.name) {
        const resolved = resolveRawQuickDigitSelection(key.name, options.length);
        if (resolved.type === "select") {
          finish({
            type: "select",
            value: options[resolved.index].value,
          });
          return;
        }

        if (resolved.type === "invalid") {
          transientMessage = `Option ${key.name} is out of range.`;
          render();
          return;
        }
      }

      if (key.name === "escape") {
        if (menu.allowBack) {
          finish({ type: "back" });
        }
        return;
      }

      if (key.name === "q") {
        finish({ type: "quit" });
      }
    };

    rawInput.on("keypress", onKeypress);
  });
}

async function selectMenuMulti<T>(
  rl: Interface,
  menu: MenuConfig<T>,
  rawNavigation: boolean,
): Promise<MultiMenuSelection<T>> {
  if (rawNavigation) {
    return selectMenuRawMulti(menu);
  }

  return selectMenuTypedMulti(rl, menu);
}

async function selectMenuTypedMulti<T>(
  rl: Interface,
  menu: MenuConfig<T>,
): Promise<MultiMenuSelection<T>> {
  while (true) {
    console.log(`\n=== ${menu.title} ===`);
    if (menu.subtitle) {
      console.log(menu.subtitle);
    }

    for (let i = 0; i < menu.options.length; i++) {
      console.log(`${i + 1}) ${menu.options[i].label}`);
    }

    if (menu.allowBack) {
      console.log("b) Back");
    }
    console.log("q) Quit");
    console.log("Tip: use ranges like 1-3 5, or Enter to keep toggled selection.");

    const responseRaw = (await rl.question("Choose one or more options: ")).trim();
    const response = responseRaw.toLowerCase();

    if (response === "q" || response === "quit") {
      return { type: "quit" };
    }

    if (menu.allowBack && (response === "b" || response === "back")) {
      return { type: "back" };
    }

    const parsed = parseTypedMultiSelectionInput(responseRaw, menu.options.length);
    if (parsed.type === "invalid") {
      console.log(parsed.message);
      continue;
    }

    return {
      type: "select",
      values: parsed.indexes.map((index) => menu.options[index].value),
    };
  }
}

type ParsedTypedMultiSelection =
  | { type: "select"; indexes: number[] }
  | { type: "invalid"; message: string };

export function parseTypedMultiSelectionInput(
  rawValue: string,
  optionCount: number,
): ParsedTypedMultiSelection {
  const tokens = rawValue
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return { type: "invalid", message: "Choose at least one numeric index." };
  }

  const selectedIndexes: number[] = [];
  const seenIndexes = new Set<number>();

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const parsed = Number.parseInt(token, 10);
      if (parsed < 1 || parsed > optionCount) {
        return {
          type: "invalid",
          message: `Index "${token}" is out of range. Use numbers from 1 to ${optionCount}.`,
        };
      }

      const selectedIndex = parsed - 1;
      if (!seenIndexes.has(selectedIndex)) {
        seenIndexes.add(selectedIndex);
        selectedIndexes.push(selectedIndex);
      }
      continue;
    }

    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (!rangeMatch) {
      return {
        type: "invalid",
        message: `Invalid token "${token}". Use numbers/ranges from 1 to ${optionCount}.`,
      };
    }

    const rangeStart = Number.parseInt(rangeMatch[1], 10);
    const rangeEnd = Number.parseInt(rangeMatch[2], 10);
    if (rangeStart > rangeEnd) {
      return {
        type: "invalid",
        message: `Invalid range "${token}". Start must be less than or equal to end.`,
      };
    }

    if (rangeStart < 1 || rangeEnd > optionCount) {
      return {
        type: "invalid",
        message: `Range "${token}" is out of bounds. Use values from 1 to ${optionCount}.`,
      };
    }

    for (let index = rangeStart - 1; index <= rangeEnd - 1; index++) {
      if (!seenIndexes.has(index)) {
        seenIndexes.add(index);
        selectedIndexes.push(index);
      }
    }
  }

  return { type: "select", indexes: selectedIndexes };
}

export function testOnly_collectUploadPreflightFailures(input: UploadPreflightInput): string[] {
  return collectUploadPreflightFailures(input);
}

export function testOnly_buildUploadSummary(input: UploadSummaryInput): string {
  return buildUploadSummary(input);
}

export function testOnly_resolveRawQuickDigitSelection(
  keyName: string,
  optionCount: number,
): { type: "select"; index: number } | { type: "invalid" } | { type: "ignore" } {
  return resolveRawQuickDigitSelection(keyName, optionCount);
}

export function testOnly_toggleRawQuickDigitSelection(
  toggledIndexes: Set<number>,
  keyName: string,
  optionCount: number,
): { type: "toggled"; index: number; selected: boolean } | { type: "invalid" } | { type: "ignore" } {
  return toggleRawQuickDigitSelection(toggledIndexes, keyName, optionCount);
}

async function selectMenuRawMulti<T>(menu: MenuConfig<T>): Promise<MultiMenuSelection<T>> {
  if (!supportsRawNavigation()) {
    throw new Error("Raw navigation is unavailable in this terminal.");
  }

  const rawInput = input as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode(mode: boolean): void;
  };

  const options = menu.options;
  let selectedIndex = 0;
  const toggledIndexes = new Set<number>();
  let transientMessage: string | null = null;
  const wasRaw = Boolean(rawInput.isRaw);

  emitKeypressEvents(rawInput);
  rawInput.setRawMode(true);

  const render = (): void => {
    output.write("\x1Bc");
    console.log(`=== ${menu.title} ===`);
    if (menu.subtitle) {
      console.log(menu.subtitle);
    }
    console.log("");

    for (let i = 0; i < options.length; i++) {
      const pointer = i === selectedIndex ? ">" : " ";
      const checked = toggledIndexes.has(i) ? "[x]" : "[ ]";
      console.log(` ${pointer} ${checked} ${options[i].label}`);
    }

    console.log("");
    if (transientMessage) {
      console.log(transientMessage);
      console.log("");
    }

    const escapeHint = menu.allowBack ? "ESC back" : "ESC disabled";
    const digitHint = quickSelectDigits ? " • 1-9 quick toggle" : "";
    console.log(`↑/↓ navigate • Space toggle • Enter confirm • ${escapeHint} • q quit${digitHint}`);
    console.log(`Selected: ${toggledIndexes.size}`);
  };

  render();

  return new Promise<MultiMenuSelection<T>>((resolve) => {
    const finish = (selection: MultiMenuSelection<T>): void => {
      rawInput.off("keypress", onKeypress);
      rawInput.setRawMode(wasRaw);
      resolve(selection);
    };

    const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean }): void => {
      if (key.ctrl && key.name === "c") {
        finish({ type: "quit" });
        return;
      }

      if (key.name === "up") {
        selectedIndex = selectedIndex === 0 ? options.length - 1 : selectedIndex - 1;
        transientMessage = null;
        render();
        return;
      }

      if (key.name === "down") {
        selectedIndex = selectedIndex === options.length - 1 ? 0 : selectedIndex + 1;
        transientMessage = null;
        render();
        return;
      }

      if (key.name === "space") {
        if (toggledIndexes.has(selectedIndex)) {
          toggledIndexes.delete(selectedIndex);
        } else {
          toggledIndexes.add(selectedIndex);
        }
        transientMessage = null;
        render();
        return;
      }

      if (key.name === "return") {
        if (toggledIndexes.size === 0) {
          transientMessage = "Select at least one option before confirming.";
          render();
          return;
        }

        const indexes = [...toggledIndexes].sort((a, b) => a - b);
        finish({
          type: "select",
          values: indexes.map((index) => options[index].value),
        });
        return;
      }

      if (quickSelectDigits && key.name) {
        const resolved = toggleRawQuickDigitSelection(toggledIndexes, key.name, options.length);
        if (resolved.type === "toggled") {
          transientMessage = `Toggled option ${resolved.index + 1}.`;
          render();
          return;
        }

        if (resolved.type === "invalid") {
          transientMessage = `Option ${key.name} is out of range.`;
          render();
          return;
        }
      }

      if (key.name === "escape") {
        if (menu.allowBack) {
          finish({ type: "back" });
        }
        return;
      }

      if (key.name === "q") {
        finish({ type: "quit" });
      }
    };

    rawInput.on("keypress", onKeypress);
  });
}

async function selectProfileFromStore(
  rl: Interface,
  menu: SelectionListConfig,
  rawNavigation: boolean,
): Promise<MenuSelection<string>> {
  const options = await loadProfileMenuOptions();
  if (options.length === 0) {
    console.log(menu.emptyMessage);
    return { type: "back" };
  }

  return selectMenu(
    rl,
    {
      title: menu.title,
      subtitle: menu.subtitle,
      options,
      allowBack: menu.allowBack,
      quickSelectDigits: true,
    },
    rawNavigation,
  );
}

async function selectRunFromStore(
  rl: Interface,
  profileId: string,
  menu: SelectionListConfig,
  rawNavigation: boolean,
): Promise<MenuSelection<string>> {
  const options = loadRunMenuOptions(profileId, menu.statuses, menu.runFilter);
  if (options.length === 0) {
    console.log(menu.emptyMessage);
    return { type: "back" };
  }

  return selectMenu(
    rl,
    {
      title: menu.title,
      subtitle: menu.subtitle,
      options,
      allowBack: menu.allowBack,
      quickSelectDigits: true,
    },
    rawNavigation,
  );
}

async function selectRunsFromStore(
  rl: Interface,
  profileId: string,
  menu: SelectionListConfig,
  rawNavigation: boolean,
): Promise<MultiMenuSelection<string>> {
  const options = loadRunMenuOptions(profileId, menu.statuses, menu.runFilter);
  if (options.length === 0) {
    console.log(menu.emptyMessage);
    return { type: "back" };
  }

  return selectMenuMulti(
    rl,
    {
      title: menu.title,
      subtitle: menu.subtitle,
      options,
      allowBack: menu.allowBack,
      quickSelectDigits: true,
    },
    rawNavigation,
  );
}

async function loadProfileMenuOptions(): Promise<MenuOption<string>[]> {
  const store = await loadCliProfileStore();
  return store.profiles.map((profile) => ({
    value: profile.id,
    label: formatProfileMenuLabel(profile, store.defaultProfileId),
  }));
}

function loadRunMenuOptions(
  profileId: string,
  statuses?: ReadonlyArray<CliRunStatus>,
  runFilter?: (run: CliRun) => boolean,
): MenuOption<string>[] {
  const runs = withRunService((service) => service.listRuns({ profileId, statuses }));
  const filteredRuns = runFilter ? runs.filter((run) => runFilter(run)) : runs;
  return filteredRuns.map((run) => ({
    value: run.id,
    label: formatRunMenuLabel(run),
  }));
}

function isRunStartableFromInteractiveMenu(run: CliRun): boolean {
  return run.status === "pending" || (run.status === "failed" && !run.pipelineRunId);
}

function isRunResumableFromInteractiveMenu(run: CliRun): boolean {
  return run.pipelineRunId !== null;
}


function withRunService<T>(action: (service: CliRunService) => T): T {
  const service = new CliRunService();
  try {
    return action(service);
  } finally {
    service.close();
  }
}

function resolveUploadStatusPlatforms(
  profile: CliProfile,
  selection: UploadPlatformSelection,
): UploadPlatform[] {
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

  if (enabledPlatforms.length > 0) {
    return enabledPlatforms;
  }

  return ["youtube", "tiktok", "instagram"];
}

function collectNotUploadedClipIndexes(
  detail: RunDetail,
  uploadableClips: RunDetail["clips"],
  uploadPlatforms: ReadonlyArray<UploadPlatform>,
): number[] {
  const uploadsByClipPath = new Map<
    string,
    Map<UploadPlatform, { status: string; updatedAt: string }>
  >();

  for (const upload of detail.uploads) {
    const pathKey = normalizeClipPathKey(upload.clipPath);
    const uploadsByPlatform = uploadsByClipPath.get(pathKey) ?? new Map();
    const existing = uploadsByPlatform.get(upload.platform);
    if (!existing) {
      uploadsByPlatform.set(upload.platform, {
        status: upload.status,
        updatedAt: upload.updatedAt,
      });
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
      uploadsByPlatform.set(upload.platform, {
        status: upload.status,
        updatedAt: upload.updatedAt,
      });
      uploadsByClipPath.set(pathKey, uploadsByPlatform);
    }
  }

  const selectedIndexes = new Set<number>();
  for (const clip of uploadableClips) {
    if (!clip.finalReelPath) {
      continue;
    }

    const pathKey = normalizeClipPathKey(clip.finalReelPath);
    const uploadsByPlatform = uploadsByClipPath.get(pathKey);
    const uploadedEverywhere = uploadPlatforms.every(
      (platform) => uploadsByPlatform?.get(platform)?.status === "uploaded",
    );
    if (!uploadedEverywhere) {
      selectedIndexes.add(clip.clipIndex);
    }
  }

  return [...selectedIndexes].sort((left, right) => left - right);
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

function formatProfileMenuLabel(profile: CliProfile, defaultProfileId: string | null): string {
  const defaultTag = profile.id === defaultProfileId ? " (default)" : "";
  return `${profile.id}${defaultTag} — ${profile.creatorName}`;
}

function formatRunMenuLabel(run: CliRun): string {
  return `${run.id}: ${resolveRunBestTitle(run)} — status: ${run.status}`;
}

function resolveRunBestTitle(run: CliRun): string {
  const explicitTitle = normalizeMenuText(run.displayTitle);
  if (explicitTitle) {
    return explicitTitle;
  }

  const sourceTitle = resolveTitleFromSourceUrl(run.sourceUrl);
  if (sourceTitle) {
    return sourceTitle;
  }

  return "(untitled)";
}

function resolveTitleFromSourceUrl(sourceUrl: string | null): string | null {
  const normalizedSource = normalizeMenuText(sourceUrl);
  if (!normalizedSource) {
    return null;
  }

  try {
    const parsed = new URL(normalizedSource);
    const videoId = normalizeMenuText(parsed.searchParams.get("v"));
    if (videoId) {
      return videoId;
    }

    const pathSegments = parsed.pathname
      .split("/")
      .map((segment) => safeDecodeURIComponent(segment).trim())
      .filter((segment) => segment.length > 0);

    if (pathSegments.length > 0) {
      return pathSegments[pathSegments.length - 1];
    }

    return parsed.hostname;
  } catch {
    return normalizedSource;
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeMenuText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function appendOptionalOption(args: string[], optionName: string, value: string | null): void {
  if (!value) {
    return;
  }

  args.push(optionName, value);
}

function buildClipSelectionPreview(
  selectedPlatform: UploadPlatformSelection,
  availableClipCount: number,
  notUploadedClipCount: number,
): string {
  if (selectedPlatform === "all") {
    return `${availableClipCount} clip(s) available across selected platforms (${notUploadedClipCount} not fully uploaded yet).`;
  }

  return `${availableClipCount} clip(s) available for ${selectedPlatform} (${notUploadedClipCount} not uploaded yet).`;
}

function buildUploadSummary(input: UploadSummaryInput): string {
  const parts: string[] = [
    `platform=${input.selectedPlatform}`,
    `resolved=${input.resolvedPlatforms.join("+")}`,
    `selection=${input.clipSelectionMode}`,
  ];

  if (input.selectedClipCount !== null) {
    parts.push(`clips=${input.selectedClipCount}`);
  }

  if (input.randomCount !== null) {
    parts.push(`random=${input.randomCount}`);
  }

  if (input.maxClips !== null) {
    parts.push(`max=${input.maxClips}`);
  }

  parts.push(`description=${input.descriptionMode}`);
  if (input.metadataFile) {
    parts.push(`metadata=${input.metadataFile}`);
  }

  return parts.join(" | ");
}

function collectUploadPreflightFailures(input: UploadPreflightInput): string[] {
  const failures: string[] = [];
  const fileExists = input.fileExists ?? existsSync;
  const env = input.env ?? Bun.env;
  const platforms = new Set(input.uploadPlatforms);

  if (platforms.has("youtube")) {
    if (!env.YOUTUBE_CLIENT_ID?.trim()) {
      failures.push("YouTube requires YOUTUBE_CLIENT_ID.");
    }

    if (!env.YOUTUBE_CLIENT_SECRET?.trim()) {
      failures.push("YouTube requires YOUTUBE_CLIENT_SECRET.");
    }

    if (!fileExists(input.profile.oauthFilePath)) {
      failures.push(
        `YouTube OAuth file was not found at ${input.profile.oauthFilePath}. Run youtube-auth-url and youtube-auth-exchange first.`,
      );
    }
  }

  if (platforms.has("tiktok")) {
    if (!env.TIKTOK_CLIENT_KEY?.trim()) {
      failures.push("TikTok requires TIKTOK_CLIENT_KEY.");
    }

    if (!env.TIKTOK_CLIENT_SECRET?.trim()) {
      failures.push("TikTok requires TIKTOK_CLIENT_SECRET.");
    }

    const tiktokOAuthFile = env.TIKTOK_OAUTH_FILE?.trim() || defaultTikTokOAuthFilePath;
    if (!fileExists(tiktokOAuthFile)) {
      failures.push(
        `TikTok OAuth file was not found at ${tiktokOAuthFile}. Run tiktok-auth-url and tiktok-auth-exchange first.`,
      );
    }
  }

  if (platforms.has("instagram")) {
    if (!env.INSTAGRAM_CLIENT_ID?.trim()) {
      failures.push("Instagram requires INSTAGRAM_CLIENT_ID.");
    }

    if (!env.INSTAGRAM_CLIENT_SECRET?.trim()) {
      failures.push("Instagram requires INSTAGRAM_CLIENT_SECRET.");
    }

    if (!env.INSTAGRAM_IG_USER_ID?.trim()) {
      failures.push("Instagram uploads require INSTAGRAM_IG_USER_ID.");
    }

    const instagramOAuthFile =
      env.INSTAGRAM_OAUTH_FILE?.trim() || defaultInstagramOAuthFilePath;
    if (!fileExists(instagramOAuthFile)) {
      failures.push(
        `Instagram OAuth file was not found at ${instagramOAuthFile}. Run instagram-auth-url and instagram-auth-exchange first.`,
      );
    }
  }

  return failures;
}

function resolveRawQuickDigitSelection(
  keyName: string,
  optionCount: number,
): { type: "select"; index: number } | { type: "invalid" } | { type: "ignore" } {
  if (!/^\d$/.test(keyName)) {
    return { type: "ignore" };
  }

  const numericIndex = Number.parseInt(keyName, 10) - 1;
  if (numericIndex < 0 || numericIndex >= optionCount) {
    return { type: "invalid" };
  }

  return { type: "select", index: numericIndex };
}

function toggleRawQuickDigitSelection(
  toggledIndexes: Set<number>,
  keyName: string,
  optionCount: number,
): { type: "toggled"; index: number; selected: boolean } | { type: "invalid" } | { type: "ignore" } {
  const resolved = resolveRawQuickDigitSelection(keyName, optionCount);
  if (resolved.type === "ignore" || resolved.type === "invalid") {
    return resolved;
  }

  if (toggledIndexes.has(resolved.index)) {
    toggledIndexes.delete(resolved.index);
    return { type: "toggled", index: resolved.index, selected: false };
  }

  toggledIndexes.add(resolved.index);
  return { type: "toggled", index: resolved.index, selected: true };
}

function supportsRawNavigation(): boolean {
  return Boolean(input.isTTY && typeof input.setRawMode === "function");
}

function disableRawModeIfNeeded(): void {
  if (!supportsRawNavigation()) {
    return;
  }

  const rawInput = input as NodeJS.ReadStream & {
    isRaw?: boolean;
    setRawMode(mode: boolean): void;
  };

  if (rawInput.isRaw) {
    rawInput.setRawMode(false);
  }
}

function isReadlineClosedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "ERR_USE_AFTER_CLOSE";
}

function isInteractiveQuitSignal(error: unknown): boolean {
  return error instanceof InteractiveQuitSignal;
}

async function maybePauseAfterAction(rl: Interface, rawNavigation: boolean): Promise<void> {
  if (!rawNavigation) {
    return;
  }

  await rl.question("\nPress Enter to continue...");
}

async function askRequired(rl: Interface, question: string): Promise<string> {
  while (true) {
    const value = (await rl.question(question)).trim();
    if (value.length > 0) {
      return value;
    }

    console.log("Value is required.");
  }
}

async function askOptional(rl: Interface, question: string): Promise<string | null> {
  const value = (await rl.question(question)).trim();
  return value.length > 0 ? value : null;
}

export function parseOptionalBackInput(
  value: string,
  backKeyword = "/back",
): { type: "value"; value: string | null } | { type: "back" } {
  const normalizedValue = value.trim();
  if (normalizedValue.toLowerCase() === backKeyword.toLowerCase()) {
    return { type: "back" };
  }

  return {
    type: "value",
    value: normalizedValue.length > 0 ? normalizedValue : null,
  };
}

async function askOptionalWithBack(
  rl: Interface,
  question: string,
  backKeyword = "/back",
): Promise<{ type: "value"; value: string | null } | { type: "back" }> {
  const value = await rl.question(question);
  return parseOptionalBackInput(value, backKeyword);
}

async function askRequiredWithBack(
  rl: Interface,
  question: string,
  backKeyword = "/back",
): Promise<PromptValueResult<string>> {
  while (true) {
    const parsed = parseOptionalBackInput(await rl.question(question), backKeyword);
    if (parsed.type === "back") {
      return parsed;
    }

    if (parsed.value) {
      return { type: "value", value: parsed.value };
    }

    console.log("Value is required.");
  }
}

async function askDefaultWithBack(
  rl: Interface,
  label: string,
  fallback: string,
  backKeyword = "/back",
): Promise<PromptValueResult<string>> {
  const parsed = await askOptionalWithBack(
    rl,
    `${label} [${fallback}] (type ${backKeyword} to cancel): `,
    backKeyword,
  );
  if (parsed.type === "back") {
    return parsed;
  }

  return {
    type: "value",
    value: parsed.value ?? fallback,
  };
}

async function askDefault(rl: Interface, label: string, fallback: string): Promise<string> {
  const value = (await rl.question(`${label} [${fallback}]: `)).trim();
  return value.length > 0 ? value : fallback;
}

async function askYesNo(rl: Interface, label: string, fallback: boolean): Promise<boolean> {
  const defaultLabel = fallback ? "Y/n" : "y/N";

  while (true) {
    const value = (await rl.question(`${label} [${defaultLabel}]: `)).trim().toLowerCase();
    if (value.length === 0) {
      return fallback;
    }

    if (value === "y" || value === "yes") {
      return true;
    }

    if (value === "n" || value === "no") {
      return false;
    }

    console.log("Please enter y or n.");
  }
}

async function askYesNoWithBack(
  rl: Interface,
  label: string,
  fallback: boolean,
  backKeyword = "/back",
): Promise<PromptValueResult<boolean>> {
  const defaultLabel = fallback ? "Y/n" : "y/N";

  while (true) {
    const parsed = parseOptionalBackInput(
      await rl.question(`${label} [${defaultLabel}] (type ${backKeyword} to cancel): `),
      backKeyword,
    );
    if (parsed.type === "back") {
      return parsed;
    }

    if (parsed.value === null) {
      return { type: "value", value: fallback };
    }

    const value = parsed.value.toLowerCase();
    if (value === "y" || value === "yes") {
      return { type: "value", value: true };
    }

    if (value === "n" || value === "no") {
      return { type: "value", value: false };
    }

    console.log("Please enter y or n.");
  }
}

function isPromptAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "ABORT_ERR") {
    return true;
  }

  const name = "name" in error ? (error as { name?: unknown }).name : undefined;
  return name === "AbortError";
}
