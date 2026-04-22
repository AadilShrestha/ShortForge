import { stat } from "fs/promises";
import { join } from "path";

import type { Config } from "../config";
import type { ClipCandidate, Transcript, TranscriptSegment, VideoMetadata } from "../pipeline/types";
import { runDir, ensureDir } from "../utils/fs";
import { getVideoDuration, runFfmpeg } from "../utils/ffmpeg";
import { createLogger } from "../utils/logger";
import { CaptionGenerator } from "./caption-generator";
import { ClipIdentifier } from "./clip-identifier";
import { Transcriber } from "./transcriber";
import { VideoProcessor } from "./video-processor";

const log = createLogger("live-clipper");
const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";
const STABLE_END_BUFFER_SEC = 6;
const MIN_WINDOW_SEGMENTS = 3;

export interface LiveClipperOptions {
  pollSeconds: number;
  windowSeconds: number;
  maxClips: number;
  minGapSeconds: number;
}

export interface LiveClipperResult {
  runId: string;
  videoId: string;
  videoTitle: string;
  recordingPath: string;
  outputDir: string;
  clipsGenerated: number;
}

interface EmittedRange {
  start: number;
  end: number;
}

interface CandidateContext {
  candidate: ClipCandidate;
  sourceStart: number;
  sourceEnd: number;
  stableEnd: number;
}

interface LiveSourceInfo {
  metadata: VideoMetadata;
  streamUrl: string;
}

export class LiveClipper {
  private transcriber = new Transcriber();
  private clipIdentifier: ClipIdentifier;
  private videoProcessor = new VideoProcessor();
  private captionGenerator = new CaptionGenerator();

  constructor(private config: Config) {
    this.clipIdentifier = new ClipIdentifier(config);
  }

  async run(videoUrl: string, opts: LiveClipperOptions): Promise<LiveClipperResult> {
    this.validateOptions(opts);

    const source = await this.fetchLiveSource(videoUrl);
    const metadata = source.metadata;
    const runId = crypto.randomUUID();
    const dir = runDir(this.config.paths.data, runId);
    const downloadsDir = join(dir, "downloads");
    const transcriptsDir = join(dir, "transcripts");
    const outputDir = join(this.config.paths.output, metadata.videoId);
    ensureDir(outputDir);

    const recordingPath = join(downloadsDir, `${metadata.videoId}.ts`);

    log.info(`Starting live clipper run: ${runId}`);
    log.info(`Live URL: ${videoUrl}`);
    log.info(`Video: ${metadata.title}`);

    const recorder = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "5",
        "-i",
        source.streamUrl,
        "-c",
        "copy",
        "-f",
        "mpegts",
        "-y",
        recordingPath,
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    );

    const emittedRanges: EmittedRange[] = [];
    let clipsGenerated = 0;
    let clipSequence = 0;

