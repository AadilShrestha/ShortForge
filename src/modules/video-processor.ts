import { createLogger } from "../utils/logger";
import { runFfmpeg, runFfprobe, detectSilence, secondsToFfmpegTimestamp, getVideoDuration, hasSubtitlesFilter } from "../utils/ffmpeg";
import { listFiles, randomItem, fileExists } from "../utils/fs";
import type { Config } from "../config";
import type { ClipCandidate } from "../pipeline/types";
import { join } from "path";

const log = createLogger("video-processor");

export class VideoProcessor {
  async extractClip(videoPath: string, clip: ClipCandidate, outputDir: string): Promise<string> {
    const outputPath = join(outputDir, `${clip.id}_raw.mp4`);

    if (await fileExists(outputPath)) {
      log.info(`Clip already extracted: ${clip.title}`);
      return outputPath;
    }

    log.info(`Extracting clip: "${clip.title}" (${clip.startTime}s - ${clip.endTime}s)`);
    await runFfmpeg([
      "-i", videoPath,
      "-ss", secondsToFfmpegTimestamp(clip.startTime),
      "-to", secondsToFfmpegTimestamp(clip.endTime),
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      "-y", outputPath,
    ]);

    return outputPath;
  }

  async removeSilence(clipPath: string, outputPath: string, config: Config): Promise<string> {
    if (await fileExists(outputPath)) {
      log.info("Silence-removed clip already exists");
      return outputPath;
    }

    log.info("Detecting silence...");
    const silenceRanges = await detectSilence(clipPath, config.silenceThresholdDb, config.silenceMinDuration);

    if (silenceRanges.length === 0) {
      log.info("No significant silence detected, copying as-is");
      await Bun.write(outputPath, Bun.file(clipPath));
      return outputPath;
    }

    const clipDuration = await getVideoDuration(clipPath);
    const speechRanges = this.invertRanges(silenceRanges, clipDuration, 0.05);

    if (speechRanges.length === 0) {
      log.warn("No speech ranges found, keeping original");
      await Bun.write(outputPath, Bun.file(clipPath));
      return outputPath;
    }

    const totalSpeech = speechRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
    if (totalSpeech < 10) {
      log.warn(`Too short after silence removal (${totalSpeech.toFixed(1)}s), keeping original`);
      await Bun.write(outputPath, Bun.file(clipPath));
      return outputPath;
    }

    log.info(`Removing ${silenceRanges.length} silence gaps (keeping ${totalSpeech.toFixed(1)}s of ${clipDuration.toFixed(1)}s)`);

    const selectExpr = speechRanges
      .map(r => `between(t\\,${r.start.toFixed(3)}\\,${r.end.toFixed(3)})`)
      .join("+");

    await runFfmpeg([
      "-i", clipPath,
      "-vf", `select='${selectExpr}',setpts=N/FRAME_RATE/TB`,
      "-af", `aselect='${selectExpr}',asetpts=N/SR/TB`,
      "-c:v", "libx264", "-preset", "fast", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      "-y", outputPath,
    ]);

    return outputPath;
  }

