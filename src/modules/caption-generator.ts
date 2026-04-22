import { createLogger } from "../utils/logger";
import { getVideoDuration, runFfmpeg } from "../utils/ffmpeg";
import { ensureDir } from "../utils/fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { dirname, resolve, join } from "path";
import type { Config } from "../config";
import type { CaptionWord, CaptionGroup, CaptionOverlayProps } from "../remotion/types";

const log = createLogger("captions");
const FPS = 30;
const WORDS_PER_GROUP = 4;
const WHISPER_CLI = "whisper-cli";
const LOCAL_WHISPER_CLI_CMD = resolve(__dirname, "../../whisper-cli.cmd");
const MODELS_DIR = resolve(__dirname, "../../models");

let bundlePromise: Promise<string> | null = null;

interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export class CaptionGenerator {
  async warmup(): Promise<void> {
    await this.ensureBundle();
  }

  private async ensureBundle(): Promise<string> {
    if (!bundlePromise) {
      log.info("Bundling Remotion project...");
      bundlePromise = bundle({
        entryPoint: resolve(__dirname, "../remotion/index.tsx"),
        webpackOverride: (config) => config,
      });
      const location = await bundlePromise;
      log.info(`Remotion bundle ready: ${location}`);
    }
    return bundlePromise;
  }

  async generate(desilencedClipPath: string, outputPath: string, config: Config): Promise<string> {
    const serveUrl = await this.ensureBundle();
    const clipDuration = await getVideoDuration(desilencedClipPath);
    const speed = config.clipSpeed;

    const workDir = dirname(outputPath);
    const whisperWords = await this.whisperWordTimestamps(desilencedClipPath, config, workDir);
    log.info(`Whisper extracted ${whisperWords.length} words`);

    const scaled = whisperWords.map((w) => ({
      text: w.word,
      start: w.start / speed,
      end: w.end / speed,
    }));

    const framed: CaptionWord[] = scaled.map((w) => ({
      text: w.text,
      startFrame: Math.round(w.start * FPS),
      endFrame: Math.round(w.end * FPS),
    }));

    const groups = this.groupWords(framed);
    const postSpeedDuration = clipDuration / speed;
    const durationInFrames = Math.ceil(postSpeedDuration * FPS);
    const width = config.outputWidth;
    const height = config.outputHeight;

    const inputProps: CaptionOverlayProps = {
      groups,
      width,
      height,
      fps: FPS,
      durationInFrames,
    };

    ensureDir(dirname(outputPath));

    log.info(`Rendering caption overlay (${groups.length} groups, ${durationInFrames} frames)...`);

    const composition = await selectComposition({
      serveUrl,
      id: "CaptionOverlay",
      inputProps,
    });

    let lastLoggedPct = -1;
    await renderMedia({
      composition,
      serveUrl,
      codec: "vp9",
      imageFormat: "png",
      pixelFormat: "yuva420p",
      outputLocation: outputPath,
      inputProps,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct >= lastLoggedPct + 10) {
          lastLoggedPct = pct;
          log.info(`Caption render: ${pct}%`);
        }
      },
    });

    log.info(`Caption overlay rendered: ${outputPath}`);
    return outputPath;
  }

  private async whisperWordTimestamps(
    videoPath: string,
    config: Config,
    workDir: string,
  ): Promise<WhisperWord[]> {
    const modelPath = join(MODELS_DIR, `ggml-${config.whisperModel}.bin`);
    const tempId = crypto.randomUUID();
    const wavPath = join(workDir, `caption_audio_${tempId}.wav`);
    const jsonBase = join(workDir, `caption_words_${tempId}`);
    const whisperCommand =
      process.platform === "win32" && (await Bun.file(LOCAL_WHISPER_CLI_CMD).exists())
        ? LOCAL_WHISPER_CLI_CMD
        : WHISPER_CLI;

    log.info(`Running whisper-cli word-level transcription (model: ${config.whisperModel})...`);
    log.debug(`Whisper command: ${whisperCommand}`);

    await runFfmpeg(["-i", videoPath, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", wavPath]);

    const proc = Bun.spawn(
      [
        whisperCommand,
        "-m",
        modelPath,
        "-f",
        wavPath,
        "-l",
        "en",
        "-oj",
        "--output-json-full",
        "-of",
        jsonBase,
        "-np",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      throw new Error(`whisper-cli failed: ${stderr}`);
    }

    const jsonPath = `${jsonBase}.json`;
    const json = await Bun.file(jsonPath).json();
    const words: WhisperWord[] = [];

    for (const segment of json.transcription) {
      for (const token of segment.tokens) {
        const text = token.text.trim();
        if (!text || text.startsWith("[")) continue;
        if ((/^[,.\?!;:]$/.test(text) || text.startsWith("'")) && words.length > 0) {
          words[words.length - 1].word += text;
          words[words.length - 1].end = token.offsets.to / 1000;
        } else {
          words.push({
            word: text,
            start: token.offsets.from / 1000,
            end: token.offsets.to / 1000,
          });
        }
      }
    }

    return words;
  }

  private groupWords(words: CaptionWord[]): CaptionGroup[] {
    const groups: CaptionGroup[] = [];

    for (let i = 0; i < words.length; i += WORDS_PER_GROUP) {
      const chunk = words.slice(i, i + WORDS_PER_GROUP);
      groups.push({
        words: chunk,
        startFrame: chunk[0].startFrame,
        endFrame: chunk[chunk.length - 1].endFrame,
      });
    }

    return groups;
  }
}