    try {
      await this.waitForInitialRecordingData(recordingPath, 180, opts.pollSeconds);
      log.info(`Live recording started: ${recordingPath}`);
      await this.captionGenerator.warmup();

      while (opts.maxClips === 0 || clipsGenerated < opts.maxClips) {
        await this.sleep(opts.pollSeconds * 1000);

        const candidateContext = await this.findCandidate(
          metadata,
          transcriptsDir,
          recordingPath,
          opts.windowSeconds,
          opts.minGapSeconds,
          emittedRanges,
        );

        if (!candidateContext) {
          continue;
        }

        clipSequence += 1;
        const finalPath = await this.renderCandidate(
          recordingPath,
          dir,
          outputDir,
          candidateContext.candidate,
          clipSequence,
        );

        emittedRanges.push({
          start: candidateContext.sourceStart,
          end: candidateContext.sourceEnd,
        });
        clipsGenerated += 1;

        log.info(
          `Emitted clip ${clipsGenerated}${opts.maxClips > 0 ? `/${opts.maxClips}` : ""}: ${finalPath}`,
        );
      }

      log.info(`Live clipper finished: ${clipsGenerated} clips`);

      return {
        runId,
        videoId: metadata.videoId,
        videoTitle: metadata.title,
        recordingPath,
        outputDir,
        clipsGenerated,
      };
    } finally {
      this.stopRecorder(recorder);
    }
  }

  private validateOptions(opts: LiveClipperOptions): void {
    if (!Number.isInteger(opts.pollSeconds) || opts.pollSeconds < 5 || opts.pollSeconds > 300) {
      throw new Error("pollSeconds must be an integer between 5 and 300.");
    }

    if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds < 45 || opts.windowSeconds > 900) {
      throw new Error("windowSeconds must be an integer between 45 and 900.");
    }

    if (!Number.isInteger(opts.maxClips) || opts.maxClips < 0) {
      throw new Error("maxClips must be a non-negative integer.");
    }

    if (!Number.isInteger(opts.minGapSeconds) || opts.minGapSeconds < 0 || opts.minGapSeconds > 600) {
      throw new Error("minGapSeconds must be an integer between 0 and 600.");
    }
  }

  private async fetchLiveSource(videoUrl: string): Promise<LiveSourceInfo> {
    const proc = Bun.spawn(
      [
        "yt-dlp",
        "--impersonate",
        "chrome",
        "--dump-single-json",
        "--skip-download",
        "-f",
        "best[protocol*=m3u8]/best",
        videoUrl,
      ],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`yt-dlp live source fetch failed: ${stderr || `exit code ${exitCode}`}`);
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error("yt-dlp live source response was invalid JSON.");
    }

    const videoId = typeof payload.id === "string" ? payload.id : "";
    if (videoId.length === 0) {
      throw new Error("yt-dlp live source metadata missing video id.");
    }

    const title = typeof payload.title === "string" && payload.title.length > 0 ? payload.title : videoId;
    const duration = typeof payload.duration === "number" ? payload.duration : 0;
    const uploadDate = typeof payload.upload_date === "string" ? payload.upload_date : "";
    const streamUrl = this.extractLiveStreamUrl(payload);

    return {
      metadata: {
        videoId,
        title,
        duration,
        uploadDate,
        filePath: "",
      },
      streamUrl,
    };
  }

  private extractLiveStreamUrl(payload: Record<string, unknown>): string {
    const requestedDownloads = Array.isArray(payload.requested_downloads)
      ? payload.requested_downloads
      : [];

    for (const item of requestedDownloads) {
      if (!item || typeof item !== "object") continue;
      const url = (item as { url?: unknown }).url;
      if (typeof url === "string" && url.length > 0) {
        return url;
      }
    }

    const formats = Array.isArray(payload.formats) ? payload.formats : [];
    const m3u8Formats = formats
      .filter((format) => format && typeof format === "object")
      .map((format) => ({
        url: (format as { url?: unknown }).url,
        protocol: (format as { protocol?: unknown }).protocol,
        height: (format as { height?: unknown }).height,
      }))
      .filter(
        (format): format is { url: string; protocol: string; height: number | null } =>
          typeof format.url === "string" &&
          typeof format.protocol === "string" &&
          format.protocol.includes("m3u8"),
      )
      .sort((left, right) => {
        const leftHeight = typeof left.height === "number" ? left.height : 0;
        const rightHeight = typeof right.height === "number" ? right.height : 0;
        return rightHeight - leftHeight;
      });

    if (m3u8Formats.length > 0) {
      return m3u8Formats[0].url;
    }

    throw new Error("No live HLS stream URL found in yt-dlp payload.");
  }

  private async waitForInitialRecordingData(
    recordingPath: string,
    maxWaitSeconds: number,
    pollSeconds: number,
  ): Promise<void> {
    const deadline = Date.now() + maxWaitSeconds * 1000;

    while (Date.now() < deadline) {
      const duration = await this.safeGetDuration(recordingPath);
      if (duration !== null && duration > 0) {
        return;
      }

      await this.sleep(Math.min(pollSeconds, 5) * 1000);
    }

    throw new Error(`Timed out waiting for initial live recording data: ${recordingPath}`);
  }

  private async findCandidate(
    metadata: VideoMetadata,
    transcriptsDir: string,
    recordingPath: string,
    windowSeconds: number,
    minGapSeconds: number,
    emittedRanges: EmittedRange[],
  ): Promise<CandidateContext | null> {
    const currentDuration = await this.safeGetDuration(recordingPath);
    if (currentDuration === null) {
      return null;
    }

    const stableEnd = currentDuration - STABLE_END_BUFFER_SEC;
    if (stableEnd <= 0) {
      return null;
    }

    const windowStart = Math.max(0, stableEnd - windowSeconds);
    const windowDuration = stableEnd - windowStart;

    const minSourceDuration = this.config.clipMinDurationSec * this.config.clipSpeed;
    if (windowDuration < minSourceDuration) {
      return null;
    }

    const windowClipPath = join(transcriptsDir, `window_${Date.now()}.mp4`);
    await runFfmpeg([
      "-ss",
      String(windowStart),
      "-to",
      String(stableEnd),
      "-i",
      recordingPath,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-y",
      windowClipPath,
    ]);

    const transcript = await this.buildWindowTranscript(metadata, windowClipPath, transcriptsDir, windowStart, stableEnd);
    if (!transcript || transcript.segments.length < MIN_WINDOW_SEGMENTS) {
      return null;
    }

    const windowMetadata: VideoMetadata = {
      videoId: metadata.videoId,
      title: metadata.title,
      duration: windowDuration,
      uploadDate: metadata.uploadDate,
      filePath: windowClipPath,
    };

    const candidates = await this.clipIdentifier.identify(transcript, windowMetadata);

    for (const candidate of candidates) {
      const sourceStart = windowStart + candidate.startTime;
      const sourceEnd = windowStart + candidate.endTime;

      if (sourceEnd > stableEnd || sourceEnd <= sourceStart) {
        continue;
      }

      if (this.overlapsExisting(sourceStart, sourceEnd, emittedRanges, minGapSeconds)) {
        continue;
      }

      const absoluteCandidate: ClipCandidate = {
        ...candidate,
        startTime: sourceStart,
        endTime: sourceEnd,
        duration: sourceEnd - sourceStart,
      };

      log.info(
        `Selected candidate: ${absoluteCandidate.title} (${sourceStart.toFixed(1)}s-${sourceEnd.toFixed(1)}s)`,
      );

      return {
        candidate: absoluteCandidate,
        sourceStart,
        sourceEnd,
        stableEnd,
      };
    }

    return null;
  }

  private async buildWindowTranscript(
    metadata: VideoMetadata,
    windowClipPath: string,
    transcriptsDir: string,
    windowStart: number,
    windowEnd: number,
  ): Promise<Transcript | null> {
    const maybeYouTubeSegments = await this.fetchYouTubeSegments(metadata.videoId);

    if (maybeYouTubeSegments) {
      const filtered = this.filterAndShiftSegments(maybeYouTubeSegments, windowStart, windowEnd);
      if (filtered.length > 0) {
        return {
          source: "youtube",
          language: "en",
          segments: filtered,
          fullText: filtered.map((s) => s.text).join(" "),
          srtPath: null,
        };
      }
    }

    const whisperMetadata: VideoMetadata = {
      ...metadata,
      filePath: windowClipPath,
      duration: Math.max(0, windowEnd - windowStart),
    };

    const whisperConfig: Config = {
      ...this.config,
      preferYouTubeTranscripts: false,
    };

    try {
      return await this.transcriber.transcribe(whisperMetadata, transcriptsDir, whisperConfig);
    } catch (err) {
      log.warn(`Window transcription failed: ${err}`);
      return null;
    }
  }

  private async fetchYouTubeSegments(videoId: string): Promise<TranscriptSegment[] | null> {
    const script = `
import json
from youtube_transcript_api import YouTubeTranscriptApi
ytt_api = YouTubeTranscriptApi()
fetched = ytt_api.fetch(${JSON.stringify(videoId)})
snippets = [{"text": s.text, "start": s.start, "duration": s.duration} for s in fetched.snippets]
print(json.dumps(snippets))
`;

    const proc = Bun.spawn([PYTHON_BIN, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      log.warn(`YouTube live transcript unavailable: ${stderr || `exit ${exitCode}`}`);
      return null;
    }

    try {
      const raw = JSON.parse(stdout) as Array<{ text: string; start: number; duration: number }>;
      return raw.map((s) => ({
        text: s.text,
        start: s.start,
        duration: s.duration,
        end: s.start + s.duration,
      }));
    } catch {
      log.warn("YouTube live transcript payload was invalid JSON.");
      return null;
    }
  }

  private filterAndShiftSegments(
    segments: TranscriptSegment[],
    windowStart: number,
    windowEnd: number,
  ): TranscriptSegment[] {
    return segments
      .filter((segment) => segment.end > windowStart && segment.start < windowEnd)
      .map((segment) => {
        const shiftedStart = Math.max(0, segment.start - windowStart);
        const shiftedEnd = Math.max(shiftedStart, Math.min(windowEnd, segment.end) - windowStart);
        return {
          text: segment.text,
          start: shiftedStart,
          end: shiftedEnd,
          duration: shiftedEnd - shiftedStart,
        };
      })
      .filter((segment) => segment.duration > 0);
  }

  private overlapsExisting(
    start: number,
    end: number,
    ranges: EmittedRange[],
    minGapSeconds: number,
  ): boolean {
    return ranges.some((range) => start < range.end + minGapSeconds && end > range.start - minGapSeconds);
  }

  private async renderCandidate(
    recordingPath: string,
    runPath: string,
    outputDir: string,
    candidate: ClipCandidate,
    clipIndex: number,
  ): Promise<string> {
    const extractedPath = await this.videoProcessor.extractClip(recordingPath, candidate, join(runPath, "clips"));

    const desilencedPath = join(runPath, "desilenced", `${candidate.id}_clean.mp4`);
    const cleanResult = await this.videoProcessor.removeSilence(extractedPath, desilencedPath, this.config);

    const minSourceDuration = this.config.clipMinDurationSec * this.config.clipSpeed;
    const cleanedDuration = await this.safeGetDuration(cleanResult.path);
    const clipForRender =
      cleanedDuration !== null && cleanedDuration >= minSourceDuration ? cleanResult.path : extractedPath;

    if (clipForRender === extractedPath) {
      log.info(
        `Keeping original clip duration for ${candidate.title} (cleaned=${cleanedDuration?.toFixed(1) ?? "n/a"}s, required>=${minSourceDuration.toFixed(1)}s).`,
      );
    }

    const overlayPath = join(runPath, "captions", `${candidate.id}_captions.webm`);
    const captionOverlayPath = await this.captionGenerator.generate(
      clipForRender,
      overlayPath,
      this.config,
    );

    const reelFilename = this.buildReadableReelFilename(candidate, clipIndex);
    const finalPath = join(outputDir, reelFilename);

    return await this.videoProcessor.composeReel(
      clipForRender,
      this.config,
      finalPath,
      captionOverlayPath,
    );
  }

  private buildReadableReelFilename(clip: ClipCandidate, clipIndex: number): string {
    const prefix = String(clipIndex).padStart(2, "0");
    const slug = clip.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70);

    const safeSlug = slug.length > 0 ? slug : "clip";
    return `${prefix}-${safeSlug}.mp4`;
  }

  private async safeGetDuration(filePath: string): Promise<number | null> {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size <= 0) {
        return null;
      }

      const duration = await getVideoDuration(filePath);
      if (!Number.isFinite(duration) || duration <= 0) {
        return null;
      }

      return duration;
    } catch (err) {
      log.debug(`Waiting for readable recording duration: ${err}`);
      return null;
    }
  }

  private stopRecorder(recorder: ReturnType<typeof Bun.spawn>): void {
    try {
      recorder.kill();
    } catch {
      // Process may already be exited.
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}
