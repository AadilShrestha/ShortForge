import {
  CopilotClient,
  approveAll,
  type GetAuthStatusResponse,
  type ModelInfo,
} from "@github/copilot-sdk";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import { createLogger } from "../utils/logger";
import type { Config } from "../config";
import type { Transcript, VideoMetadata, ClipCandidate } from "../pipeline/types";

const log = createLogger("clip-identifier");

const DEFAULT_COPILOT_FALLBACK_MODELS = ["gpt-5.3-codex", "gpt-5", "gpt-4.1"] as const;

const CLIP_RESPONSE_JSON_SCHEMA = {
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

const clipResponseSchema = z
  .object({
    clips: z.array(
      z
        .object({
          title: z.string(),
          hookLine: z.string(),
          startTime: z.number(),
          endTime: z.number(),
          reasoning: z.string(),
          viralScore: z.number(),
          tags: z.array(z.string()),
        })
        .strict(),
    ),
  })
  .strict();

type ClipModelResponse = z.infer<typeof clipResponseSchema>;
type ClipIdentifierProviderName = Config["clipIdentifierProvider"];
type NonRetryableErrorCategory =
  | "auth"
  | "config"
  | "subscription"
  | "json"
  | "schema"
  | "response";

interface ClipModelProvider {
  readonly provider: ClipIdentifierProviderName;
  generate(prompt: string): Promise<string>;
}

interface RetryDecision {
  retryable: boolean;
  reason: string;
}

class NonRetryableProviderError extends Error {
  constructor(
    readonly provider: ClipIdentifierProviderName,
    readonly category: NonRetryableErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "NonRetryableProviderError";
  }
}

class GeminiClipModelProvider implements ClipModelProvider {
  readonly provider = "gemini" as const;
  private readonly ai: GoogleGenAI;

  constructor(apiKey: string | undefined) {
    if (!apiKey) {
      throw new NonRetryableProviderError(
        "gemini",
        "config",
        "Gemini provider requires GEMINI_API_KEY. Set CLIP_IDENTIFIER_PROVIDER=gemini only when GEMINI_API_KEY is configured.",
      );
    }

    this.ai = new GoogleGenAI({ apiKey });
  }

  async generate(prompt: string): Promise<string> {
    const response = await this.ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: CLIP_RESPONSE_JSON_SCHEMA,
      },
    });

    return response.text ?? "";
  }
}

class CopilotClipModelProvider implements ClipModelProvider {
  readonly provider = "copilot" as const;
  private readonly model: string;
  private readonly fallbackModels: readonly string[];

  constructor(model: string, fallbackModels: readonly string[]) {
    this.model = model;
    this.fallbackModels = fallbackModels;
  }

  async generate(prompt: string): Promise<string> {
    const githubToken =
      Bun.env.COPILOT_GITHUB_TOKEN?.trim() ||
      Bun.env.GH_TOKEN?.trim() ||
      Bun.env.GITHUB_TOKEN?.trim();
    const client = githubToken
      ? new CopilotClient({ githubToken, useLoggedInUser: false })
      : new CopilotClient();
    let authStatus: GetAuthStatusResponse | undefined;

    try {
      await client.start();
      authStatus = await client.getAuthStatus();

      if (!authStatus.isAuthenticated) {
        throw buildCopilotAuthError(authStatus);
      }

      const model = await this.resolveModel(client);
      const session = await client.createSession({
        model,
        onPermissionRequest: approveAll,
      });

      try {
        const response = await session.sendAndWait({ prompt }, 90_000);
        return response?.data.content ?? "";
      } finally {
        try {
          await session.disconnect();
        } catch (disconnectError) {
          log.debug(
            `[clip-identifier:copilot] Failed to disconnect Copilot session cleanly: ${stringifyError(disconnectError)}`,
          );
        }
      }
    } catch (error) {
      const actionableError = toCopilotSetupError(error, authStatus);
      if (actionableError) {
        throw actionableError;
      }

      throw error;
    } finally {
      try {
        const cleanupErrors = await client.stop();
        if (cleanupErrors.length > 0) {
          log.debug(
            `[clip-identifier:copilot] Copilot client cleanup reported ${cleanupErrors.length} error(s).`,
          );
        }
      } catch (stopError) {
        log.debug(
          `[clip-identifier:copilot] Failed to stop Copilot client cleanly: ${stringifyError(stopError)}`,
        );
      }
    }
  }

