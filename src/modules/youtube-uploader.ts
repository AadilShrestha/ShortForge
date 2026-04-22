import { lstat, readdir, stat } from "fs/promises";
import { basename, extname, join, relative, resolve } from "path";

import { getYouTubeAccessToken } from "./youtube-auth";

const YOUTUBE_RESUMABLE_UPLOAD_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

export type YouTubePrivacyStatus = "private" | "unlisted" | "public";

export interface YouTubeUploaderOptions {
  dir: string;
  privacyStatus?: YouTubePrivacyStatus;
  selfDeclaredMadeForKids?: boolean;
  creditName: string;
  creditUrl?: string;
  oauthFilePath?: string;
  accessToken?: string;
  descriptionTemplate?: string;
  uploads?: Array<{
    filePath: string;
    title?: string | null;
    description?: string | null;
  }>;
  dryRun?: boolean;
}

export interface YouTubeDryRunUploadResult {
  filePath: string;
  success: true;
  dryRun: true;
  title: string;
  description: string;
  privacyStatus: YouTubePrivacyStatus;
  selfDeclaredMadeForKids: boolean;
}

export interface YouTubeUploadSuccessResult {
  filePath: string;
  success: true;
  dryRun: false;
  videoId: string;
}

export interface YouTubeUploadFailureResult {
  filePath: string;
  success: false;
  dryRun: false;
  error: string;
}

export type YouTubeUploadResult =
  | YouTubeDryRunUploadResult
  | YouTubeUploadSuccessResult
  | YouTubeUploadFailureResult;

