import { lstat, readdir, stat } from "fs/promises";
import { basename, extname, join, relative, resolve } from "path";

import { getTikTokAccessToken } from "./tiktok-auth";

const TIKTOK_VIDEO_INIT_ENDPOINT = "https://open.tiktokapis.com/v2/post/publish/video/init/";
const TIKTOK_STATUS_ENDPOINT = "https://open.tiktokapis.com/v2/post/publish/status/fetch/";
const TIKTOK_MAX_CAPTION_LENGTH = 2200;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 5000;
const DEFAULT_STATUS_POLL_TIMEOUT_MS = 15 * 60 * 1000;

const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;

type TikTokTerminalPublishStatus = "PUBLISH_COMPLETE";

export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export interface TikTokUploadInput {
  filePath: string;
  caption?: string | null;
  privacyLevel?: TikTokPrivacyLevel | null;
}

export interface TikTokUploaderOptions {
  dir: string;
  privacyLevel?: TikTokPrivacyLevel;
  creditName: string;
  creditUrl?: string;
  oauthFilePath?: string;
  accessToken?: string;
  captionTemplate?: string;
  uploads?: TikTokUploadInput[];
  dryRun?: boolean;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface TikTokDryRunUploadResult {
  filePath: string;
  success: true;
  dryRun: true;
  caption: string;
  privacyLevel: TikTokPrivacyLevel;
}

export interface TikTokUploadSuccessResult {
  filePath: string;
  success: true;
  dryRun: false;
  publishId: string;
  status: TikTokTerminalPublishStatus;
  postId?: string;
}

export interface TikTokUploadFailureResult {
  filePath: string;
  success: false;
  dryRun: false;
  publishId?: string;
  status?: string;
  error: string;
}

export type TikTokUploadResult =
  | TikTokDryRunUploadResult
  | TikTokUploadSuccessResult
  | TikTokUploadFailureResult;

interface UploadMetadata {
  filePath: string;
  caption: string;
  privacyLevel: TikTokPrivacyLevel;
}

interface TikTokApiErrorDetails {
  code: string;
  message: string;
  logId?: string;
}

interface InitializedTikTokUpload {
  publishId: string;
  uploadUrl: string;
}

interface PublishStatusSnapshot {
  status: string;
  failReason?: string;
  postId?: string;
}

interface PollingOptions {
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export async function discoverMp4Files(inputDir: string): Promise<string[]> {
  const resolvedInputDir = resolve(inputDir);

  let directoryStats;
  try {
    directoryStats = await lstat(resolvedInputDir);
  } catch {
    throw new Error(`Input directory not found: ${inputDir}`);
  }

  if (!directoryStats.isDirectory()) {
    throw new Error(`Input path is not a directory: ${inputDir}`);
  }

  const files: string[] = [];
  await collectMp4Files(resolvedInputDir, files);
  files.sort((left, right) => compareByRelativePath(resolvedInputDir, left, right));

  return files;
}

export function generateDefaultTikTokTitle(filePath: string): string {
  const filename = basename(filePath, extname(filePath));
  const tokens = filename
    .replace(/[_-]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  while (tokens.length > 1 && /^\d+$/.test(tokens[0])) {
    tokens.shift();
  }

  const humanTitle = tokens
    .map((token) => {
      if (/^\d+$/.test(token)) {
        return token;
      }
      return `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`;
    })
    .join(" ")
    .trim();

  const safeTitle = humanTitle.length > 0 ? humanTitle : "Clip";
  return safeTitle.slice(0, 120).trim();
}

export function generateDefaultTikTokCaption(
  filePath: string,
  creditName: string,
  creditUrl?: string,
): string {
  const normalizedCreditName = creditName.trim();
  if (normalizedCreditName.length === 0) {
    throw new Error("creditName is required.");
  }

  const captionLines = [generateDefaultTikTokTitle(filePath), `Credit: ${normalizedCreditName}`];
  const normalizedCreditUrl = creditUrl?.trim();
  if (normalizedCreditUrl && normalizedCreditUrl.length > 0) {
    captionLines.push(`Credit URL: ${normalizedCreditUrl}`);
  }

  return clampCaption(captionLines.join("\n"));
}

export async function uploadTikTokVideos(options: TikTokUploaderOptions): Promise<TikTokUploadResult[]> {
  const normalizedCreditName = options.creditName.trim();
  if (normalizedCreditName.length === 0) {
    throw new Error("creditName is required.");
  }

  const privacyLevel = normalizePrivacyLevel(options.privacyLevel);
  const pollIntervalMs = normalizePositiveInteger(
    options.pollIntervalMs,
    "pollIntervalMs",
    DEFAULT_STATUS_POLL_INTERVAL_MS,
  );
  const pollTimeoutMs = normalizePositiveInteger(
    options.pollTimeoutMs,
    "pollTimeoutMs",
    DEFAULT_STATUS_POLL_TIMEOUT_MS,
  );

  if (pollIntervalMs > pollTimeoutMs) {
    throw new Error("pollIntervalMs must be less than or equal to pollTimeoutMs.");
  }

  const normalizedCaptionTemplate = options.captionTemplate?.trim();

  let plannedUploads: UploadMetadata[];
  if (options.uploads && options.uploads.length > 0) {
    plannedUploads = options.uploads.map((upload) => {
      const filePath = resolveUploadEntryFilePath(options.dir, upload.filePath);
      const defaultCaption = generateDefaultTikTokCaption(filePath, normalizedCreditName, options.creditUrl);
      const normalizedCaptionOverride = upload.caption?.trim();
      const caption = normalizedCaptionOverride
        ? clampCaption(normalizedCaptionOverride)
        : mergeCaptionTemplate(normalizedCaptionTemplate, defaultCaption);
      const uploadPrivacyLevel =
        upload.privacyLevel === null || upload.privacyLevel === undefined
          ? privacyLevel
          : normalizePrivacyLevel(upload.privacyLevel);

      return {
        filePath,
        caption,
        privacyLevel: uploadPrivacyLevel,
      } satisfies UploadMetadata;
    });
  } else {
    const mp4Files = await discoverMp4Files(options.dir);
    if (mp4Files.length === 0) {
      throw new Error(`No .mp4 files found in directory: ${options.dir}`);
    }

    plannedUploads = mp4Files.map((filePath) => {
      const defaultCaption = generateDefaultTikTokCaption(filePath, normalizedCreditName, options.creditUrl);
      const caption = mergeCaptionTemplate(normalizedCaptionTemplate, defaultCaption);

      return {
        filePath,
        caption,
        privacyLevel,
      } satisfies UploadMetadata;
    });
  }
  if (options.dryRun) {
    return plannedUploads.map(
      (upload): TikTokDryRunUploadResult => ({
        filePath: upload.filePath,
        success: true,
        dryRun: true,
        caption: upload.caption,
        privacyLevel: upload.privacyLevel,
      }),
    );
  }

  const providedAccessToken = options.accessToken?.trim();
  const accessToken =
    providedAccessToken !== undefined
      ? providedAccessToken
      : await getTikTokAccessToken({ oauthFilePath: options.oauthFilePath });

  if (!accessToken) {
    throw new Error(
      "TikTok access token is empty. Provide accessToken or configure oauthFilePath with a valid refresh token.",
    );
  }

  const pollingOptions: PollingOptions = { pollIntervalMs, pollTimeoutMs };
  const results: TikTokUploadResult[] = [];

  for (const upload of plannedUploads) {
    results.push(await uploadSingleFile(upload, accessToken, pollingOptions));
  }

  return results;
}

function resolveUploadEntryFilePath(dir: string, filePath: string): string {
  const normalizedFilePath = filePath.trim();
  if (!normalizedFilePath) {
    throw new Error("uploads.filePath is required.");
  }

  return resolve(dir, normalizedFilePath);
}


async function collectMp4Files(currentDir: string, files: string[]): Promise<void> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  entries.sort((left, right) => compareName(left.name, right.name));

  for (const entry of entries) {
    const entryPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await collectMp4Files(entryPath, files);
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".mp4")) {
      files.push(entryPath);
    }
  }
}

