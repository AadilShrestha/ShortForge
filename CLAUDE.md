# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Automated short-form clip extraction pipeline ("Reel Farmer") that converts long-form YouTube videos into vertical TikTok/Shorts clips using AI-powered segment identification, silence removal, and animated caption overlays.

## Commands

```bash
# Run pipeline
bun run src/index.ts pipeline <youtube-url>
bun run src/index.ts batch <channel-url> -l 10 [--skip-existing]
bun run src/index.ts resume <run-id>
bun run src/index.ts status [run-id]
bun run src/index.ts clean <run-id> [--all]

# Tests
bun test                              # all tests
bun test tests/utils/fs.test.ts       # single file
bun test tests/utils                  # directory
bun test --reporter=verbose tests/    # verbose

# Lint & format
oxlint                                # lint
oxfmt --write src tests               # format
oxfmt --check src tests               # check only
```

## Tech Stack

- **Runtime**: Bun (not Node.js) — uses `bun:sqlite`, `bun:test`, `Bun.spawn`, `Bun.env`, `Bun.file`, `Bun.write`
- **Language**: TypeScript (strict mode, ESNext, bundler module resolution)
- **Path alias**: `@/*` → `./src/*`
- **External CLI tools**: yt-dlp, ffmpeg/ffprobe, whisper-cli (C++ whisper.cpp)
- **AI**: Google Gemini 2.5 Flash via `@google/genai` (structured JSON output with schema)
- **Video rendering**: Remotion (React-based, bundles via webpack, renders to VP9 WebM with alpha)
- **Config**: Zod schema validating `Bun.env` vars (see `src/config.ts`). Requires `GEMINI_API_KEY`.

## Architecture

### Pipeline stages

The pipeline has two phases defined in `src/pipeline/types.ts`:

**Global stages** (sequential, once per video):
1. `DOWNLOAD` — yt-dlp downloads video + metadata
2. `TRANSCRIBE` — YouTube transcript API or Whisper for word-level timestamps
3. `IDENTIFY_CLIPS` — Gemini analyzes transcript, returns `ClipCandidate[]` with timestamps and viral scores

**Clip stages** (parallel per clip, controlled by `Semaphore` in orchestrator):
4. `EXTRACT_CLIPS` — FFmpeg extracts clip segment from source video
5. `REMOVE_SILENCE` — FFmpeg detects and removes silent sections
6. `GENERATE_CAPTIONS` — whisper-cli generates word timestamps, Remotion renders transparent caption overlay (WebM)
7. `COMPOSE_REEL` — FFmpeg composites source clip + caption overlay into final 1080x1920 MP4

### Checkpoint system

`CheckpointManager` (`src/pipeline/checkpoint.ts`) persists all progress to SQLite (WAL mode) across three tables: `pipeline_runs`, `stage_results`, `clip_progress`. This enables resumption via `resume <run-id>` — the orchestrator skips completed global stages and only processes incomplete clips.

### Caption rendering flow

`CaptionGenerator` bundles the Remotion project once (cached in a module-level `bundlePromise`), then for each clip: extracts audio → runs whisper-cli for word-level timestamps → groups words (6 per group) → renders transparent WebM overlay via `@remotion/renderer`. The React component is at `src/remotion/CaptionOverlay.tsx`.

### Data flow

- `./data/runs/<run-id>/` — intermediate files (downloads, transcripts, extracted clips, desilenced clips, caption overlays)
- `./output/<video-id>/` — final reel MP4s
- `./data/checkpoints.db` — SQLite checkpoint database
- `./models/` — Whisper GGML model binaries

## Code Conventions

- Files: kebab-case. Classes/Types: PascalCase. Functions/vars: camelCase. Enums: PascalCase with UPPER_SNAKE values.
- Explicit return types on all functions.
- `unknown` over `any` for error handling.
- Use `createLogger("module-name")` for logging (levels: debug, info, warn, error).
- Imports ordered: external packages → internal modules → type imports (using `import type`).
- Subprocess execution via `Bun.spawn` with stdout/stderr piped and exit code checks.
