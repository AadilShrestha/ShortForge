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
      const lines: string[] = [];
      fallbackSegments.forEach((seg, i) => {
        lines.push(String(i + 1));
        lines.push(`${secondsToSrtTimestamp(seg.start)} --> ${secondsToSrtTimestamp(seg.end)}`);
        lines.push(seg.text);
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

  private async ffmpegFallback(
    _clipPath: string,
    srtPath: string,
    _outputPath: string
  ): Promise<{ srtPath: string; overlayPath: string }> {
    log.info("No overlay available, SRT will be burned during reel composition");
    return { srtPath, overlayPath: "" };
  }
}
