import { lstat, readdir, stat } from "fs/promises";
import { join, relative, resolve } from "path";

import { getInstagramAccessToken } from "./instagram-auth";

const DEFAULT_FACEBOOK_GRAPH_VERSION = "v25.0";
const DEFAULT_STATUS_POLL_INTERVAL_MS = 5_000;
const DEFAULT_STATUS_POLL_TIMEOUT_MS = 4 * 60_000;
const READY_STATUS_CODES = new Set(["FINISHED", "PUBLISHED"]);
const TERMINAL_STATUS_CODES = new Set(["ERROR", "EXPIRED"]);

export interface InstagramUploaderOptions {
  dir: string;
  igUserId: string;
  creditName: string;
  creditUrl?: string;
  captionTemplate?: string;
  uploads?: Array<{
    filePath: string;
    caption?: string | null;
    igUserId?: string | null;
  }>;
  oauthFilePath?: string;
  accessToken?: string;
  dryRun?: boolean;
  graphApiVersion?: string;
  statusPollIntervalMs?: number;
  statusPollTimeoutMs?: number;
}

export interface InstagramDryRunUploadResult {
  filePath: string;
  success: true;
  dryRun: true;
  igUserId: string;
  caption: string;
}

export interface InstagramUploadSuccessResult {
  filePath: string;
  success: true;
  dryRun: false;
  containerId: string;
  mediaId: string;
}

export interface InstagramUploadFailureResult {
  filePath: string;
  success: false;
  dryRun: false;
  error: string;
}

export type InstagramUploadResult =
  | InstagramDryRunUploadResult
  | InstagramUploadSuccessResult
  | InstagramUploadFailureResult;

interface UploadMetadata {
  filePath: string;
  igUserId: string;
  caption: string;
}

