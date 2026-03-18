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
  }

  private async ffmpegFallback(
    clipPath: string,
    srtPath: string,
    outputPath: string
  ): Promise<{ srtPath: string; overlayPath: string }> {
    log.info("Using FFmpeg subtitle burn as fallback");
    const proc = Bun.spawn([
      "ffmpeg", "-y",
      "-f", "lavfi", "-i", `color=c=black@0.0:s=1080x1920,format=rgba`,
      "-i", clipPath,
      "-filter_complex",
      `[0:v]subtitles='${srtPath.replace(/'/g, "\\'")}':force_style='FontName=Arial,FontSize=24,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Alignment=2,MarginV=100'[out]`,
      "-map", "[out]",
      "-t", "999",
      "-shortest",
      "-c:v", "png",
      outputPath,
    ], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;

    return { srtPath, overlayPath: outputPath };
  }
}