  private async resolveModel(client: CopilotClient): Promise<string> {
    const orderedCandidates = buildOrderedModelCandidates(this.model, this.fallbackModels);
    const primaryModel = orderedCandidates[0] ?? this.model;

    try {
      const availableModels = await client.listModels();
      const enabledModels = availableModels.filter((model) => model.policy?.state !== "disabled");
      if (enabledModels.length === 0) {
        return primaryModel;
      }

      const availableByLowerId = new Map(
        enabledModels.map((model) => [model.id.toLowerCase(), model.id]),
      );

      for (const candidate of orderedCandidates) {
        const matched = availableByLowerId.get(candidate.toLowerCase());
        if (!matched) {
          continue;
        }

        if (matched.toLowerCase() !== primaryModel.toLowerCase()) {
          log.warn(
            `[clip-identifier:copilot] Requested model "${primaryModel}" unavailable. Falling back to "${matched}".`,
          );
        }
        return matched;
      }

      const cheapestModel = pickCheapestModel(enabledModels);
      if (cheapestModel) {
        log.warn(
          `[clip-identifier:copilot] None of the preferred models are available (${orderedCandidates.join(", ")}). Using "${cheapestModel.id}" based on lowest billing multiplier.`,
        );
        return cheapestModel.id;
      }
    } catch (error) {
      log.debug(
        `[clip-identifier:copilot] Could not list models, using requested model "${primaryModel}": ${stringifyError(error)}`,
      );
    }

    return primaryModel;
  }
}

const retryableHttpStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
const retryableNetworkErrorCodes = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

const authErrorNeedles = [
  "authentication",
  "not authenticated",
  "unauthorized",
  "forbidden",
  "login",
  "token",
  "credential",
  "permission denied",
];

const subscriptionErrorNeedles = [
  "subscription",
  "entitlement",
  "copilot access",
  "copilot is not enabled",
  "billing",
  "seat assignment",
  "plan",
];

const configErrorNeedles = [
  "invalid api key",
  "missing api key",
  "invalid model",
  "unsupported model",
  "model not found",
  "bad request",
  "configuration",
  "copilot cli not found",
  "could not find @github/copilot",
  "path to copilot cli is required",
];

const transientErrorNeedles = [
  "rate limit",
  "too many requests",
  "temporarily unavailable",
  "temporary",
  "timeout",
  "timed out",
  "overloaded",
  "capacity",
  "connection reset",
  "network error",
  "service unavailable",
  "gateway timeout",
  "try again",
];

export class ClipIdentifier {
  private readonly provider: ClipModelProvider;
  private readonly retryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly clipMinDurationSec: number;
  private readonly clipMaxDurationSec: number;
  private readonly clipSpeed: number;

  constructor(config: Config) {
      this.provider = createClipModelProvider(config);
      this.retryAttempts =
        config.clipIdentifierProvider === "copilot" && config.copilotSingleRequestMode
          ? 1
          : config.clipIdentifierRetryAttempts;
      this.retryBaseDelayMs = config.clipIdentifierRetryBaseDelayMs;
      this.retryMaxDelayMs = config.clipIdentifierRetryMaxDelayMs;
      this.clipMinDurationSec = config.clipMinDurationSec;
      this.clipMaxDurationSec = config.clipMaxDurationSec;
      this.clipSpeed = config.clipSpeed;
    }