async function uploadSingleFile(
  upload: UploadMetadata,
  accessToken: string,
  pollingOptions: PollingOptions,
): Promise<TikTokUploadSuccessResult | TikTokUploadFailureResult> {
  let publishId: string | undefined;
  let lastStatus: string | undefined;

  try {
    const initializedUpload = await initializeUpload(upload, accessToken);
    publishId = initializedUpload.publishId;

    await uploadBytes(upload.filePath, initializedUpload.uploadUrl);

    const finalStatus = await pollForTerminalStatus(
      initializedUpload.publishId,
      accessToken,
      pollingOptions,
      (status) => {
        lastStatus = status;
      },
    );

    return {
      filePath: upload.filePath,
      success: true,
      dryRun: false,
      publishId: initializedUpload.publishId,
      status: "PUBLISH_COMPLETE",
      postId: finalStatus.postId,
    };
  } catch (error: unknown) {
    return {
      filePath: upload.filePath,
      success: false,
      dryRun: false,
      publishId,
      status: lastStatus,
      error: toErrorMessage(error),
    };
  }
}

async function initializeUpload(
  upload: UploadMetadata,
  accessToken: string,
): Promise<InitializedTikTokUpload> {
  const fileStats = await stat(upload.filePath);

  if (fileStats.size <= 0) {
    throw new Error(`Video file is empty: ${upload.filePath}`);
  }

  let initResponse: Response;

  try {
    initResponse = await fetch(TIKTOK_VIDEO_INIT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        post_info: {
          title: upload.caption,
          privacy_level: upload.privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          brand_content_toggle: false,
          brand_organic_toggle: false,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileStats.size,
          chunk_size: fileStats.size,
          total_chunk_count: 1,
        },
      }),
    });
  } catch {
    throw new Error("Could not reach TikTok upload init endpoint. Check your network and retry.");
  }

  const { payload, raw } = await parseJsonBody(initResponse);
  const providerError = readTikTokApiError(payload);

  if (!initResponse.ok) {
    const errorMessage =
      providerError?.message || trimErrorMessage(raw) || `${initResponse.status} ${initResponse.statusText}`;
    throw new Error(`TikTok upload init failed (${initResponse.status}): ${errorMessage}`);
  }

  if (providerError && providerError.code !== "ok") {
    throw new Error(`TikTok upload init failed: ${formatTikTokApiError(providerError)}`);
  }

  if (payload === null) {
    throw new Error("TikTok upload init returned an empty response body.");
  }

  const data = getDataObject(payload);
  if (!data) {
    throw new Error("TikTok upload init response is missing data payload.");
  }

  const publishId = asNonEmptyString(data.publish_id);
  if (!publishId) {
    throw new Error("TikTok upload init response is missing publish_id.");
  }

  const uploadUrl = asNonEmptyString(data.upload_url);
  if (!uploadUrl) {
    throw new Error("TikTok upload init response is missing upload_url.");
  }

  return { publishId, uploadUrl };
}

