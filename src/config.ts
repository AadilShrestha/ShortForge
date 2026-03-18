import { z } from "zod";

const configSchema = z.object({
  geminiApiKey: z.string().min(1),
  whisperModel: z
    .enum(["tiny", "base", "small", "medium", "large"])
    .default("base"),
  maxParallelClips: z.coerce.number().int().min(1).max(10).default(3),
  silenceThresholdDb: z.coerce.number().default(-35),
  silenceMinDuration: z.coerce.number().default(0.8),
  outputWidth: z.coerce.number().default(1080),
  outputHeight: z.coerce.number().default(1920),
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
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    geminiApiKey: Bun.env.GEMINI_API_KEY,
    whisperModel: Bun.env.WHISPER_MODEL,
    maxParallelClips: Bun.env.MAX_PARALLEL_CLIPS,
    silenceThresholdDb: Bun.env.SILENCE_THRESHOLD_DB,
    silenceMinDuration: Bun.env.SILENCE_MIN_DURATION,
    outputWidth: Bun.env.OUTPUT_WIDTH,
    outputHeight: Bun.env.OUTPUT_HEIGHT,
    preferYouTubeTranscripts: Bun.env.PREFER_YOUTUBE_TRANSCRIPTS,
    captionAnimate: Bun.env.CAPTION_ANIMATE,
    paths: {},
  });
}