interface UploadContext {
  accessToken: string;
  graphApiVersion: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

interface CreatedMediaContainer {
  id: string;
  uploadUri: string;
}

interface ContainerStatus {
  statusCode: string;
  statusText: string | null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeGraphApiVersion(override?: string): string {
  const candidate = asNonEmptyString(override) || Bun.env.INSTAGRAM_GRAPH_API_VERSION?.trim();
  if (!candidate) return DEFAULT_FACEBOOK_GRAPH_VERSION;

  const normalized = candidate.startsWith("v") ? candidate : `v${candidate}`;
  if (!/^v\d+\.\d+$/.test(normalized)) {
    throw new Error(`Invalid graphApiVersion "${candidate}". Use format v25.0 or 25.0.`);
  }

  return normalized;
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
  optionName: string,
): number {
  if (value === undefined) return fallback;
  if (Number.isInteger(value) && value > 0) return value;
  throw new Error(`${optionName} must be a positive integer.`);
}

function normalizeIgUserId(raw: string): string {
  const igUserId = raw.trim();
  if (!igUserId) {
    throw new Error("igUserId is required.");
  }

  if (!/^\d+$/.test(igUserId)) {
    throw new Error(
      `igUserId "${raw}" is invalid. Use the numeric Instagram user id from /me?fields=user_id.`,
    );
  }

  return igUserId;
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

export function generateDefaultInstagramCaption(creditName: string, creditUrl?: string): string {
  const normalizedCreditName = creditName.trim();
  if (normalizedCreditName.length === 0) {
    throw new Error("creditName is required.");
  }

  const captionLines = [`Credit: ${normalizedCreditName}`];
  const normalizedCreditUrl = creditUrl?.trim();
  if (normalizedCreditUrl && normalizedCreditUrl.length > 0) {
    captionLines.push(`Credit URL: ${normalizedCreditUrl}`);
  }

  captionLines.push(`Original creator: ${normalizedCreditName}`);
  captionLines.push("#reels");

  return captionLines.join("\n");
}

export async function uploadInstagramReels(
  options: InstagramUploaderOptions,
): Promise<InstagramUploadResult[]> {
  const igUserId = normalizeIgUserId(options.igUserId);
  const normalizedCreditName = options.creditName.trim();
  if (normalizedCreditName.length === 0) {
    throw new Error("creditName is required.");
  }

  const defaultCaption = generateDefaultInstagramCaption(normalizedCreditName, options.creditUrl);
  const normalizedCaptionTemplate = options.captionTemplate?.trim();
  const caption =
    normalizedCaptionTemplate && normalizedCaptionTemplate.length > 0
      ? `${normalizedCaptionTemplate}\n\n${defaultCaption}`
      : defaultCaption;

  let plannedUploads: UploadMetadata[];

  if (options.uploads && options.uploads.length > 0) {
    const resolvedInputDir = resolve(options.dir);
    plannedUploads = options.uploads.map((upload) => {
      const normalizedFilePath = asNonEmptyString(upload.filePath);
      if (!normalizedFilePath) {
        throw new Error("uploads[].filePath is required.");
      }

      const normalizedUploadIgUserId = asNonEmptyString(upload.igUserId);
      const normalizedCaptionOverride = asNonEmptyString(upload.caption);

      return {
        filePath: resolve(resolvedInputDir, normalizedFilePath),
        igUserId: normalizedUploadIgUserId ? normalizeIgUserId(normalizedUploadIgUserId) : igUserId,
        caption: normalizedCaptionOverride ?? caption,
      } satisfies UploadMetadata;
    });
  } else {
    const mp4Files = await discoverMp4Files(options.dir);
    if (mp4Files.length === 0) {
      throw new Error(`No .mp4 files found in directory: ${options.dir}`);
    }

    plannedUploads = mp4Files.map(
      (filePath) =>
        ({
          filePath,
          igUserId,
          caption,
        }) satisfies UploadMetadata,
    );
  }

  if (options.dryRun) {
    return plannedUploads.map(
      (upload): InstagramDryRunUploadResult => ({
        filePath: upload.filePath,
        success: true,
        dryRun: true,
        igUserId: upload.igUserId,
        caption: upload.caption,
      }),
    );
  }

  const providedAccessToken = options.accessToken?.trim();
  const accessToken =
    providedAccessToken !== undefined
      ? providedAccessToken
      : await getInstagramAccessToken({ oauthFilePath: options.oauthFilePath });

  if (!accessToken) {
    throw new Error(
      "Instagram access token is empty. Provide accessToken or configure oauthFilePath with a valid token.",
    );
  }

  const pollIntervalMs = normalizePositiveInteger(
    options.statusPollIntervalMs,
    DEFAULT_STATUS_POLL_INTERVAL_MS,
    "statusPollIntervalMs",
  );
  const pollTimeoutMs = normalizePositiveInteger(
    options.statusPollTimeoutMs,
    DEFAULT_STATUS_POLL_TIMEOUT_MS,
    "statusPollTimeoutMs",
  );

  if (pollIntervalMs >= pollTimeoutMs) {
    throw new Error("statusPollTimeoutMs must be larger than statusPollIntervalMs.");
  }

  const context: UploadContext = {
    accessToken,
    graphApiVersion: normalizeGraphApiVersion(options.graphApiVersion),
    pollIntervalMs,
    pollTimeoutMs,
  };

  const results: InstagramUploadResult[] = [];
  for (const upload of plannedUploads) {
    results.push(await uploadSingleFile(upload, context));
  }

  return results;
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
  context: UploadContext,
): Promise<InstagramUploadSuccessResult | InstagramUploadFailureResult> {
  try {
    const container = await createResumableMediaContainer(upload, context);
    await uploadMediaBytes(upload.filePath, container.uploadUri, context.accessToken);
    await waitForPublishReadyStatus(container.id, context);
    const mediaId = await publishMediaContainer(upload.igUserId, container.id, context);

    return {
      filePath: upload.filePath,
      success: true,
      dryRun: false,
      containerId: container.id,
      mediaId,
    };
  } catch (error: unknown) {
    return {
      filePath: upload.filePath,
      success: false,
      dryRun: false,
      error: toErrorMessage(error),
    };
  }
}

async function createResumableMediaContainer(
  upload: UploadMetadata,
  context: UploadContext,
): Promise<CreatedMediaContainer> {
  const response = await fetch(buildGraphUrl(context.graphApiVersion, `${upload.igUserId}/media`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      media_type: "REELS",
      upload_type: "resumable",
      caption: upload.caption,
    }),
  });

  const { payload, raw } = await parseJsonBody(response);
  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || `${response.status} ${response.statusText}`;
    throw new Error(`Create media container failed (${response.status}): ${providerMessage}`);
  }

  if (!isRecord(payload)) {
    throw new Error("Create media container failed: invalid response payload.");
  }

  const containerId = asNonEmptyString(payload.id);
  if (!containerId) {
    throw new Error("Create media container failed: missing container id in response.");
  }

  const uploadUri =
    asNonEmptyString(payload.uri) ||
    `https://rupload.facebook.com/ig-api-upload/${context.graphApiVersion}/${containerId}`;

  return {
    id: containerId,
    uploadUri,
  };
}