  async composeReel(
    clipPath: string,
    captionOverlayPath: string | null,
    config: Config,
    outputPath: string,
    srtPath?: string | null,
  ): Promise<string> {
    if (await fileExists(outputPath)) {
      log.info("Reel already composed");
      return outputPath;
    }

    const surferFiles = listFiles(config.paths.subwaySurfers, ".mp4");
    if (surferFiles.length === 0) {
      log.warn("No subway surfers footage found, creating single-video reel");
      return this.composeSingleReel(clipPath, captionOverlayPath, config, outputPath, srtPath);
    }

    const surferPath = randomItem(surferFiles);
    const surferDuration = await getVideoDuration(surferPath);
    const clipDuration = await getVideoDuration(clipPath);

    const speed = config.clipSpeed;
    const effectiveClipDuration = clipDuration / speed;
    const maxOffset = Math.max(0, surferDuration - effectiveClipDuration);
    const surferOffset = Math.random() * maxOffset;

    log.info(`Composing split-screen reel (${speed}x speed)...`);

    const halfHeight = Math.floor(config.outputHeight / 2);
    const w = config.outputWidth;

    let filterComplex = `[0:v]fps=30,scale=${w}:${halfHeight}:force_original_aspect_ratio=increase,crop=${w}:${halfHeight}[top];` +
      `[1:v]fps=30,setpts=PTS/${speed},scale=${w}:${halfHeight}:force_original_aspect_ratio=increase,crop=${w}:${halfHeight}[bottom];` +
      `[1:a]atempo=${speed}[afast];` +
      `[top][bottom]vstack=inputs=2[bg]`;

    const inputs = [
      "-ss", secondsToFfmpegTimestamp(surferOffset), "-i", surferPath,
      "-i", clipPath,
    ];

    const canBurnSubs = await hasSubtitlesFilter();

    if (captionOverlayPath && await fileExists(captionOverlayPath)) {
      inputs.push("-i", captionOverlayPath);
      filterComplex += `;[2:v]scale=${w}:${config.outputHeight}[captions];[bg][captions]overlay=0:0:format=auto[out]`;
    } else if (srtPath && await fileExists(srtPath) && canBurnSubs) {
      const escaped = srtPath.replace(/\\/g, "\\\\\\\\").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
      filterComplex += `;[bg]subtitles=${escaped}:force_style='FontSize=18,PrimaryColour=&H00FFFFFF,BorderStyle=4,BackColour=&H80000000,Outline=0,Shadow=0,Alignment=5,MarginV=0'[out]`;
    } else {
      filterComplex += `;[bg]copy[out]`;
    }

    await runFfmpeg([
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[out]", "-map", "[afast]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      "-r", "30",
      "-shortest",
      "-y", outputPath,
    ]);

    log.info(`Reel composed: ${outputPath}`);
    return outputPath;
  }

  private async composeSingleReel(
    clipPath: string,
    captionOverlayPath: string | null,
    config: Config,
    outputPath: string,
    srtPath?: string | null,
  ): Promise<string> {
    const w = config.outputWidth;
    const h = config.outputHeight;
    const speed = config.clipSpeed;

    let filterComplex = `[0:v]fps=30,setpts=PTS/${speed},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}[base];` +
      `[0:a]atempo=${speed}[afast]`;
    const inputs = ["-i", clipPath];

    const canBurnSubs = await hasSubtitlesFilter();

    if (captionOverlayPath && await fileExists(captionOverlayPath)) {
      inputs.push("-i", captionOverlayPath);
      filterComplex += `;[1:v]scale=${w}:${h}[captions];[base][captions]overlay=0:0:format=auto[out]`;
    } else if (srtPath && await fileExists(srtPath) && canBurnSubs) {
      const escaped = srtPath.replace(/\\/g, "\\\\\\\\").replace(/:/g, "\\\\:").replace(/'/g, "\\\\'");
      filterComplex += `;[base]subtitles=${escaped}:force_style='FontSize=18,PrimaryColour=&H00FFFFFF,BorderStyle=4,BackColour=&H80000000,Outline=0,Shadow=0,Alignment=5,MarginV=0'[out]`;
    } else {
      filterComplex += `;[base]copy[out]`;
    }

    await runFfmpeg([
      ...inputs,
      "-filter_complex", filterComplex,
      "-map", "[out]", "-map", "[afast]",
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k",
      "-r", "30",
      "-y", outputPath,
    ]);

    return outputPath;
  }

  private invertRanges(silenceRanges: Array<{ start: number; end: number }>, totalDuration: number, buffer: number): Array<{ start: number; end: number }> {
    const sorted = [...silenceRanges].sort((a, b) => a.start - b.start);
    const speech: Array<{ start: number; end: number }> = [];
    let cursor = 0;

    for (const silence of sorted) {
      const speechStart = cursor;
      const speechEnd = Math.max(cursor, silence.start - buffer);
      if (speechEnd - speechStart > 0.05) {
        speech.push({ start: Math.max(0, speechStart), end: speechEnd });
      }
      cursor = silence.end + buffer;
    }

    if (cursor < totalDuration) {
      speech.push({ start: cursor, end: totalDuration });
    }

    return speech;
  }
}