  async identify(transcript: Transcript, metadata: VideoMetadata): Promise<ClipCandidate[]> {
    const providerName = this.provider.provider;
    log.info(`Analyzing transcript for clip-worthy segments with ${providerName} provider...`);

    const formattedTranscript = transcript.segments
      .map((s) => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s] ${s.text}`)
      .join("\n");

    const targetDurationRange = `${this.clipMinDurationSec}-${this.clipMaxDurationSec}`;
    const sourceClipMinDurationSec = this.clipMinDurationSec * this.clipSpeed;
    const sourceClipMaxDurationSec = this.clipMaxDurationSec * this.clipSpeed;
    const sourceDurationRange = `${sourceClipMinDurationSec.toFixed(1)}-${sourceClipMaxDurationSec.toFixed(1)}`;

    const prompt = `You are a viral short-form editor for YouTube Shorts.

    Analyze this transcript from "${metadata.title}" (total duration: ${metadata.duration} seconds) and identify segments that would perform as high-retention Shorts.
    Final target duration after speed adjustment is ${targetDurationRange} seconds at ${this.clipSpeed}x speed.
    Only return source segments inside ${sourceDurationRange} seconds so rendered clips land in ${targetDurationRange} seconds.

    Before selecting clips, infer the video's core narrative arcs (topic setup, conflict/tension, and payoff moments), then pick moments that preserve enough context to feel complete.

    Prioritize moments with:
    - Immediate curiosity, conflict, surprise, or emotional stakes
    - A concrete payoff/reveal within the clip window
    - Strong standalone context (viewer understands without previous scene)
    - Quotable lines, bold claims, challenges, or dramatic reactions

    Each clip MUST:
    - Be ${sourceDurationRange} seconds long in source footage (inclusive)
    - Hook the viewer in the first 1-3 seconds (no warmup or greeting)
    - Start at a natural sentence/thought boundary (not mid-word or clipped syllable)
    - Stay coherent as a standalone clip with enough setup context
    - End only after a complete thought/payoff (never abrupt mid-sentence cutoff)

    IMPORTANT: The timestamps in the transcript are in SECONDS (e.g., 533.0s means 533 seconds into the video).
    Return startTime and endTime as numbers in SECONDS (not minutes:seconds). For example, if a clip starts at 8 minutes 53 seconds, return startTime: 533.

    Return clips sorted by viralScore (highest first). Aim for 5-15 clips depending on video length.
    Return ONLY valid JSON with this shape:
    {"clips":[{"title":"string","hookLine":"string","startTime":0,"endTime":0,"reasoning":"string","viralScore":0,"tags":["string"]}]}
    Do not wrap the JSON in markdown or include extra commentary.

    TRANSCRIPT:
    ${formattedTranscript}`;

    const parsed = await this.generateWithRetry(prompt);
    const refinedClips = parsed.clips.map((clip) =>
      this.refineClipBoundaries(
        clip,
        transcript.segments,
        sourceClipMinDurationSec,
        sourceClipMaxDurationSec,
        metadata.duration,
      ),
    );

    log.info(
      `${providerName} returned ${refinedClips.length} raw clips (video duration: ${metadata.duration}s)`,
    );
    for (const c of refinedClips) {
      const dur = c.endTime - c.startTime;
      log.debug(`  "${c.title}" ${c.startTime}s-${c.endTime}s (${dur.toFixed(0)}s) score=${c.viralScore}`);
    }

    const candidates: ClipCandidate[] = refinedClips
      .filter((c) => {
        const duration = c.endTime - c.startTime;
        const hasOutOfBoundsTimestamps =
          c.startTime < 0 || c.endTime > metadata.duration || c.endTime <= c.startTime;
        const hasOutOfRangeDuration =
          duration < sourceClipMinDurationSec || duration > sourceClipMaxDurationSec;

        if (hasOutOfBoundsTimestamps || hasOutOfRangeDuration) {
          log.debug(
            `  Filtered out: "${c.title}" (start=${c.startTime}, end=${c.endTime}, sourceDur=${duration.toFixed(1)}s, expectedSource=${sourceDurationRange}s, expectedFinal=${targetDurationRange}s, speed=${this.clipSpeed}x, video=${metadata.duration}s)`,
          );
          return false;
        }
        return true;
      })
      .map((c) => ({
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

  private refineClipBoundaries(
    clip: ClipModelResponse["clips"][number],
    transcriptSegments: Transcript["segments"],
    minDurationSec: number,
    maxDurationSec: number,
    videoDurationSec: number,
  ): ClipModelResponse["clips"][number] {
    const normalizedClip = normalizeClipDurationRange(
      clip.startTime,
      clip.endTime,
      minDurationSec,
      maxDurationSec,
      videoDurationSec,
    );

    if (transcriptSegments.length === 0) {
      return {
        ...clip,
        startTime: normalizedClip.startTime,
        endTime: normalizedClip.endTime,
      };
    }

    const snappedStart = findTranscriptStartBoundary(transcriptSegments, normalizedClip.startTime);
    const snappedEnd = findTranscriptEndBoundary(
      transcriptSegments,
      normalizedClip.endTime,
      snappedStart,
      minDurationSec,
      maxDurationSec,
      videoDurationSec,
    );
    const refined = normalizeClipDurationRange(
      snappedStart,
      snappedEnd,
      minDurationSec,
      maxDurationSec,
      videoDurationSec,
    );

    if (
      Math.abs(refined.startTime - clip.startTime) >= 0.25 ||
      Math.abs(refined.endTime - clip.endTime) >= 0.25
    ) {
      log.debug(
        `  Refined timing: "${clip.title}" ${clip.startTime.toFixed(1)}s-${clip.endTime.toFixed(1)}s -> ${refined.startTime.toFixed(1)}s-${refined.endTime.toFixed(1)}s`,
      );
    }

    return {
      ...clip,
      startTime: refined.startTime,
      endTime: refined.endTime,
    };
  }

  private async generateWithRetry(prompt: string): Promise<ClipModelResponse> {
    const providerName = this.provider.provider;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt += 1) {
      try {
        const responseText = await this.provider.generate(prompt);
        return parseClipResponse(providerName, responseText);
      } catch (error) {
        const { retryable, reason } = classifyRetryability(error);
        const isLastAttempt = attempt >= this.retryAttempts;

        if (!retryable || isLastAttempt) {
          log.error(
            `[clip-identifier:${providerName}] Request failed on attempt ${attempt}/${this.retryAttempts} (${reason}): ${stringifyError(error)}`,
          );
          throw toError(error);
        }

        const delayMs = this.computeRetryDelayMs(attempt);
        log.warn(
          `[clip-identifier:${providerName}] Transient failure on attempt ${attempt}/${this.retryAttempts} (${reason}). Retrying in ${delayMs}ms.`,
        );
        await sleep(delayMs);
      }
    }

    throw new Error(`[clip-identifier:${providerName}] Exhausted retries without a response.`);
  }

  private computeRetryDelayMs(attempt: number): number {
    const exponentialDelay = this.retryBaseDelayMs * 2 ** (attempt - 1);
    const boundedDelay = Math.min(this.retryMaxDelayMs, exponentialDelay);
    const jitterMultiplier = 0.75 + Math.random() * 0.5;

    return Math.min(this.retryMaxDelayMs, Math.max(1, Math.round(boundedDelay * jitterMultiplier)));
  }
}

function normalizeClipDurationRange(
  startTime: number,
  endTime: number,
  minDurationSec: number,
  maxDurationSec: number,
  videoDurationSec: number,
): { startTime: number; endTime: number } {
  let normalizedStart = clampToRange(startTime, 0, videoDurationSec);
  let normalizedEnd = clampToRange(endTime, 0, videoDurationSec);

  if (normalizedEnd <= normalizedStart) {
    normalizedEnd = Math.min(videoDurationSec, normalizedStart + minDurationSec);
  }

  if (normalizedEnd - normalizedStart > maxDurationSec) {
    normalizedEnd = normalizedStart + maxDurationSec;
  }

  if (normalizedEnd - normalizedStart < minDurationSec) {
    const deficit = minDurationSec - (normalizedEnd - normalizedStart);
    const expandRightBy = Math.min(deficit, videoDurationSec - normalizedEnd);
    normalizedEnd += expandRightBy;

    const remainingDeficit = deficit - expandRightBy;
    if (remainingDeficit > 0) {
      normalizedStart = Math.max(0, normalizedStart - remainingDeficit);
    }
  }

  if (normalizedEnd > videoDurationSec) {
    const overflow = normalizedEnd - videoDurationSec;
    normalizedEnd = videoDurationSec;
    normalizedStart = Math.max(0, normalizedStart - overflow);
  }

  if (normalizedEnd - normalizedStart > maxDurationSec) {
    normalizedStart = Math.max(0, normalizedEnd - maxDurationSec);
  }

  if (normalizedEnd <= normalizedStart) {
    const fallbackDuration = Math.min(minDurationSec, maxDurationSec);
    normalizedEnd = Math.min(videoDurationSec, normalizedStart + fallbackDuration);
  }

  return {
    startTime: roundTimestamp(normalizedStart),
    endTime: roundTimestamp(normalizedEnd),
  };
}

function findTranscriptStartBoundary(
  segments: Transcript["segments"],
  requestedStartTime: number,
): number {
  const segmentIndex = findSegmentIndexAtTime(segments, requestedStartTime);
  if (segmentIndex < 0) {
    return requestedStartTime;
  }

  const segment = segments[segmentIndex];
  if (!segment) {
    return requestedStartTime;
  }

  const directBoundaryShift = requestedStartTime - segment.start;
  if (segmentIndex > 0 && isLikelyContinuationStart(segment.text)) {
    const previousSegmentStart = segments[segmentIndex - 1]!.start;
    const continuationBoundaryShift = requestedStartTime - previousSegmentStart;
    if (continuationBoundaryShift >= 0 && continuationBoundaryShift <= 4) {
      return previousSegmentStart;
    }
  }

  if (directBoundaryShift >= 0 && directBoundaryShift <= 2) {
    return segment.start;
  }

  return requestedStartTime;
}

function findTranscriptEndBoundary(
  segments: Transcript["segments"],
  requestedEndTime: number,
  clipStartTime: number,
  minDurationSec: number,
  maxDurationSec: number,
  videoDurationSec: number,
): number {
  const minEndTime = Math.min(videoDurationSec, clipStartTime + minDurationSec);
  const maxEndTime = Math.min(videoDurationSec, clipStartTime + maxDurationSec);

  let bestEndTime = requestedEndTime;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const segment of segments) {
    if (segment.end < minEndTime || segment.end > maxEndTime) {
      continue;
    }

    const punctuationBonus = hasStrongEndingBoundary(segment.text) ? 3 : 0;
    const forwardBonus = segment.end >= requestedEndTime ? 0.2 : 0;
    const proximityPenalty = Math.abs(segment.end - requestedEndTime);
    const score = punctuationBonus + forwardBonus - proximityPenalty;

    if (score > bestScore) {
      bestScore = score;
      bestEndTime = segment.end;
    }
  }

  return bestEndTime;
}

function findSegmentIndexAtTime(segments: Transcript["segments"], time: number): number {
  const containingIndex = segments.findIndex((segment) => time >= segment.start && time <= segment.end);
  if (containingIndex >= 0) {
    return containingIndex;
  }

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]!.start <= time) {
      return index;
    }
  }

  return segments.length > 0 ? 0 : -1;
}

function hasStrongEndingBoundary(text: string): boolean {
  return /[.!?…]["')\]]*$/.test(text.trim());
}

function isLikelyContinuationStart(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }

  const startsWithLowercaseWord = /^[a-z]/.test(trimmed);
  if (startsWithLowercaseWord) {
    return true;
  }

  return /^(and|but|so|because|or|then|to|that|which|who|when|while|if|as|for|of|the|a|an)\b/i.test(
    trimmed,
  );
}

function clampToRange(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function roundTimestamp(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function createClipModelProvider(config: Config): ClipModelProvider {
  if (config.clipIdentifierProvider === "copilot") {
    const fallbackModels =
      config.copilotModelFallbacks.length > 0
        ? config.copilotModelFallbacks
        : [...DEFAULT_COPILOT_FALLBACK_MODELS];
    return new CopilotClipModelProvider(config.copilotModel, fallbackModels);
  }

  if (config.clipIdentifierProvider === "gemini") {
    return new GeminiClipModelProvider(config.geminiApiKey);
  }

  const unsupportedProvider: never = config.clipIdentifierProvider;
  throw new Error(`Unsupported clip identifier provider: ${unsupportedProvider}`);
}

function buildOrderedModelCandidates(
  primaryModel: string,
  fallbackModels: readonly string[],
): string[] {
  const dedupedCandidates: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [
    primaryModel,
    ...fallbackModels,
    ...DEFAULT_COPILOT_FALLBACK_MODELS,
  ]) {
    const trimmedCandidate = candidate.trim();
    if (!trimmedCandidate) {
      continue;
    }

    const normalizedCandidate = trimmedCandidate.toLowerCase();
    if (seen.has(normalizedCandidate)) {
      continue;
    }

    seen.add(normalizedCandidate);
    dedupedCandidates.push(trimmedCandidate);
  }

  if (dedupedCandidates.length > 0) {
    return dedupedCandidates;
  }

  return [...DEFAULT_COPILOT_FALLBACK_MODELS];
}

function pickCheapestModel(models: readonly ModelInfo[]): ModelInfo | null {
  if (models.length === 0) {
    return null;
  }

  let bestModel: ModelInfo | null = null;
  for (const model of models) {
    if (!bestModel) {
      bestModel = model;
      continue;
    }

    const modelMultiplier = model.billing?.multiplier ?? 1;
    const bestModelMultiplier = bestModel.billing?.multiplier ?? 1;
    if (modelMultiplier < bestModelMultiplier) {
      bestModel = model;
      continue;
    }

    if (modelMultiplier === bestModelMultiplier && model.id.localeCompare(bestModel.id) < 0) {
      bestModel = model;
    }
  }

  return bestModel;
}

function parseClipResponse(
  provider: ClipIdentifierProviderName,
  responseText: string,
): ClipModelResponse {
  const normalizedText = normalizeResponseText(provider, responseText);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(normalizedText) as unknown;
  } catch (error) {
    throw new NonRetryableProviderError(
      provider,
      "json",
      `${provider} returned malformed JSON: ${stringifyError(error)}`,
    );
  }

  const parsed = clipResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");

    throw new NonRetryableProviderError(
      provider,
      "schema",
      `${provider} response failed clip schema validation: ${issueSummary}`,
    );
  }

  return parsed.data;
}

function normalizeResponseText(provider: ClipIdentifierProviderName, responseText: string): string {
  const trimmed = responseText.trim();

  if (!trimmed) {
    throw new NonRetryableProviderError(
      provider,
      "response",
      `${provider} returned an empty response body.`,
    );
  }

  const fencedJsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedJsonMatch?.[1]) {
    return fencedJsonMatch[1].trim();
  }

  return trimmed;
}

function classifyRetryability(error: unknown): RetryDecision {
  if (error instanceof NonRetryableProviderError) {
    return { retryable: false, reason: error.category };
  }

  const details = extractErrorDetails(error);
  const normalizedMessage = details.message.toLowerCase();
  const status = details.status ?? details.statusCode;

  if (status !== undefined) {
    if (retryableHttpStatuses.has(status)) {
      return { retryable: true, reason: `http-${status}` };
    }

    if (status >= 400 && status < 500) {
      return { retryable: false, reason: `http-${status}` };
    }
  }

  if (details.code && retryableNetworkErrorCodes.has(details.code.toUpperCase())) {
    return { retryable: true, reason: details.code };
  }

  if (containsAny(normalizedMessage, authErrorNeedles)) {
    return { retryable: false, reason: "auth" };
  }

  if (containsAny(normalizedMessage, subscriptionErrorNeedles)) {
    return { retryable: false, reason: "subscription" };
  }

  if (containsAny(normalizedMessage, configErrorNeedles)) {
    return { retryable: false, reason: "config" };
  }

  if (containsAny(normalizedMessage, transientErrorNeedles)) {
    return { retryable: true, reason: "transient" };
  }

  return { retryable: false, reason: "non-transient" };
}

function buildCopilotAuthError(authStatus: GetAuthStatusResponse): NonRetryableProviderError {
  const statusSuffix = authStatus.statusMessage ? ` ${authStatus.statusMessage}` : "";
  return new NonRetryableProviderError(
    "copilot",
    "auth",
    `Copilot authentication is unavailable.${statusSuffix} Run \`bun run src/index.ts github-auth-login\` (recommended) or \`copilot login\`, then retry. You can also provide COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN.`,
  );
}

