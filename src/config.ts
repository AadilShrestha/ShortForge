import { z } from "zod";

const clipIdentifierProviderSchema = z.enum(["copilot", "gemini"]);

const configSchema = z
  .object({
    clipIdentifierProvider: clipIdentifierProviderSchema.default("copilot"),
    geminiApiKey: z.string().min(1).optional(),
    copilotModel: z.string().min(1).default("gpt-5-mini"),
    copilotModelFallbacks: z
      .array(z.string().min(1))
      .default(["gpt-5.3-codex", "gpt-5", "gpt-4.1"]),
    copilotSingleRequestMode: z.coerce.boolean().default(true),
    clipIdentifierRetryAttempts: z.coerce.number().int().min(1).max(8).default(4),
    clipIdentifierRetryBaseDelayMs: z.coerce.number().int().min(100).max(60_000).default(1000),
    clipIdentifierRetryMaxDelayMs: z.coerce.number().int().min(100).max(120_000).default(10_000),
    whisperModel: z.enum(["tiny", "base", "small", "medium", "large"]).default("base"),
    maxParallelClips: z.coerce.number().int().min(1).max(10).default(3),
    silenceThresholdDb: z.coerce.number().default(-35),
    silenceMinDuration: z.coerce.number().default(0.8),
    outputWidth: z.coerce.number().default(1080),
    outputHeight: z.coerce.number().default(1920),
    clipMinDurationSec: z.coerce.number().int().min(5).max(180).default(20),
    clipMaxDurationSec: z.coerce.number().int().min(5).max(180).default(30),
    clipSpeed: z.coerce.number().min(1).max(2).default(1.2),
    maxClips: z.coerce.number().int().min(0).default(0),
    preferYouTubeTranscripts: z.coerce.boolean().default(true),
    captionAnimate: z.coerce.boolean().default(true),
    paths: z
      .object({
        data: z.string().default("./data"),
        output: z.string().default("./output"),
        assets: z.string().default("./assets"),
        subwaySurfers: z.string().default("./assets/subway-surfers"),
        checkpointDb: z.string().default("./data/checkpoints.db"),
      })
      .default({}),
  })
  .refine((config) => config.clipMaxDurationSec >= config.clipMinDurationSec, {
    message:
      "CLIP_MAX_DURATION_SEC must be greater than or equal to CLIP_MIN_DURATION_SEC",
    path: ["clipMaxDurationSec"],
  })
  .refine(
    (config) =>
      config.clipIdentifierRetryMaxDelayMs >= config.clipIdentifierRetryBaseDelayMs,
    {
      message:
        "CLIP_IDENTIFIER_RETRY_MAX_DELAY_MS must be greater than or equal to CLIP_IDENTIFIER_RETRY_BASE_DELAY_MS",
      path: ["clipIdentifierRetryMaxDelayMs"],
    },
  )
  .refine(
    (config) =>
      config.clipIdentifierProvider !== "gemini" || Boolean(config.geminiApiKey),
    {
      message: "GEMINI_API_KEY is required when CLIP_IDENTIFIER_PROVIDER=gemini",
      path: ["geminiApiKey"],
    },
  );

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    clipIdentifierProvider: Bun.env.CLIP_IDENTIFIER_PROVIDER,
    geminiApiKey: Bun.env.GEMINI_API_KEY,
    copilotModel: Bun.env.COPILOT_MODEL,
    copilotModelFallbacks: parseCsvEnvList(Bun.env.COPILOT_MODEL_FALLBACKS),
    copilotSingleRequestMode: Bun.env.COPILOT_SINGLE_REQUEST_MODE,
    clipIdentifierRetryAttempts: Bun.env.CLIP_IDENTIFIER_RETRY_ATTEMPTS,
    clipIdentifierRetryBaseDelayMs: Bun.env.CLIP_IDENTIFIER_RETRY_BASE_DELAY_MS,
    clipIdentifierRetryMaxDelayMs: Bun.env.CLIP_IDENTIFIER_RETRY_MAX_DELAY_MS,
    whisperModel: Bun.env.WHISPER_MODEL,
    maxParallelClips: Bun.env.MAX_PARALLEL_CLIPS,
    silenceThresholdDb: Bun.env.SILENCE_THRESHOLD_DB,
    silenceMinDuration: Bun.env.SILENCE_MIN_DURATION,
    outputWidth: Bun.env.OUTPUT_WIDTH,
    outputHeight: Bun.env.OUTPUT_HEIGHT,
    clipMinDurationSec: Bun.env.CLIP_MIN_DURATION_SEC,
    clipMaxDurationSec: Bun.env.CLIP_MAX_DURATION_SEC,
    clipSpeed: Bun.env.CLIP_SPEED,
    maxClips: Bun.env.MAX_CLIPS,
    preferYouTubeTranscripts: Bun.env.PREFER_YOUTUBE_TRANSCRIPTS,
    captionAnimate: Bun.env.CAPTION_ANIMATE,
    paths: {},
  });
}

function parseCsvEnvList(value: string | undefined): string[] | undefined {
  const rawValue = value?.trim();
  if (!rawValue) {
    return undefined;
  }

  const parsed = rawValue
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}