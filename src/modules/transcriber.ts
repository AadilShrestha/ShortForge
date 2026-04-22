import { createLogger } from "../utils/logger";
import { secondsToSrtTimestamp } from "../utils/ffmpeg";
import type { Config } from "../config";
import type { TranscriptSegment, Transcript, VideoMetadata } from "../pipeline/types";
import { join } from "path";

const log = createLogger("transcriber");
const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

export class Transcriber {
  async transcribe(
    metadata: VideoMetadata,
    outputDir: string,
    config: Config,
  ): Promise<Transcript> {
    if (config.preferYouTubeTranscripts) {
      try {
        log.info("Attempting YouTube transcript fetch...");
        return await this.fromYouTube(metadata, outputDir);
      } catch (err) {
        log.warn(`YouTube transcript unavailable: ${err}. Trying yt-dlp captions.`);
      }

      try {
        log.info("Attempting yt-dlp caption fetch...");
        return await this.fromYtDlpCaptions(metadata, outputDir);
      } catch (err) {
        log.warn(`yt-dlp captions unavailable: ${err}. Falling back to Whisper.`);
      }
    }

    return await this.fromWhisper(metadata, outputDir, config);
  }

  private async fromYouTube(metadata: VideoMetadata, outputDir: string): Promise<Transcript> {
    const script = [
      "import json",
      "from youtube_transcript_api import YouTubeTranscriptApi",
      "ytt_api = YouTubeTranscriptApi()",
      `fetched = ytt_api.fetch(${JSON.stringify(metadata.videoId)})`,
      "snippets = [{'text': s.text, 'start': s.start, 'duration': s.duration} for s in fetched.snippets]",
      "print(json.dumps(snippets))",
    ].join("\n");
    const proc = Bun.spawn([PYTHON_BIN, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) throw new Error(`YouTube transcript fetch failed: ${stderr}`);

    const raw = JSON.parse(stdout) as Array<{ text: string; start: number; duration: number }>;
    const segments: TranscriptSegment[] = raw.map((s) => ({
      text: s.text,
      start: s.start,
      duration: s.duration,
      end: s.start + s.duration,
    }));

    const fullText = segments.map((s) => s.text).join(" ");
    const srtPath = join(outputDir, "transcript.srt");
    await this.writeSrt(segments, srtPath);

    log.info(`YouTube transcript: ${segments.length} segments`);
    return { source: "youtube", language: "en", segments, fullText, srtPath };
  }

  private async fromYtDlpCaptions(metadata: VideoMetadata, outputDir: string): Promise<Transcript> {
    const videoUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(metadata.videoId)}`;
    const metadataPayload = await this.fetchYtDlpMetadata(videoUrl);
    const selectedTrack = this.pickJson3CaptionTrack(metadataPayload);
    if (!selectedTrack) {
      throw new Error("No usable json3 caption track found in yt-dlp metadata");
    }

    const response = await fetch(selectedTrack.url);
    if (!response.ok) {
      const reason = `${response.status} ${response.statusText}`.trim();
      throw new Error(`Caption track fetch failed: ${reason}`);
    }

    const captionPayload = (await response.json()) as Record<string, unknown>;
    const segments = this.extractSegmentsFromJson3(captionPayload);
    if (segments.length === 0) {
      throw new Error("Caption track did not contain any transcript segments");
    }

    const fullText = segments.map((s) => s.text).join(" ");
    const srtPath = join(outputDir, "transcript.srt");
    await this.writeSrt(segments, srtPath);

    log.info(`yt-dlp captions: ${segments.length} segments (${selectedTrack.language})`);
    return { source: "youtube", language: selectedTrack.language, segments, fullText, srtPath };
  }

  private async fetchYtDlpMetadata(videoUrl: string): Promise<Record<string, unknown>> {
    const attempts = [
      { useCookies: true, args: ["yt-dlp", "--cookies-from-browser", "chrome", "--dump-json", "--no-download", videoUrl] },
      { useCookies: false, args: ["yt-dlp", "--dump-json", "--no-download", videoUrl] },
    ];

    let lastError = "yt-dlp metadata command did not run";
    for (const attempt of attempts) {
      const proc = Bun.spawn(attempt.args, { stdout: "pipe", stderr: "pipe" });
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode === 0) {
        const firstLine = stdout
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.length > 0);
        if (!firstLine) {
          throw new Error("yt-dlp metadata command returned empty stdout");
        }

        const parsed = JSON.parse(firstLine);
        if (!parsed || typeof parsed !== "object") {
          throw new Error("yt-dlp metadata payload was not a JSON object");
        }
        return parsed as Record<string, unknown>;
      }

      lastError = stderr.trim() || `exit code ${exitCode}`;
      if (attempt.useCookies) {
        log.warn(`yt-dlp caption lookup failed using Chrome cookies (${lastError}). Retrying without browser cookies.`);
      }
    }

    throw new Error(`yt-dlp caption lookup failed: ${lastError}`);
  }

  private pickJson3CaptionTrack(
    metadataPayload: Record<string, unknown>,
  ): { url: string; language: string } | null {
    const subtitles = this.toCaptionTrackMap(metadataPayload.subtitles);
    const automatic = this.toCaptionTrackMap(metadataPayload.automatic_captions);

    const preferredLanguages = [
      ...this.findPreferredLanguages(subtitles, "en"),
      ...this.findPreferredLanguages(automatic, "en"),
      ...Object.keys(subtitles),
      ...Object.keys(automatic),
    ];

    const seenLanguages = new Set<string>();
    for (const language of preferredLanguages) {
      if (seenLanguages.has(language)) continue;
      seenLanguages.add(language);

      const fromSubtitles = this.findJson3Url(subtitles[language]);
      if (fromSubtitles) return { url: fromSubtitles, language };

      const fromAutomatic = this.findJson3Url(automatic[language]);
      if (fromAutomatic) return { url: fromAutomatic, language };
    }

    return null;
  }

  private toCaptionTrackMap(value: unknown): Record<string, unknown[]> {
    if (!value || typeof value !== "object") return {};

    const map: Record<string, unknown[]> = {};
    for (const [language, tracks] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(tracks)) {
        map[language] = tracks;
      }
    }
    return map;
  }

  private findPreferredLanguages(map: Record<string, unknown[]>, baseLanguage: string): string[] {
    const direct = Object.keys(map).filter((language) => language === baseLanguage);
    const variants = Object.keys(map).filter((language) => language.startsWith(`${baseLanguage}-`));
    return [...direct, ...variants];
  }

  private findJson3Url(tracks: unknown[] | undefined): string | null {
    if (!tracks) return null;

    for (const track of tracks) {
      if (!track || typeof track !== "object") continue;
      const record = track as Record<string, unknown>;
      if (record.ext === "json3" && typeof record.url === "string" && record.url.length > 0) {
        return record.url;
      }
    }

    return null;
  }

  private extractSegmentsFromJson3(captionPayload: Record<string, unknown>): TranscriptSegment[] {
    const eventsValue = captionPayload.events;
    if (!Array.isArray(eventsValue)) return [];

    const events = eventsValue.filter(
      (event): event is Record<string, unknown> => Boolean(event) && typeof event === "object",
    );

    const segments: TranscriptSegment[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const segsValue = event.segs;
      if (!Array.isArray(segsValue)) continue;

      const text = segsValue
        .map((segment) => {
          if (!segment || typeof segment !== "object") return "";
          const utf8 = (segment as Record<string, unknown>).utf8;
          return typeof utf8 === "string" ? utf8 : "";
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length === 0) continue;

      const startMs = typeof event.tStartMs === "number" ? event.tStartMs : Number(event.tStartMs);
      if (!Number.isFinite(startMs)) continue;

      const rawDurationMs =
        typeof event.dDurationMs === "number" ? event.dDurationMs : Number(event.dDurationMs);
      let duration = Number.isFinite(rawDurationMs) && rawDurationMs > 0 ? rawDurationMs / 1000 : 0;
      if (duration <= 0) {
        const nextStart = this.findNextEventStart(events, index + 1);
        if (nextStart !== null) {
          duration = Math.max(0, nextStart - startMs / 1000);
        }
      }
      if (duration <= 0) duration = 0.5;

      const start = startMs / 1000;
      const end = start + duration;
      segments.push({ text, start, duration, end });
    }

    return segments;
  }

  private findNextEventStart(events: Array<Record<string, unknown>>, fromIndex: number): number | null {
    for (let index = fromIndex; index < events.length; index += 1) {
      const event = events[index];
      const startMs = typeof event.tStartMs === "number" ? event.tStartMs : Number(event.tStartMs);
      if (Number.isFinite(startMs)) return startMs / 1000;
    }
    return null;
  }

  private async fromWhisper(
    metadata: VideoMetadata,
    outputDir: string,
    config: Config,
  ): Promise<Transcript> {
    log.info(`Running Whisper (model: ${config.whisperModel})...`);
    const script = [
      "import whisper, json",
      `model = whisper.load_model(${JSON.stringify(config.whisperModel)})`,
      `result = model.transcribe(${JSON.stringify(metadata.filePath)}, language='en')`,
      "segments = [{'text': s['text'].strip(), 'start': s['start'], 'end': s['end'], 'duration': s['end'] - s['start']} for s in result['segments']]",
      "print(json.dumps(segments))",
    ].join("\n");
    const proc = Bun.spawn([PYTHON_BIN, "-c", script], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) throw new Error(`Whisper transcription failed: ${stderr}`);

    const raw = JSON.parse(stdout) as Array<{
      text: string;
      start: number;
      end: number;
      duration: number;
    }>;
    const segments: TranscriptSegment[] = raw.map((s) => ({
      text: s.text,
      start: s.start,
      duration: s.duration,
      end: s.end,
    }));

    const fullText = segments.map((s) => s.text).join(" ");
    const srtPath = join(outputDir, "transcript.srt");
    await this.writeSrt(segments, srtPath);

    log.info(`Whisper transcript: ${segments.length} segments`);
    return { source: "whisper", language: "en", segments, fullText, srtPath };
  }

  async writeSrt(segments: TranscriptSegment[], outputPath: string): Promise<void> {
    const lines: string[] = [];
    segments.forEach((seg, i) => {
      lines.push(String(i + 1));
      lines.push(`${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`);
      lines.push(seg.text);
      lines.push("");
    });
    await Bun.write(outputPath, lines.join("\n"));
  }
}