function toCopilotSetupError(
  error: unknown,
  authStatus?: GetAuthStatusResponse,
): NonRetryableProviderError | null {
  if (error instanceof NonRetryableProviderError) {
    return error;
  }

  if (authStatus && !authStatus.isAuthenticated) {
    return buildCopilotAuthError(authStatus);
  }

  const normalizedMessage = stringifyError(error).toLowerCase();
  if (
    containsAny(normalizedMessage, [
      "copilot cli not found",
      "could not find @github/copilot",
      "path to copilot cli is required",
      "enoent",
    ])
  ) {
    return new NonRetryableProviderError(
      "copilot",
      "config",
      "Copilot CLI setup is incomplete. Ensure @github/copilot is installed and the CLI executable is available on PATH.",
    );
  }

  if (containsAny(normalizedMessage, subscriptionErrorNeedles)) {
    return new NonRetryableProviderError(
      "copilot",
      "subscription",
      "Copilot model access is unavailable for this account. Confirm your GitHub Copilot subscription or seat assignment, then retry.",
    );
  }

  if (containsAny(normalizedMessage, authErrorNeedles)) {
    return new NonRetryableProviderError(
      "copilot",
      "auth",
      "Copilot authentication failed. Run `bun run src/index.ts github-auth-login` (or `copilot login`) and verify Copilot access for the authenticated account.",
    );
  }

  return null;
}

function extractErrorDetails(error: unknown): {
  message: string;
  status?: number;
  statusCode?: number;
  code?: string;
} {
  if (error instanceof Error) {
    const errorWithMeta = error as Error & {
      status?: unknown;
      statusCode?: unknown;
      code?: unknown;
    };
    return {
      message: error.message,
      status: toNumber(errorWithMeta.status),
      statusCode: toNumber(errorWithMeta.statusCode),
      code: typeof errorWithMeta.code === "string" ? errorWithMeta.code : undefined,
    };
  }

  if (isRecord(error)) {
    return {
      message: toStringValue(error.message) ?? String(error),
      status: toNumber(error.status),
      statusCode: toNumber(error.statusCode),
      code: toStringValue(error.code),
    };
  }

  return { message: String(error) };
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function containsAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
