import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

import {
  createCliProfile,
  deleteCliProfile,
  getDefaultCliProfile,
  loadCliProfileStore,
  saveCliProfileStore,
  setDefaultCliProfile,
  updateCliProfile,
} from "../../src/cli/profile-store";

const tmpRoot = join(import.meta.dir, "__tmp_profiles__");
const tmpFile = join(tmpRoot, "profiles.json");

afterEach((): void => {
  if (existsSync(tmpRoot)) {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

describe("cli profile store", () => {
  test("returns empty store when file does not exist", async () => {
    const store = await loadCliProfileStore(tmpFile);

    expect(store.defaultProfileId).toBeNull();
    expect(store.profiles).toEqual([]);
  });

  test("creates and persists a profile", async () => {
    const store = await loadCliProfileStore(tmpFile);

    const created = createCliProfile(store, {
      id: "jiang",
      creatorName: "Jiang",
      creditName: "Jiang Clips",
      defaultSourceUrl: "https://youtube.com/watch?v=abc",
      outputDir: "./output/jiang",
      oauthFilePath: "./data/jiang-oauth.json",
      uploadPrivacy: "unlisted",
    });

    await saveCliProfileStore(store, tmpFile);
    const loaded = await loadCliProfileStore(tmpFile);

    expect(created.id).toBe("jiang");
    expect(created.uploadMode).toBe("manual");
    expect(created.uploadToYouTube).toBe(true);
    expect(created.uploadToTikTok).toBe(true);
    expect(created.uploadToInstagram).toBe(true);
    expect(created.youtubeDescriptionTemplate).toBeNull();
    expect(created.tiktokCaptionTemplate).toBeNull();
    expect(created.instagramCaptionTemplate).toBeNull();

    expect(loaded.defaultProfileId).toBe("jiang");
    expect(loaded.profiles).toHaveLength(1);
    expect(loaded.profiles[0].creatorName).toBe("Jiang");
    expect(loaded.profiles[0].outputDir).toBe("./output/jiang");
    expect(loaded.profiles[0].uploadMode).toBe("manual");
    expect(loaded.profiles[0].uploadToYouTube).toBe(true);
    expect(loaded.profiles[0].uploadToTikTok).toBe(true);
    expect(loaded.profiles[0].uploadToInstagram).toBe(true);
    expect(loaded.profiles[0].youtubeDescriptionTemplate).toBeNull();
    expect(loaded.profiles[0].tiktokCaptionTemplate).toBeNull();
    expect(loaded.profiles[0].instagramCaptionTemplate).toBeNull();
  });

  test("loads legacy profile JSON and applies defaults for new fields", async () => {
    mkdirSync(tmpRoot, { recursive: true });
    await Bun.write(
      tmpFile,
      JSON.stringify(
        {
          defaultProfileId: "legacy",
          profiles: [
            {
              id: "legacy",
              creatorName: "Legacy Creator",
              defaultSourceUrl: null,
              creditName: "Legacy Credit",
              creditUrl: null,
              defaultDescription: null,
              outputDir: "./output/legacy",
              oauthFilePath: "./data/legacy-oauth.json",
              uploadPrivacy: "private",
              createdAt: "2025-01-01T00:00:00.000Z",
              updatedAt: "2025-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    const loaded = await loadCliProfileStore(tmpFile);
    const legacy = loaded.profiles[0];
    expect(legacy.uploadMode).toBe("manual");
    expect(legacy.uploadToYouTube).toBe(true);
    expect(legacy.uploadToTikTok).toBe(true);
    expect(legacy.uploadToInstagram).toBe(true);
    expect(legacy.youtubeDescriptionTemplate).toBeNull();
    expect(legacy.tiktokCaptionTemplate).toBeNull();
    expect(legacy.instagramCaptionTemplate).toBeNull();
  });


  test("updates and reassigns default when deleting default profile", async () => {
    const store = await loadCliProfileStore(tmpFile);

    createCliProfile(store, {
      id: "a",
      creatorName: "Creator A",
      creditName: "A",
    });

    createCliProfile(store, {
      id: "b",
      creatorName: "Creator B",
      creditName: "B",
      defaultSourceUrl: "https://youtube.com/watch?v=bbb",
    });

    setDefaultCliProfile(store, "b");

    const updated = updateCliProfile(store, "b", {
      creatorName: "Creator Bee",
      outputDir: "./output/bee",
      uploadMode: "auto",
      uploadToYouTube: false,
      uploadToTikTok: false,
      uploadToInstagram: false,
      youtubeDescriptionTemplate: "Youtube template",
      tiktokCaptionTemplate: "TikTok template",
      instagramCaptionTemplate: "   ",
    });

    expect(updated.creatorName).toBe("Creator Bee");
    expect(updated.outputDir).toBe("./output/bee");
    expect(updated.uploadMode).toBe("auto");
    expect(updated.uploadToYouTube).toBe(false);
    expect(updated.uploadToTikTok).toBe(false);
    expect(updated.uploadToInstagram).toBe(false);
    expect(updated.youtubeDescriptionTemplate).toBe("Youtube template");
    expect(updated.tiktokCaptionTemplate).toBe("TikTok template");
    expect(updated.instagramCaptionTemplate).toBeNull();
    expect(getDefaultCliProfile(store)?.id).toBe("b");

    const deleted = deleteCliProfile(store, "b");
    expect(deleted).toBe(true);
    expect(getDefaultCliProfile(store)?.id).toBe("a");
  });
});