interface UploadMetadata {
  filePath: string;
  title: string;
  description: string;
  privacyStatus: YouTubePrivacyStatus;
  selfDeclaredMadeForKids: boolean;
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

export function generateDefaultYouTubeTitle(filePath: string): string {
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
  return safeTitle.slice(0, 100).trim();
}

export function generateDefaultYouTubeDescription(creditName: string, creditUrl?: string): string {
  const normalizedCreditName = creditName.trim();
  if (normalizedCreditName.length === 0) {
    throw new Error("creditName is required.");
  }

  const descriptionLines = [`Credit: ${normalizedCreditName}`];
  const normalizedCreditUrl = creditUrl?.trim();
  if (normalizedCreditUrl && normalizedCreditUrl.length > 0) {
    descriptionLines.push(`Credit URL: ${normalizedCreditUrl}`);
  }

  descriptionLines.push(`This clip is from the original creator (${normalizedCreditName}).`);
  descriptionLines.push("#shorts");

  return descriptionLines.join("\n");
}

export async function uploadYouTubeShorts(
  options: YouTubeUploaderOptions,
): Promise<YouTubeUploadResult[]> {
  const normalizedCreditName = options.creditName.trim();
  if (normalizedCreditName.length === 0) {
    throw new Error("creditName is required.");
  }

  const privacyStatus = options.privacyStatus ?? "unlisted";
  const selfDeclaredMadeForKids = options.selfDeclaredMadeForKids ?? false;
  const defaultDescription = generateDefaultYouTubeDescription(
    normalizedCreditName,
    options.creditUrl,
  );
  const normalizedDescriptionTemplate = options.descriptionTemplate?.trim();
  const defaultUploadDescription =
    normalizedDescriptionTemplate && normalizedDescriptionTemplate.length > 0
      ? `${normalizedDescriptionTemplate}\n\n${defaultDescription}`
      : defaultDescription;

  const explicitUploads = options.uploads && options.uploads.length > 0 ? options.uploads : null;
  const plannedUploads = explicitUploads
    ? explicitUploads.map((upload) => {
        const normalizedUploadFilePath = upload.filePath.trim();
        if (normalizedUploadFilePath.length === 0) {
          throw new Error("uploads[].filePath is required.");
        }

        const filePath = resolve(normalizedUploadFilePath);
        const normalizedUploadTitle = upload.title?.trim();
        const normalizedUploadDescription = upload.description?.trim();
        const title =
          normalizedUploadTitle && normalizedUploadTitle.length > 0
            ? normalizedUploadTitle
            : generateDefaultYouTubeTitle(filePath);
        const description =
          normalizedUploadDescription && normalizedUploadDescription.length > 0
            ? normalizedUploadDescription
            : defaultUploadDescription;

        return {
          filePath,
          title,
          description,
          privacyStatus,
          selfDeclaredMadeForKids,
        } satisfies UploadMetadata;
      })
    : (await discoverMp4Files(options.dir)).map((filePath) => {
        const title = generateDefaultYouTubeTitle(filePath);
        return {
          filePath,
          title,
          description: defaultUploadDescription,
          privacyStatus,
          selfDeclaredMadeForKids,
        } satisfies UploadMetadata;
      });

  if (plannedUploads.length === 0) {
    if (explicitUploads) {
      throw new Error("No .mp4 files found in uploads list.");
    }
    throw new Error(`No .mp4 files found in directory: ${options.dir}`);
  }

  if (options.dryRun) {
    return plannedUploads.map(
      (upload): YouTubeDryRunUploadResult => ({
        filePath: upload.filePath,
        success: true,
        dryRun: true,
        title: upload.title,
        description: upload.description,
        privacyStatus: upload.privacyStatus,
        selfDeclaredMadeForKids: upload.selfDeclaredMadeForKids,
      }),
    );
  }

  const providedAccessToken = options.accessToken?.trim();
  const accessToken =
    providedAccessToken !== undefined
      ? providedAccessToken
      : await getYouTubeAccessToken({ oauthFilePath: options.oauthFilePath });

  if (!accessToken) {
    throw new Error(
      "YouTube access token is empty. Provide accessToken or configure oauthFilePath with a valid refresh token.",
    );
  }

  const results: YouTubeUploadResult[] = [];

  for (const upload of plannedUploads) {
    results.push(await uploadSingleFile(upload, accessToken));
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
  accessToken: string,
): Promise<YouTubeUploadSuccessResult | YouTubeUploadFailureResult> {
  try {
    const uploadUrl = await startResumableUploadSession(upload, accessToken);
    const videoId = await uploadBytes(upload.filePath, uploadUrl, accessToken);
    return {
      filePath: upload.filePath,
      success: true,
      dryRun: false,
      videoId,
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

async function startResumableUploadSession(
  upload: UploadMetadata,
  accessToken: string,
): Promise<string> {
  const fileStats = await stat(upload.filePath);

  const initResponse = await fetch(YOUTUBE_RESUMABLE_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": "video/mp4",
      "X-Upload-Content-Length": String(fileStats.size),
    },
    body: JSON.stringify({
      snippet: {
        title: upload.title,
        description: upload.description,
      },
      status: {
        privacyStatus: upload.privacyStatus,
        selfDeclaredMadeForKids: upload.selfDeclaredMadeForKids,
      },
    }),
  });

  if (!initResponse.ok) {
    const errorMessage = await readResponseError(initResponse);
    throw new Error(`Upload init failed (${initResponse.status}): ${errorMessage}`);
  }

  const uploadUrl = initResponse.headers.get("Location");
  if (!uploadUrl) {
    throw new Error("Upload init failed: missing Location header.");
  }

  return uploadUrl;
}

async function uploadBytes(
  filePath: string,
  uploadUrl: string,
  accessToken: string,
): Promise<string> {
  const fileBytes = await Bun.file(filePath).arrayBuffer();

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "video/mp4",
      "Content-Length": String(fileBytes.byteLength),
    },
    body: fileBytes,
  });

  if (!uploadResponse.ok) {
    const errorMessage = await readResponseError(uploadResponse);
    throw new Error(`Upload failed (${uploadResponse.status}): ${errorMessage}`);
  }

  let payload: unknown;
  try {
    payload = await uploadResponse.json();
  } catch {
    throw new Error("Upload failed: invalid response payload.");
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Upload failed: missing video id in response.");
  }

  const videoId = (payload as { id?: unknown }).id;
  if (typeof videoId !== "string" || videoId.length === 0) {
    throw new Error("Upload failed: missing video id in response.");
  }

  return videoId;
}

async function readResponseError(response: Response): Promise<string> {
  const fallback = `${response.status} ${response.statusText}`.trim();
  const text = (await response.text()).trim();
  if (!text) {
    return fallback;
  }

  try {
    const payload = JSON.parse(text) as { error?: { message?: string } };
    const message = payload.error?.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  } catch {
    // Use raw text fallback.
  }

  return text;
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
  return "Upload failed.";
}