async function uploadBytes(filePath: string, uploadUrl: string): Promise<void> {
  const fileBytes = await Bun.file(filePath).arrayBuffer();
  if (fileBytes.byteLength === 0) {
    throw new Error(`Video file is empty: ${filePath}`);
  }

  let uploadResponse: Response;

  try {
    uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(fileBytes.byteLength),
        "Content-Range": `bytes 0-${fileBytes.byteLength - 1}/${fileBytes.byteLength}`,
      },
      body: fileBytes,
    });
  } catch {
    throw new Error("Could not upload video bytes to TikTok. Check your network and retry.");
  }

  if (!uploadResponse.ok) {
    const errorMessage = await readResponseError(uploadResponse);
    throw new Error(`TikTok media upload failed (${uploadResponse.status}): ${errorMessage}`);
  }
}

async function pollForTerminalStatus(
  publishId: string,
  accessToken: string,
  pollingOptions: PollingOptions,
  onStatus: (status: string) => void,
): Promise<PublishStatusSnapshot> {
  const startedAt = Date.now();
  let lastSeenStatus = "UNKNOWN";

  while (true) {
    const statusSnapshot = await fetchPublishStatus(publishId, accessToken);
    lastSeenStatus = statusSnapshot.status;
    onStatus(statusSnapshot.status);

    if (statusSnapshot.status === "PUBLISH_COMPLETE") {
      return statusSnapshot;
    }

    if (statusSnapshot.status === "FAILED") {
      const reason = statusSnapshot.failReason ? `: ${statusSnapshot.failReason}` : "";
      throw new Error(`TikTok publish failed for ${publishId}${reason}`);
    }

    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= pollingOptions.pollTimeoutMs) {
      throw new Error(
        `Timed out waiting for TikTok publish status for ${publishId} after ${pollingOptions.pollTimeoutMs}ms (last status: ${lastSeenStatus}).`,
      );
    }

    await sleep(pollingOptions.pollIntervalMs);
  }
}