async function uploadMediaBytes(filePath: string, uploadUri: string, accessToken: string): Promise<void> {
  const fileStats = await stat(filePath);
  const fileBytes = await Bun.file(filePath).arrayBuffer();

  const response = await fetch(uploadUri, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${accessToken}`,
      offset: "0",
      file_size: String(fileStats.size),
    },
    body: fileBytes,
  });

  const { payload, raw } = await parseJsonBody(response);
  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || `${response.status} ${response.statusText}`;
    throw new Error(`Upload media bytes failed (${response.status}): ${providerMessage}`);
  }

  if (isRecord(payload) && payload.success === false) {
    const providerMessage = providerErrorMessage(payload) || "unknown provider error";
    throw new Error(`Upload media bytes failed: ${providerMessage}`);
  }
}

async function waitForPublishReadyStatus(containerId: string, context: UploadContext): Promise<void> {
  const startedAt = Date.now();
  let lastStatusCode = "UNKNOWN";

  while (Date.now() - startedAt <= context.pollTimeoutMs) {
    const status = await readContainerStatus(containerId, context);
    lastStatusCode = status.statusCode;

    if (READY_STATUS_CODES.has(status.statusCode)) {
      return;
    }

    if (TERMINAL_STATUS_CODES.has(status.statusCode)) {
      const details = status.statusText ? `: ${status.statusText}` : "";
      throw new Error(
        `Container ${containerId} reached terminal status ${status.statusCode}${details}.`,
      );
    }

    await Bun.sleep(context.pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for container ${containerId} to become publish-ready after ${context.pollTimeoutMs}ms. Last status: ${lastStatusCode}.`,
  );
}

async function readContainerStatus(containerId: string, context: UploadContext): Promise<ContainerStatus> {
  const response = await fetch(
    buildGraphUrl(context.graphApiVersion, containerId, {
      fields: "status_code,status",
    }),
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
      },
    },
  );

  const { payload, raw } = await parseJsonBody(response);
  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || `${response.status} ${response.statusText}`;
    throw new Error(`Read container status failed (${response.status}): ${providerMessage}`);
  }

  if (!isRecord(payload)) {
    throw new Error("Read container status failed: invalid response payload.");
  }

  const statusCode = asNonEmptyString(payload.status_code)?.toUpperCase();
  if (!statusCode) {
    throw new Error("Read container status failed: response missing status_code.");
  }

  return {
    statusCode,
    statusText: asNonEmptyString(payload.status),
  };
}

async function publishMediaContainer(
  igUserId: string,
  containerId: string,
  context: UploadContext,
): Promise<string> {
  const response = await fetch(buildGraphUrl(context.graphApiVersion, `${igUserId}/media_publish`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      creation_id: containerId,
    }),
  });

  const { payload, raw } = await parseJsonBody(response);
  if (!response.ok) {
    const providerMessage =
      providerErrorMessage(payload) || trimErrorMessage(raw) || `${response.status} ${response.statusText}`;
    throw new Error(`Publish media failed (${response.status}): ${providerMessage}`);
  }

  if (!isRecord(payload)) {
    throw new Error("Publish media failed: invalid response payload.");
  }

  const mediaId = asNonEmptyString(payload.id);
  if (!mediaId) {
    throw new Error("Publish media failed: missing media id in response.");
  }

  return mediaId;
}

function buildGraphUrl(
  graphApiVersion: string,
  path: string,
  query: Record<string, string> = {},
): string {
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  const params = new URLSearchParams(query);
  const baseUrl = `https://graph.facebook.com/${graphApiVersion}/${normalizedPath}`;
  const queryString = params.toString();
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
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

function providerErrorMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  const topMessage = asNonEmptyString(payload.message);
  const error = payload.error;
  if (isRecord(error)) {
    const type = asNonEmptyString(error.type);
    const message = asNonEmptyString(error.message) || asNonEmptyString(error.error_user_msg);
    const code = asPositiveNumber(error.code);

    if (type && message && code) return `${type} (${code}): ${message}`;
    if (type && message) return `${type}: ${message}`;
    if (message && code) return `(${code}) ${message}`;
    if (message) return message;
  }

  const debugInfo = payload.debug_info;
  if (isRecord(debugInfo)) {
    const debugType = asNonEmptyString(debugInfo.type);
    const debugMessage = asNonEmptyString(debugInfo.message);

    if (debugMessage) {
      const nestedMessage = nestedProviderErrorMessage(debugMessage) || debugMessage;
      if (debugType) return `${debugType}: ${nestedMessage}`;
      return nestedMessage;
    }
  }

  return topMessage;
}

function nestedProviderErrorMessage(message: string): string | null {
  try {
    return providerErrorMessage(JSON.parse(message));
  } catch {
    return null;
  }
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
  return "Instagram upload failed.";
}
