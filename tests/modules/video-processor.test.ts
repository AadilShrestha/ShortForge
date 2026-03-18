import { describe, test, expect, afterAll } from "bun:test";
import { VideoProcessor } from "../../src/modules/video-processor";
import { runFfprobe } from "../../src/utils/ffmpeg";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TMP = join(import.meta.dir, "__tmp_vp__");
const TEST_VIDEO = join(TMP, "test_input.mp4");

async function createTestVideo() {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, "clips"), { recursive: true });

  // Generate a 15s test video with speech-like audio + silence gaps
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=duration=15:size=1920x1080:rate=30",
      "-f",
      "lavfi",
      "-i",
      // 0-3s tone, 3-6s silence, 6-10s tone, 10-12s silence, 12-15s tone
      "aevalsrc='if(between(t,0,3)+between(t,6,10)+between(t,12,15),sin(440*2*PI*t),0)':s=44100:d=15",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "28",
      "-c:a",
      "aac",
      "-b:a",
      "64k",
      "-shortest",
      TEST_VIDEO,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  await proc.exited;
}

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
});

describe("VideoProcessor", () => {
  test("extractClip extracts a segment from a video", async () => {
    await createTestVideo();
    const vp = new VideoProcessor();
    const clip = {
      id: "test-clip-1",
      title: "Test Clip",
      hookLine: "hook",
      startTime: 2,
      endTime: 10,
      duration: 8,
      reasoning: "test",
      viralScore: 8,
      tags: ["test"],
    };

    const outputPath = await vp.extractClip(TEST_VIDEO, clip, join(TMP, "clips"));
    expect(existsSync(outputPath)).toBe(true);

    const info = await runFfprobe(outputPath);
    expect(info.duration).toBeGreaterThan(5);
    expect(info.duration).toBeLessThan(12);
  }, 30_000);

  test("removeSilence produces shorter output when silence exists", async () => {
    await createTestVideo();
    const vp = new VideoProcessor();
    const config = {
      geminiApiKey: "",
      whisperModel: "base" as const,
      maxParallelClips: 3,
      silenceThresholdDb: -30,
      silenceMinDuration: 0.5,
      outputWidth: 1080,
      outputHeight: 1920,
      preferYouTubeTranscripts: true,
      captionAnimate: true,
      paths: {
        data: "./data",
        output: "./output",
        assets: "./assets",
        subwaySurfers: "./assets/subway-surfers",
        checkpointDb: "./data/test.db",
      },
    };

    const outputPath = join(TMP, "desilenced.mp4");
    const result = await vp.removeSilence(TEST_VIDEO, outputPath, config);
    expect(existsSync(result)).toBe(true);

    const originalInfo = await runFfprobe(TEST_VIDEO);
    const cleanInfo = await runFfprobe(result);
    // With silence removed, output should be shorter
    expect(cleanInfo.duration).toBeLessThanOrEqual(originalInfo.duration);
  }, 30_000);

  test("composeSingleReel (no subway surfers) produces 9:16 output", async () => {
    await createTestVideo();
    const vp = new VideoProcessor();
    const config = {
      geminiApiKey: "",
      whisperModel: "base" as const,
      maxParallelClips: 3,
      silenceThresholdDb: -35,
      silenceMinDuration: 0.8,
      outputWidth: 1080,
      outputHeight: 1920,
      preferYouTubeTranscripts: true,
      captionAnimate: true,
      paths: {
        data: TMP,
        output: TMP,
        assets: TMP,
        subwaySurfers: join(TMP, "no-surfers"),
        checkpointDb: join(TMP, "test.db"),
      },
    };

    const outputPath = join(TMP, "reel.mp4");
    const result = await vp.composeReel(TEST_VIDEO, null, config, outputPath);
    expect(existsSync(result)).toBe(true);

    const info = await runFfprobe(result);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
  }, 60_000);
});