async function fetchPublishStatus(
  publishId: string,
  accessToken: string,
): Promise<PublishStatusSnapshot> {
  let statusResponse: Response;

  try {
    statusResponse = await fetch(TIKTOK_STATUS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({ publish_id: publishId }),
    });
  } catch {
    throw new Error("Could not reach TikTok status endpoint. Check your network and retry.");
  }

  const { payload, raw } = await parseJsonBody(statusResponse);
  const providerError = readTikTokApiError(payload);

  if (!statusResponse.ok) {
    const errorMessage =
      providerError?.message || trimErrorMessage(raw) || `${statusResponse.status} ${statusResponse.statusText}`;
    throw new Error(`TikTok status fetch failed (${statusResponse.status}): ${errorMessage}`);
  }

  if (providerError && providerError.code !== "ok") {
    throw new Error(`TikTok status fetch failed: ${formatTikTokApiError(providerError)}`);
  }

  if (payload === null) {
    throw new Error("TikTok status fetch returned an empty response body.");
  }

  const data = getDataObject(payload);
  if (!data) {
    throw new Error("TikTok status fetch response is missing data payload.");
  }

  const status = asNonEmptyString(data.status);
  if (!status) {
    throw new Error("TikTok status fetch response is missing status.");
  }

  return {
    status,
    failReason: asNonEmptyString(data.fail_reason) ?? undefined,
    postId: parsePostId(data.publicaly_available_post_id ?? data.publicly_available_post_id),
  };
}

async function parseJsonBody(response: Response): Promise<{ payload: unknown; raw: string }> {
  const raw = await response.text();
  if (!raw.trim()) return { payload: null, raw };

  try {
    return { payload: JSON.parse(raw), raw };
  } catch {
    return { payload: null, raw };
  }
}

function readTikTokApiError(payload: unknown): TikTokApiErrorDetails | null {
  if (!isRecord(payload)) return null;

  const errorPayload = payload.error;
  const errorDescription = asNonEmptyString(payload.error_description);
  const topLevelLogId = asNonEmptyString(payload.log_id);

  if (isRecord(errorPayload)) {
    const code = asNonEmptyString(errorPayload.code) || "unknown_error";
    const message =
      asNonEmptyString(errorPayload.message) || errorDescription || "TikTok API returned an error.";
    const logId =
      asNonEmptyString(errorPayload.log_id) || asNonEmptyString(errorPayload.logId) || topLevelLogId;
    return { code, message, logId: logId ?? undefined };
  }

  if (typeof errorPayload === "string") {
    const code = errorPayload.trim() || "unknown_error";
    const message = errorDescription || code;
    return { code, message, logId: topLevelLogId ?? undefined };
  }

  if (errorDescription) {
    return {
      code: "unknown_error",
      message: errorDescription,
      logId: topLevelLogId ?? undefined,
    };
  }

  return null;
}

