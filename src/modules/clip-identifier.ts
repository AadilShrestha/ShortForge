import { GoogleGenAI } from "@google/genai";
import { createLogger } from "../utils/logger";
import type { Config } from "../config";
import type { Transcript, VideoMetadata, ClipCandidate } from "../pipeline/types";

const log = createLogger("clip-identifier");

const CLIP_SCHEMA = {
  type: "object" as const,
  properties: {
    clips: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          title: { type: "string" as const },
          hookLine: { type: "string" as const },
          startTime: { type: "number" as const },
          endTime: { type: "number" as const },
          reasoning: { type: "string" as const },
          viralScore: { type: "number" as const },
          tags: { type: "array" as const, items: { type: "string" as const } },
        },
        required: ["title", "hookLine", "startTime", "endTime", "reasoning", "viralScore", "tags"],
      },
    },
  },
  required: ["clips"],
};

export class ClipIdentifier {
  private ai: GoogleGenAI;

  constructor(config: Config) {
    this.ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  async identify(transcript: Transcript, metadata: VideoMetadata): Promise<ClipCandidate[]> {
    log.info(`Analyzing transcript for clip-worthy segments...`);

    const formattedTranscript = transcript.segments
      .map(s => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
      .join("\n");

    const prompt = `You are a viral content strategist specializing in history/education TikTok and YouTube Shorts.

Analyze this lecture transcript from "${metadata.title}" (total duration: ${metadata.duration} seconds) and identify segments that would make compelling short-form clips (30-90 seconds each).

Look for:
- Surprising or counterintuitive historical facts
- Dramatic storytelling moments
- Mind-blowing connections between historical events
- Controversial or thought-provoking claims
- Quotable one-liners or powerful statements
- "Did you know?" moments that make people stop scrolling

Each clip MUST:
- Be 30-90 seconds long
- Be self-contained (makes sense without surrounding context)
- Start with a hook that grabs attention in the first 3 seconds
- Have a clear payoff or revelation

IMPORTANT: The timestamps in the transcript are in SECONDS (e.g., 533.0s means 533 seconds into the video).
Return startTime and endTime as numbers in SECONDS (not minutes:seconds). For example, if a clip starts at 8 minutes 53 seconds, return startTime: 533.

TRANSCRIPT:
${formattedTranscript}

Return clips sorted by viralScore (highest first). Aim for 5-15 clips depending on video length.`;

    const response = await this.ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: CLIP_SCHEMA,
      },
    });

    const text = response.text ?? "";
    const parsed = JSON.parse(text) as { clips: Array<{
      title: string;
      hookLine: string;
      startTime: number;
      endTime: number;
      reasoning: string;
      viralScore: number;
      tags: string[];
    }> };

    log.info(`Gemini returned ${parsed.clips.length} raw clips (video duration: ${metadata.duration}s)`);
    for (const c of parsed.clips) {
      const dur = c.endTime - c.startTime;
      log.debug(`  "${c.title}" ${c.startTime}s-${c.endTime}s (${dur.toFixed(0)}s) score=${c.viralScore}`);
    }

    const candidates: ClipCandidate[] = parsed.clips
      .filter(c => {
        const duration = c.endTime - c.startTime;
        if (duration < 15 || duration > 120 || c.startTime < 0 || c.endTime > metadata.duration) {
          log.debug(`  Filtered out: "${c.title}" (dur=${duration.toFixed(0)}s, end=${c.endTime}, max=${metadata.duration})`);
          return false;
        }
        return true;
      })
      .map(c => ({
        id: crypto.randomUUID(),
        title: c.title,
        hookLine: c.hookLine,
        startTime: c.startTime,
        endTime: c.endTime,
        duration: c.endTime - c.startTime,
        reasoning: c.reasoning,
        viralScore: c.viralScore,
        tags: c.tags,
      }))
      .sort((a, b) => b.viralScore - a.viralScore);

    log.info(`Identified ${candidates.length} clip candidates`);
    return candidates;
  }

}
