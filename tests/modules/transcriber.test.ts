import { describe, test, expect } from "bun:test";
import { Transcriber } from "../../src/modules/transcriber";
import { mkdirSync, rmSync, existsSync } from "fs";
import { join } from "path";

const TMP = join(import.meta.dir, "__tmp_transcriber__");

describe("Transcriber", () => {
  test("writeSrt generates valid SRT format", async () => {
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    const transcriber = new Transcriber();
    const segments = [
      { text: "Hello world", start: 0, duration: 2, end: 2 },
      { text: "This is a test", start: 2.5, duration: 3, end: 5.5 },
      { text: "Final segment", start: 6, duration: 2, end: 8 },
    ];

    const srtPath = join(TMP, "test.srt");
    await transcriber.writeSrt(segments, srtPath);

    const content = await Bun.file(srtPath).text();
    expect(content).toContain("1\n");
    expect(content).toContain("00:00:00,000 --> 00:00:02,000");
    expect(content).toContain("Hello world");
    expect(content).toContain("2\n");
    expect(content).toContain("00:00:02,500 --> 00:00:05,500");
    expect(content).toContain("This is a test");
    expect(content).toContain("3\n");

    rmSync(TMP, { recursive: true, force: true });
  });

  test("fromYouTube fetches transcript for known video", async () => {
    const transcriber = new Transcriber();
    const config = {
      geminiApiKey: "",
      whisperModel: "base" as const,
      maxParallelClips: 3,
      silenceThresholdDb: -35,
      silenceMinDuration: 0.8,
      outputWidth: 1080,
      outputHeight: 1920,
      clipMinDurationSec: 20,
      clipMaxDurationSec: 30,
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

    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });

    try {
      const transcript = await transcriber.transcribe(
        {
          videoId: "dQw4w9WgXcQ",
          title: "Test",
          duration: 212,
          uploadDate: "2009-10-25",
          filePath: "/tmp/fake.mp4",
        },
        TMP,
        config,
      );
      expect(transcript.source).toBe("youtube");
      expect(transcript.segments.length).toBeGreaterThan(0);
      expect(transcript.fullText.length).toBeGreaterThan(0);
    } finally {
      if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    }
  }, 30_000);

  test("falls back to yt-dlp captions when YouTube API fails", async () => {
    const transcriber = new Transcriber() as any;
    const calls: string[] = [];

    transcriber.fromYouTube = async () => {
      calls.push("youtube");
      throw new Error("blocked");
    };
    transcriber.fromYtDlpCaptions = async () => {
      calls.push("ytdlp");
      return {
        source: "youtube",
        language: "en",
        segments: [{ text: "hello", start: 0, duration: 1, end: 1 }],
        fullText: "hello",
        srtPath: null,
      };
    };
    transcriber.fromWhisper = async () => {
      calls.push("whisper");
      throw new Error("should not run");
    };

    const transcript = await transcriber.transcribe(
      { videoId: "v", title: "t", duration: 1, uploadDate: "", filePath: "f.mp4" },
      TMP,
      { preferYouTubeTranscripts: true, whisperModel: "base" },
    );

    expect(transcript.source).toBe("youtube");
    expect(calls).toEqual(["youtube", "ytdlp"]);
  });

  test("falls back to Whisper when caption fallback fails", async () => {
    const transcriber = new Transcriber() as any;
    const calls: string[] = [];

    transcriber.fromYouTube = async () => {
      calls.push("youtube");
      throw new Error("blocked");
    };
    transcriber.fromYtDlpCaptions = async () => {
      calls.push("ytdlp");
      throw new Error("caption track missing");
    };
    transcriber.fromWhisper = async () => {
      calls.push("whisper");
      return {
        source: "whisper",
        language: "en",
        segments: [{ text: "fallback", start: 0, duration: 1, end: 1 }],
        fullText: "fallback",
        srtPath: null,
      };
    };

    const transcript = await transcriber.transcribe(
      { videoId: "v", title: "t", duration: 1, uploadDate: "", filePath: "f.mp4" },
      TMP,
      { preferYouTubeTranscripts: true, whisperModel: "base" },
    );

    expect(transcript.source).toBe("whisper");
    expect(calls).toEqual(["youtube", "ytdlp", "whisper"]);
  });
});