function formatTikTokApiError(error: TikTokApiErrorDetails): string {
  const base = `${error.code}: ${error.message}`;
  if (!error.logId) return base;
  return `${base} (log_id: ${error.logId})`;
}

function getDataObject(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;

  const data = payload.data;
  if (!isRecord(data)) return null;

  return data;
}

function parsePostId(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === "string" && first.trim().length > 0) {
      return first.trim();
    }
    if (typeof first === "number" && Number.isFinite(first)) {
      return String(first);
    }
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  return undefined;
}

async function readResponseError(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  const text = (await response.text()).trim();
  if (!text) {
    return fallback;
  }

  try {
    const payload = JSON.parse(text);
    const providerError = readTikTokApiError(payload);
    if (providerError) {
      return formatTikTokApiError(providerError);
    }
  } catch {
    // Use raw text fallback.
  }

  return trimErrorMessage(text) || fallback;
}

function normalizePrivacyLevel(input: TikTokPrivacyLevel | undefined): TikTokPrivacyLevel {
  if (input === undefined) {
    return "SELF_ONLY";
  }

  if (isTikTokPrivacyLevel(input)) {
    return input;
  }

  throw new Error(
    `privacyLevel must be one of: ${TIKTOK_PRIVACY_LEVELS.join(", ")}. Query /creator_info/query/ to fetch the user's allowed options.`,
  );
}

function isTikTokPrivacyLevel(input: string): input is TikTokPrivacyLevel {
  return (TIKTOK_PRIVACY_LEVELS as readonly string[]).includes(input);
}

function normalizePositiveInteger(
  value: number | undefined,
  optionName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${optionName} must be a positive integer.`);
  }

  return value;
}

function mergeCaptionTemplate(template: string | undefined, defaultCaption: string): string {
  const normalizedTemplate = template?.trim();
  if (!normalizedTemplate) {
    return defaultCaption;
  }

  const separator = "\n\n";
  const availableTemplateChars =
    TIKTOK_MAX_CAPTION_LENGTH - defaultCaption.length - separator.length;

  if (availableTemplateChars <= 0) {
    return defaultCaption;
  }

  const clampedTemplate = normalizedTemplate.slice(0, availableTemplateChars).trim();
  if (!clampedTemplate) {
    return defaultCaption;
  }

  return `${clampedTemplate}${separator}${defaultCaption}`;
}

function clampCaption(caption: string): string {
  const normalizedCaption = caption.trim();
  if (!normalizedCaption) {
    throw new Error("Caption is empty. Provide creditName and ensure file names are not blank.");
  }

  if (normalizedCaption.length <= TIKTOK_MAX_CAPTION_LENGTH) {
    return normalizedCaption;
  }

  return normalizedCaption.slice(0, TIKTOK_MAX_CAPTION_LENGTH).trimEnd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function trimErrorMessage(text: string): string | null {
  const normalized = text.trim();
  if (!normalized) return null;
  if (normalized.length <= 240) return normalized;
  return `${normalized.slice(0, 237)}...`;
}

function compareByRelativePath(rootDir: string, leftPath: string, rightPath: string): number {
  const leftRelative = normalizePathForSort(relative(rootDir, leftPath));
  const rightRelative = normalizePathForSort(relative(rootDir, rightPath));

  const caseInsensitive = compareName(leftRelative.toLowerCase(), rightRelative.toLowerCase());
  if (caseInsensitive !== 0) {
    return caseInsensitive;
  }

  return compareName(leftRelative, rightRelative);
}

function normalizePathForSort(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

function compareName(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "TikTok upload failed.";
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
