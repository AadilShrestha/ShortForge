import { describe, test, expect } from "bun:test";

import { ClipIdentifier } from "../../src/modules/clip-identifier";

import type { Config } from "../../src/config";
import type { Transcript, VideoMetadata } from "../../src/pipeline/types";

type MockProvider = {
  provider: Config["clipIdentifierProvider"];
  generate: (prompt: string) => Promise<string>;
};

const sampleTranscript: Transcript = {
  source: "youtube",
  language: "en",
  fullText: "A short deterministic transcript for tests.",
  srtPath: null,
  segments: [{ text: "Test segment", start: 0, end: 15, duration: 15 }],
};

const sampleMetadata: VideoMetadata = {
  videoId: "video-1",
  title: "Deterministic Test Video",
  duration: 120,
  uploadDate: "2024-01-01",
  filePath: "/tmp/test.mp4",
};

const validProviderPayload = {
  clips: [
    {
      title: "Stable success clip",
      hookLine: "Hook now",
      startTime: 10,
      endTime: 22,
      reasoning: "Good retention",
      viralScore: 92,
      tags: ["test", "viral"],
    },
  ],
};

const baseConfig: Config = {
  clipIdentifierProvider: "copilot",
  geminiApiKey: undefined,
  copilotModel: "gpt-4.1",
  copilotModelFallbacks: ["gpt-5.3-codex", "gpt-5", "gpt-4.1"],
  copilotSingleRequestMode: true,
  clipIdentifierRetryAttempts: 3,
  clipIdentifierRetryBaseDelayMs: 1,
  clipIdentifierRetryMaxDelayMs: 1,
  whisperModel: "base",
  maxParallelClips: 3,
  silenceThresholdDb: -35,
  silenceMinDuration: 0.8,
  outputWidth: 1080,
  outputHeight: 1920,
  clipMinDurationSec: 10,
  clipMaxDurationSec: 20,
  clipSpeed: 1,
  maxClips: 0,
  preferYouTubeTranscripts: true,
  captionAnimate: true,
  paths: {
    data: "./data",
    output: "./output",
    assets: "./assets",
    subwaySurfers: "./assets/subway-surfers",
    checkpointDb: "./data/checkpoints.db",
  },
};

function buildConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...baseConfig,
    ...overrides,
    paths: {
      ...baseConfig.paths,
      ...overrides.paths,
    },
  };
}

function setMockProvider(identifier: ClipIdentifier, provider: MockProvider): void {
  const internals = identifier as unknown as { provider: MockProvider };
  internals.provider = provider;
}

describe("ClipIdentifier", () => {
  test("uses copilot by default and gemini when explicitly configured", () => {
    const copilotIdentifier = new ClipIdentifier(buildConfig());
    const copilotInternals = copilotIdentifier as unknown as { provider: MockProvider };
    expect(copilotInternals.provider.provider).toBe("copilot");

    const geminiIdentifier = new ClipIdentifier(
      buildConfig({
        clipIdentifierProvider: "gemini",
        geminiApiKey: "fake-api-key",
      }),
    );
    const geminiInternals = geminiIdentifier as unknown as { provider: MockProvider };
    expect(geminiInternals.provider.provider).toBe("gemini");
  });

  test("retries transient failures and eventually succeeds", async () => {
      const identifier = new ClipIdentifier(
        buildConfig({ clipIdentifierRetryAttempts: 3, copilotSingleRequestMode: false }),
      );
      let calls = 0;

      setMockProvider(identifier, {
        provider: "copilot",
        generate: async () => {
          calls += 1;
          if (calls === 1) {
            const transientError = new Error("service unavailable") as Error & {
              status?: number;
            };
            transientError.status = 503;
            throw transientError;
          }

          return JSON.stringify(validProviderPayload);
        },
      });

      const clips = await identifier.identify(sampleTranscript, sampleMetadata);

      expect(calls).toBe(2);
      expect(clips).toHaveLength(1);
      expect(clips[0]?.title).toBe("Stable success clip");
      expect(clips[0]?.duration).toBe(12);
    });

  test("uses a single provider attempt in copilot single-request mode", async () => {
    const identifier = new ClipIdentifier(
      buildConfig({ clipIdentifierRetryAttempts: 5, copilotSingleRequestMode: true }),
    );
    let calls = 0;

    setMockProvider(identifier, {
      provider: "copilot",
      generate: async () => {
        calls += 1;
        throw new Error("service unavailable");
      },
    });

    await expect(identifier.identify(sampleTranscript, sampleMetadata)).rejects.toThrow(
      "service unavailable",
    );
    expect(calls).toBe(1);
  });

  test("fails fast on non-retryable errors", async () => {
    const identifier = new ClipIdentifier(buildConfig({ clipIdentifierRetryAttempts: 6 }));
    let calls = 0;

    setMockProvider(identifier, {
      provider: "copilot",
      generate: async () => {
        calls += 1;
        throw new Error("unauthorized: missing permission");
      },
    });

    await expect(identifier.identify(sampleTranscript, sampleMetadata)).rejects.toThrow(
      "unauthorized: missing permission",
    );
    expect(calls).toBe(1);
  });

  test("rejects malformed provider payload with parse/schema error details", async () => {
    const identifier = new ClipIdentifier(buildConfig({ clipIdentifierRetryAttempts: 4 }));
    let calls = 0;

    setMockProvider(identifier, {
      provider: "copilot",
      generate: async () => {
        calls += 1;
        return "{\"clips\": [";
      },
    });

    await expect(identifier.identify(sampleTranscript, sampleMetadata)).rejects.toThrow(
      /malformed JSON|schema validation/i,
    );
    expect(calls).toBe(1);
  });

  test("builds a context-aware prompt with complete-thought constraints", async () => {
    const identifier = new ClipIdentifier(buildConfig());
    let capturedPrompt = "";

    setMockProvider(identifier, {
      provider: "copilot",
      generate: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify(validProviderPayload);
      },
    });

    await identifier.identify(sampleTranscript, sampleMetadata);

    expect(capturedPrompt).toContain("Before selecting clips, infer the video's core narrative arcs");
    expect(capturedPrompt).toContain("End only after a complete thought/payoff");
  });

  test("refines clip timestamps to transcript boundaries for cleaner context", async () => {
    const identifier = new ClipIdentifier(buildConfig());
    const transcriptWithBoundaries: Transcript = {
      source: "youtube",
      language: "en",
      fullText: "Setup and then reveal and ending.",
      srtPath: null,
      segments: [
        { text: "Quick setup", start: 0, end: 5, duration: 5 },
        { text: "and then we challenge the assumption", start: 5, end: 12, duration: 7 },
        { text: "The big reveal lands here.", start: 12, end: 20, duration: 8 },
        { text: "Final line.", start: 20, end: 28, duration: 8 },
      ],
    };

    setMockProvider(identifier, {
      provider: "copilot",
      generate: async () =>
        JSON.stringify({
          clips: [
            {
              title: "Needs cleanup",
              hookLine: "Start now",
              startTime: 6,
              endTime: 18,
              reasoning: "Strong moment",
              viralScore: 88,
              tags: ["context"],
            },
          ],
        }),
    });

    const clips = await identifier.identify(transcriptWithBoundaries, sampleMetadata);
    expect(clips).toHaveLength(1);
    expect(clips[0]?.startTime).toBe(5);
    expect(clips[0]?.endTime).toBe(20);
  });
});
