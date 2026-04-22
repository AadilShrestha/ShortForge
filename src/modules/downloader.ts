import { createHash } from "crypto";
import { copyFile, stat } from "fs/promises";
import { basename, extname, join, resolve } from "path";

import type { VideoMetadata } from "../pipeline/types";
import { runFfprobe } from "../utils/ffmpeg";
import { ensureDir } from "../utils/fs";
import { createLogger } from "../utils/logger";

const log = createLogger("downloader");

interface YtDlpRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type DownloadSourceMode = "youtube_url" | "local_video";

export interface RemoteVideoMetadata {
  videoId: string;
  title: string;
  duration: number;
  uploadDate: string;
}

export class Downloader {
  async download(videoUrl: string, outputDir: string): Promise<VideoMetadata> {
    ensureDir(outputDir);
    const { videoId, title, duration, uploadDate } = await this.fetchVideoMetadata(videoUrl);

    const outputPath = join(outputDir, `${videoId}.mp4`);

    if (await Bun.file(outputPath).exists()) {
      log.info(`Video already downloaded: ${outputPath}`);
      return { videoId, title, duration, uploadDate, filePath: outputPath };
    }

    log.info(`Downloading: ${title} (${Math.round(duration / 60)} min)`);
    const preferredFormatSelector =
      "bestvideo[height>=720][height<=1080]+bestaudio/best[height>=720][height<=1080]/bestvideo[height<=1080]+bestaudio/best[height<=1080]/bestvideo+bestaudio/best";
    const downloadResult = await this.runYtDlpWithCookieFallback(
      [
        "-f",
        preferredFormatSelector,
        "--continue",
        "--remux-video",
        "mp4",
        "-o",
        outputPath,
        "--no-playlist",
        videoUrl,
      ],
      "inherit",
    );
    if (downloadResult.exitCode !== 0) {
      throw new Error(`yt-dlp download failed with exit code ${downloadResult.exitCode}`);
    }

    if (!(await Bun.file(outputPath).exists())) {
      throw new Error(`Download completed but file not found: ${outputPath}`);
    }

    log.info(`Downloaded: ${outputPath}`);
    return { videoId, title, duration, uploadDate, filePath: outputPath };
  }

  async fetchVideoMetadata(videoUrl: string): Promise<RemoteVideoMetadata> {
    log.info(`Fetching metadata for ${videoUrl}`);
    const metaResult = await this.runYtDlpWithCookieFallback(
      ["--dump-json", "--no-download", videoUrl],
      "pipe",
    );
    if (metaResult.exitCode !== 0) {
      throw new Error(
        `yt-dlp metadata failed: ${metaResult.stderr || `exit code ${metaResult.exitCode}`}`,
      );
    }

    return this.parseYtDlpMetadata(metaResult.stdout);
  }


  async downloadFromSource(
    sourceInput: string,
    outputDir: string,
    sourceMode: DownloadSourceMode,
  ): Promise<VideoMetadata> {
    if (sourceMode === "local_video") {
      return this.ingestLocalVideo(sourceInput, outputDir);
    }

    return this.download(sourceInput, outputDir);
  }

