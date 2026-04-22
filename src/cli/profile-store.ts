import { dirname } from "path";

import { z } from "zod";

import { ensureDir } from "../utils/fs";

export type ProfileUploadPrivacy = "private" | "unlisted" | "public";
export type ProfileUploadMode = "manual" | "auto";

const defaultProfilesFilePath = "./data/cli-profiles.json";

const uploadPrivacySchema = z.enum(["private", "unlisted", "public"]);
const uploadModeSchema = z.enum(["manual", "auto"]);
const profileSchema = z.object({
  id: z.string().min(1),
  creatorName: z.string().min(1),
  defaultSourceUrl: z.string().min(1).nullable(),
  creditName: z.string().min(1),
  creditUrl: z.string().min(1).nullable(),
  defaultDescription: z.string().min(1).nullable(),
  outputDir: z.string().min(1),
  oauthFilePath: z.string().min(1),
  uploadPrivacy: uploadPrivacySchema,
  uploadMode: uploadModeSchema.default("manual"),
  uploadToYouTube: z.boolean().default(true),
  uploadToTikTok: z.boolean().default(true),
  uploadToInstagram: z.boolean().default(true),
  youtubeDescriptionTemplate: z.string().min(1).nullable().default(null),
  tiktokCaptionTemplate: z.string().min(1).nullable().default(null),
  instagramCaptionTemplate: z.string().min(1).nullable().default(null),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const profileStoreSchema = z.object({
  defaultProfileId: z.string().min(1).nullable(),
  profiles: z.array(profileSchema),
});

export type CliProfile = z.infer<typeof profileSchema>;
export type CliProfileStore = z.infer<typeof profileStoreSchema>;

export interface CreateCliProfileInput {
  id: string;
  creatorName: string;
  defaultSourceUrl?: string | null;
  creditName: string;
  creditUrl?: string | null;
  defaultDescription?: string | null;
  outputDir?: string;
  oauthFilePath?: string;
  uploadPrivacy?: ProfileUploadPrivacy;
  uploadMode?: ProfileUploadMode;
  uploadToYouTube?: boolean;
  uploadToTikTok?: boolean;
  uploadToInstagram?: boolean;
  youtubeDescriptionTemplate?: string | null;
  tiktokCaptionTemplate?: string | null;
  instagramCaptionTemplate?: string | null;
}

export interface UpdateCliProfileInput {
  creatorName?: string;
  defaultSourceUrl?: string | null;
  creditName?: string;
  creditUrl?: string | null;
  defaultDescription?: string | null;
  outputDir?: string;
  oauthFilePath?: string;
  uploadPrivacy?: ProfileUploadPrivacy;
  uploadMode?: ProfileUploadMode;
  uploadToYouTube?: boolean;
  uploadToTikTok?: boolean;
  uploadToInstagram?: boolean;
  youtubeDescriptionTemplate?: string | null;
  tiktokCaptionTemplate?: string | null;
  instagramCaptionTemplate?: string | null;
}

export function resolveProfilesFilePath(explicitPath?: string): string {
  const directValue = typeof explicitPath === "string" ? explicitPath.trim() : "";
  if (directValue.length > 0) {
    return directValue;
  }

  const envValue = Bun.env.CLIPS_PROFILES_FILE?.trim();
  if (envValue && envValue.length > 0) {
    return envValue;
  }

  return defaultProfilesFilePath;
}

export async function loadCliProfileStore(explicitPath?: string): Promise<CliProfileStore> {
  const profilesFilePath = resolveProfilesFilePath(explicitPath);
  const profileFile = Bun.file(profilesFilePath);

  if (!(await profileFile.exists())) {
    return emptyStore();
  }

  const raw = await profileFile.text();
  if (raw.trim().length === 0) {
    return emptyStore();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Profiles file contains invalid JSON: ${profilesFilePath}`);
  }

  const parsed = profileStoreSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(`Profiles file has invalid shape: ${profilesFilePath}`);
  }

  return normalizeStore(parsed.data);
}

export async function saveCliProfileStore(
  store: CliProfileStore,
  explicitPath?: string,
): Promise<void> {
  const profilesFilePath = resolveProfilesFilePath(explicitPath);
  const normalizedStore = normalizeStore(store);

  ensureDir(dirname(profilesFilePath));
  await Bun.write(profilesFilePath, `${JSON.stringify(normalizedStore, null, 2)}\n`);
}

export function createCliProfile(store: CliProfileStore, input: CreateCliProfileInput): CliProfile {
  const normalizedId = normalizeRequiredText(input.id, "id");
  if (store.profiles.some((profile) => profile.id === normalizedId)) {
    throw new Error(`Profile already exists: ${normalizedId}`);
  }

  const now = new Date().toISOString();
  const profile: CliProfile = {
    id: normalizedId,
    creatorName: normalizeRequiredText(input.creatorName, "creatorName"),
    defaultSourceUrl: normalizeOptionalText(input.defaultSourceUrl),
    creditName: normalizeRequiredText(input.creditName, "creditName"),
    creditUrl: normalizeOptionalText(input.creditUrl),
    defaultDescription: normalizeOptionalText(input.defaultDescription),
    outputDir: normalizeRequiredText(input.outputDir ?? "./output", "outputDir"),
    oauthFilePath: normalizeRequiredText(input.oauthFilePath ?? "./data/youtube-oauth.json", "oauthFilePath"),
    uploadPrivacy: normalizeUploadPrivacy(input.uploadPrivacy ?? "unlisted"),
    uploadMode: normalizeUploadMode(input.uploadMode ?? "manual"),
    uploadToYouTube:
      input.uploadToYouTube === undefined ? true : normalizeRequiredBoolean(input.uploadToYouTube, "uploadToYouTube"),
    uploadToTikTok:
      input.uploadToTikTok === undefined ? true : normalizeRequiredBoolean(input.uploadToTikTok, "uploadToTikTok"),
    uploadToInstagram:
      input.uploadToInstagram === undefined ? true : normalizeRequiredBoolean(input.uploadToInstagram, "uploadToInstagram"),
    youtubeDescriptionTemplate: normalizeOptionalText(input.youtubeDescriptionTemplate),
    tiktokCaptionTemplate: normalizeOptionalText(input.tiktokCaptionTemplate),
    instagramCaptionTemplate: normalizeOptionalText(input.instagramCaptionTemplate),
    createdAt: now,
    updatedAt: now,
  };

  store.profiles.push(profile);
  if (!store.defaultProfileId) {
    store.defaultProfileId = profile.id;
  }

  return profile;
}

export function updateCliProfile(
  store: CliProfileStore,
  profileId: string,
  patch: UpdateCliProfileInput,
): CliProfile {
  const normalizedId = normalizeRequiredText(profileId, "profileId");
  const profile = getCliProfileById(store, normalizedId);
  if (!profile) {
    throw new Error(`Profile not found: ${normalizedId}`);
  }

  if (patch.creatorName !== undefined) {
    profile.creatorName = normalizeRequiredText(patch.creatorName, "creatorName");
  }
  if (patch.defaultSourceUrl !== undefined) {
    profile.defaultSourceUrl = normalizeOptionalText(patch.defaultSourceUrl);
  }
  if (patch.creditName !== undefined) {
    profile.creditName = normalizeRequiredText(patch.creditName, "creditName");
  }
  if (patch.creditUrl !== undefined) {
    profile.creditUrl = normalizeOptionalText(patch.creditUrl);
  }
  if (patch.defaultDescription !== undefined) {
    profile.defaultDescription = normalizeOptionalText(patch.defaultDescription);
  }
  if (patch.outputDir !== undefined) {
    profile.outputDir = normalizeRequiredText(patch.outputDir, "outputDir");
  }
  if (patch.oauthFilePath !== undefined) {
    profile.oauthFilePath = normalizeRequiredText(patch.oauthFilePath, "oauthFilePath");
  }
  if (patch.uploadPrivacy !== undefined) {
    profile.uploadPrivacy = normalizeUploadPrivacy(patch.uploadPrivacy);
  }
  if (patch.uploadMode !== undefined) {
    profile.uploadMode = normalizeUploadMode(patch.uploadMode);
  }
  if (patch.uploadToYouTube !== undefined) {
    profile.uploadToYouTube = normalizeRequiredBoolean(patch.uploadToYouTube, "uploadToYouTube");
  }
  if (patch.uploadToTikTok !== undefined) {
    profile.uploadToTikTok = normalizeRequiredBoolean(patch.uploadToTikTok, "uploadToTikTok");
  }
  if (patch.uploadToInstagram !== undefined) {
    profile.uploadToInstagram = normalizeRequiredBoolean(patch.uploadToInstagram, "uploadToInstagram");
  }
  if (patch.youtubeDescriptionTemplate !== undefined) {
    profile.youtubeDescriptionTemplate = normalizeOptionalText(patch.youtubeDescriptionTemplate);
  }
  if (patch.tiktokCaptionTemplate !== undefined) {
    profile.tiktokCaptionTemplate = normalizeOptionalText(patch.tiktokCaptionTemplate);
  }
  if (patch.instagramCaptionTemplate !== undefined) {
    profile.instagramCaptionTemplate = normalizeOptionalText(patch.instagramCaptionTemplate);
  }

  profile.updatedAt = new Date().toISOString();

  return profile;
}

export function deleteCliProfile(store: CliProfileStore, profileId: string): boolean {
  const normalizedId = normalizeRequiredText(profileId, "profileId");
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((profile) => profile.id !== normalizedId);

  if (store.profiles.length === before) {
    return false;
  }

  if (store.defaultProfileId === normalizedId) {
    store.defaultProfileId = store.profiles.length > 0 ? store.profiles[0].id : null;
  }

  return true;
}

export function setDefaultCliProfile(store: CliProfileStore, profileId: string): CliProfile {
  const normalizedId = normalizeRequiredText(profileId, "profileId");
  const profile = getCliProfileById(store, normalizedId);
  if (!profile) {
    throw new Error(`Profile not found: ${normalizedId}`);
  }

  store.defaultProfileId = profile.id;
  return profile;
}

export function getCliProfileById(store: CliProfileStore, profileId: string): CliProfile | null {
  const normalizedId = normalizeRequiredText(profileId, "profileId");
  const found = store.profiles.find((profile) => profile.id === normalizedId);
  return found ?? null;
}

export function getDefaultCliProfile(store: CliProfileStore): CliProfile | null {
  if (!store.defaultProfileId) {
    return null;
  }

  return getCliProfileById(store, store.defaultProfileId);
}

function emptyStore(): CliProfileStore {
  return {
    defaultProfileId: null,
    profiles: [],
  };
}

function normalizeStore(store: CliProfileStore): CliProfileStore {
  const hasDefault =
    typeof store.defaultProfileId === "string" &&
    store.profiles.some((profile) => profile.id === store.defaultProfileId);

  return {
    defaultProfileId: hasDefault ? store.defaultProfileId : null,
    profiles: [...store.profiles],
  };
}

function normalizeRequiredText(value: string | null | undefined, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} is required.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeUploadMode(value: ProfileUploadMode): ProfileUploadMode {
  if (value === "manual" || value === "auto") {
    return value;
  }

  throw new Error(`Invalid upload mode: ${value}.`);
}

function normalizeRequiredBoolean(value: boolean | null | undefined, fieldName: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${fieldName} must be true or false.`);
  }

  return value;
}

function normalizeUploadPrivacy(value: ProfileUploadPrivacy): ProfileUploadPrivacy {
  if (value === "private" || value === "unlisted" || value === "public") {
    return value;
  }

  throw new Error(`Invalid upload privacy: ${value}.`);
}
