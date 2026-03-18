import { createLogger } from "./logger";
import { existsSync } from "fs";

const log = createLogger("ffmpeg");

export interface FfprobeResult {
  duration: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  fps: number;
}

export interface SilenceRange {
  start: number;
  end: number;
}

const FFMPEG_FULL_PATH = "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg";
const FFPROBE_FULL_PATH = "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe";

function getFfmpegBin(): string {
  if (existsSync(FFMPEG_FULL_PATH)) return FFMPEG_FULL_PATH;
  return "ffmpeg";
}

function getFfprobeBin(): string {
  if (existsSync(FFPROBE_FULL_PATH)) return FFPROBE_FULL_PATH;
  return "ffprobe";
}

let _hasSubtitlesFilter: boolean | null = null;

export async function hasSubtitlesFilter(): Promise<boolean> {
  if (_hasSubtitlesFilter !== null) return _hasSubtitlesFilter;
  try {
    const proc = Bun.spawn([getFfmpegBin(), "-filters"], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;
    _hasSubtitlesFilter = stdout.includes("subtitles");
    log.debug(`subtitles filter available: ${_hasSubtitlesFilter}`);
    return _hasSubtitlesFilter;
  } catch {
    _hasSubtitlesFilter = false;
    return false;
  }
}

export async function runFfmpeg(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const bin = getFfmpegBin();
  log.debug(`${bin} ${args.join(" ")}`);
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    log.error(`ffmpeg failed (exit ${exitCode}): ${stderr.slice(-500)}`);
    throw new Error(`ffmpeg exited with code ${exitCode}: ${stderr.slice(-500)}`);
  }
  return { stdout, stderr, exitCode };
}

export async function runFfprobe(filePath: string): Promise<FfprobeResult> {
  const proc = Bun.spawn(
    [
      getFfprobeBin(),
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const data = JSON.parse(stdout);
  const videoStream = data.streams?.find((s: Record<string, unknown>) => s.codec_type === "video");
  const audioStream = data.streams?.find((s: Record<string, unknown>) => s.codec_type === "audio");
  const fpsStr: string = videoStream?.r_frame_rate || "30/1";
  const [num, den] = fpsStr.split("/").map(Number);

  return {
    duration: parseFloat(data.format?.duration || "0"),
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    videoCodec: videoStream?.codec_name || "",
    audioCodec: audioStream?.codec_name || "",
    fps: den ? num / den : 30,
  };
}

export async function getVideoDuration(filePath: string): Promise<number> {
  const info = await runFfprobe(filePath);
  return info.duration;
}

export async function detectSilence(
  filePath: string,
  thresholdDb: number,
  minDuration: number,
): Promise<SilenceRange[]> {
  const proc = Bun.spawn(
    [
      getFfmpegBin(),
      "-i",
      filePath,
      "-af",
      `silencedetect=n=${thresholdDb}dB:d=${minDuration}`,
      "-f",
      "null",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const ranges: SilenceRange[] = [];
  const startRegex = /silence_start: ([\d.]+)/g;
  const endRegex = /silence_end: ([\d.]+)/g;
  const starts: number[] = [];
  const ends: number[] = [];

  let match;
  while ((match = startRegex.exec(stderr)) !== null) starts.push(parseFloat(match[1]));
  while ((match = endRegex.exec(stderr)) !== null) ends.push(parseFloat(match[1]));

  for (let i = 0; i < starts.length; i++) {
    ranges.push({
      start: starts[i],
      end: ends[i] ?? starts[i] + minDuration,
    });
  }
  return ranges;
}

export function secondsToSrtTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function secondsToFfmpegTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}