  async listChannelVideos(channelUrl: string, limit?: number): Promise<string[]> {
    log.info(`Fetching video list from channel: ${channelUrl}`);
    const args = ["yt-dlp", "--flat-playlist", "--dump-json", "--no-download"];
    if (limit) args.push("--playlist-end", String(limit));
    args.push(channelUrl);

    const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    const urls: string[] = [];
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { id?: string; url?: string };
        const id = entry.id || entry.url;
        if (id) urls.push(`https://www.youtube.com/watch?v=${id}`);
      } catch {
        // skip malformed lines
      }
    }

    log.info(`Found ${urls.length} videos`);
    return urls;
  }

  private parseYtDlpMetadata(rawOutput: string): RemoteVideoMetadata {
    const metaLine = rawOutput
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0);

    if (!metaLine) {
      throw new Error("yt-dlp metadata failed: empty stdout");
    }

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(metaLine) as Record<string, unknown>;
    } catch {
      throw new Error("yt-dlp metadata failed: invalid JSON output");
    }

    const rawVideoId = meta.id;
    if (typeof rawVideoId !== "string") {
      throw new Error("yt-dlp metadata failed: missing video id");
    }

    const videoId = rawVideoId.trim();
    if (videoId.length === 0) {
      throw new Error("yt-dlp metadata failed: missing video id");
    }

    const rawDuration = typeof meta.duration === "number" ? meta.duration : Number(meta.duration);

    return {
      videoId,
      title: typeof meta.title === "string" && meta.title.trim().length > 0 ? meta.title : "untitled",
      duration: Number.isFinite(rawDuration) ? rawDuration : 0,
      uploadDate: typeof meta.upload_date === "string" ? meta.upload_date : "",
    };
  }


  private async ingestLocalVideo(localFilePath: string, outputDir: string): Promise<VideoMetadata> {
    ensureDir(outputDir);

    const normalizedInputPath = resolve(localFilePath.trim());
    const sourceStats = await stat(normalizedInputPath).catch(() => null);
    if (!sourceStats || !sourceStats.isFile()) {
      throw new Error(`Local video file not found: ${localFilePath}`);
    }

    const sourceExtension = extname(normalizedInputPath).toLowerCase() || ".mp4";
    const videoId = this.buildLocalVideoId(normalizedInputPath);
    const outputPath = join(outputDir, `${videoId}${sourceExtension}`);

    if (normalizedInputPath !== outputPath) {
      if (!(await Bun.file(outputPath).exists())) {
        await copyFile(normalizedInputPath, outputPath);
      }
    } else if (!(await Bun.file(outputPath).exists())) {
      throw new Error(`Local video file missing at ${normalizedInputPath}`);
    }

    const probe = await runFfprobe(outputPath);
    const titleCandidate = basename(normalizedInputPath, extname(normalizedInputPath)).trim();

    return {
      videoId,
      title: titleCandidate.length > 0 ? titleCandidate : "untitled",
      duration: Number.isFinite(probe.duration) ? probe.duration : 0,
      uploadDate: sourceStats.mtime.toISOString().slice(0, 10).replace(/-/g, ""),
      filePath: outputPath,
    };
  }

  private buildLocalVideoId(localFilePath: string): string {
    const stem = basename(localFilePath, extname(localFilePath))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24);
    const hash = createHash("sha1").update(localFilePath).digest("hex").slice(0, 10);

    return `${stem || "local-video"}-${hash}`;
  }

  private async runYtDlpWithCookieFallback(
    argsWithoutBinary: string[],
    mode: "pipe" | "inherit",
  ): Promise<YtDlpRunResult> {
    const attempts = [
      { useCookies: true, args: ["yt-dlp", "--cookies-from-browser", "chrome", ...argsWithoutBinary] },
      { useCookies: false, args: ["yt-dlp", ...argsWithoutBinary] },
    ];

    let lastResult: YtDlpRunResult = {
      exitCode: 1,
      stdout: "",
      stderr: "yt-dlp did not run",
    };

    for (const attempt of attempts) {
      const proc = Bun.spawn(
        attempt.args,
        mode === "pipe"
          ? { stdout: "pipe", stderr: "pipe" }
          : { stdout: "inherit", stderr: "inherit" },
      );

      const stdout = mode === "pipe" && proc.stdout ? await new Response(proc.stdout).text() : "";
      const stderr = mode === "pipe" && proc.stderr ? await new Response(proc.stderr).text() : "";
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        return { exitCode, stdout, stderr };
      }

      lastResult = { exitCode, stdout, stderr };

      if (attempt.useCookies) {
        const reason = stderr.trim() || `exit code ${exitCode}`;
        log.warn(
          `yt-dlp failed using Chrome cookies (${reason}). Retrying without browser cookies.`,
        );
      }
    }

    return lastResult;
  }
}
