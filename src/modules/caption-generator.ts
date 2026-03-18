import { createLogger } from "../utils/logger";
import { fileExists } from "../utils/fs";
import { secondsToSrtTimestamp } from "../utils/ffmpeg";
import type { Config } from "../config";
import type { TranscriptSegment } from "../pipeline/types";

const log = createLogger("captions");

export class CaptionGenerator {
  async generate(
    clipPath: string,
    srtOutputPath: string,
    movOutputPath: string,
    config: Config,
    fallbackSegments?: TranscriptSegment[]
  ): Promise<{ srtPath: string; overlayPath: string }> {
    let srtGenerated = false;

    try {
      log.info("Generating SRT with Transcriptionist...");
      const transcribeProc = Bun.spawn(
        ["transcribe", clipPath, "--output", srtOutputPath, "--karaoke", "--clauses"],
        { stdout: "pipe", stderr: "pipe" }
      );
      const stderr = await new Response(transcribeProc.stderr).text();
      const exitCode = await transcribeProc.exited;

      if (exitCode === 0 && await fileExists(srtOutputPath)) {
        srtGenerated = true;
        log.info("SRT generated via Transcriptionist");
      } else {
        log.warn(`Transcriptionist failed: ${stderr}`);
      }
    } catch (err) {
      log.warn(`Transcriptionist error: ${err}`);
    }

    if (!srtGenerated && fallbackSegments?.length) {
      log.info("Using fallback SRT from transcript segments");
      const cues = this.buildCleanSrt(fallbackSegments);
      const lines: string[] = [];
      cues.forEach((cue, i) => {
        lines.push(String(i + 1));
        lines.push(`${secondsToSrtTimestamp(cue.start)} --> ${secondsToSrtTimestamp(cue.end)}`);
        lines.push(cue.text);
        lines.push("");
      });
      await Bun.write(srtOutputPath, lines.join("\n"));
      srtGenerated = true;
    }

    if (!srtGenerated) {
      throw new Error("Failed to generate SRT captions");
    }

    log.info("Generating caption overlay with PupCaps...");
    try {
      const pupcapsArgs = ["pupcaps", srtOutputPath, "--output", movOutputPath, "--width", "1080", "--height", "1920"];
      if (config.captionAnimate) pupcapsArgs.push("--animate");

      const pupcapsProc = Bun.spawn(pupcapsArgs, { stdout: "pipe", stderr: "pipe" });
      const pcStderr = await new Response(pupcapsProc.stderr).text();
      const pcExit = await pupcapsProc.exited;

      if (pcExit !== 0) {
        log.warn(`PupCaps failed: ${pcStderr}. Falling back to FFmpeg subtitle burn.`);
        return await this.ffmpegFallback(clipPath, srtOutputPath, movOutputPath);
      }

      log.info("Caption overlay generated");
      return { srtPath: srtOutputPath, overlayPath: movOutputPath };
    } catch (err) {
      log.warn(`PupCaps error: ${err}. Falling back to FFmpeg subtitle burn.`);
      return await this.ffmpegFallback(clipPath, srtOutputPath, movOutputPath);
    }
  }

  private buildCleanSrt(segments: TranscriptSegment[]): Array<{ start: number; end: number; text: string }> {
    const sorted = [...segments].sort((a, b) => a.start - b.start);
    const allText: Array<{ start: number; end: number; word: string }> = [];

    for (const seg of sorted) {
      const words = seg.text.trim().split(/\s+/).filter(w => w.length > 0);
      if (words.length === 0) continue;
      const duration = seg.end - seg.start;
      const wordDuration = duration / words.length;
      for (let i = 0; i < words.length; i++) {
        allText.push({
          start: seg.start + i * wordDuration,
          end: seg.start + (i + 1) * wordDuration,
          word: words[i],
        });
      }
    }

    // De-duplicate words at similar timestamps
    const deduped: typeof allText = [];
    for (const w of allText) {
      const last = deduped[deduped.length - 1];
      if (last && Math.abs(w.start - last.start) < 0.1 && w.word === last.word) continue;
      deduped.push(w);
    }

    // Group into chunks of ~5 words
    const maxWords = 5;
    const cues: Array<{ start: number; end: number; text: string }> = [];
    for (let i = 0; i < deduped.length; i += maxWords) {
      const chunk = deduped.slice(i, i + maxWords);
      cues.push({
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        text: chunk.map(c => c.word).join(" "),
      });
    }

    // Ensure no overlaps
    for (let i = 0; i < cues.length - 1; i++) {
      if (cues[i].end > cues[i + 1].start) {
        cues[i].end = cues[i + 1].start;
      }
    }

    return cues;
  }

  private async ffmpegFallback(
    _clipPath: string,
    srtPath: string,
    _outputPath: string
  ): Promise<{ srtPath: string; overlayPath: string }> {
    log.info("No overlay available, SRT will be burned during reel composition");
    return { srtPath, overlayPath: "" };
  }
}
