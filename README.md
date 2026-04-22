# ShortForge

Automated short-form clip extraction, editing, and publishing pipeline for YouTube content.

Built with Bun + TypeScript, with AI-based clip identification and upload workflows for YouTube Shorts, TikTok, and Instagram Reels.

---

## Fork Attribution

This repository is a **fork** of the original project:

- Original (upstream): `https://github.com/ayush-that/jiang-clips`
- Fork (this repo): `https://github.com/AadilShrestha/ShortForge`

GitHub should also show native fork linkage (`forked from ayush-that/jiang-clips`) once repository metadata syncs.

---

## What it does

- Ingests a YouTube video (or channel feed)
- Transcribes and analyzes content to find highlight-worthy segments
- Uses AI clip identification with `copilot` or `gemini` provider modes
- Supports Copilot model fallback chains (e.g., `gpt-5-mini` -> additional fallbacks)
- Generates vertical short clips
- Adds captions/effects based on configuration
- Tracks progress with checkpointing + resumable runs
- Supports interactive and scripted CLI workflows
- Supports upload/auth flows for YouTube, TikTok, and Instagram

---

## Prerequisites

- **Bun** runtime (project package manager + runner)
- **FFmpeg / ffprobe** available in your environment
- **AI provider access**:
  - GitHub Copilot access/subscription when `CLIP_IDENTIFIER_PROVIDER=copilot`
  - OR `GEMINI_API_KEY` when `CLIP_IDENTIFIER_PROVIDER=gemini`
- Upload platform credentials if using YouTube/TikTok/Instagram publishing flows

---

## Quick Start

```bash
# 1) Install dependencies
bun install

# 2) Configure env
cp .env.example .env
# then fill required values in .env

# 3) Run interactive mode (recommended for first run)
bun run interactive
```

Or run the CLI directly:

```bash
bun run src/index.ts
```

When no command is passed, the CLI opens the interactive menu.

---

## Interactive Bun Workflow

If you want a guided flow instead of memorizing commands:

```bash
# Either of these opens the interactive menu
bun run interactive
bun run src/index.ts interactive
bun run src/index.ts
```

Interactive mode includes:

- Profile selection/creation
- Queue-first run workflow
- Start/resume/list/delete runs
- Guided upload and auth actions

---

## Core CLI Commands

### Pipeline and processing

```bash
# Single video pipeline
bun run src/index.ts pipeline <youtube-url>

# Continuous live clipping
bun run src/index.ts live <youtube-live-url> [--poll-seconds 20 --window-seconds 240]

# Batch channel processing
bun run src/index.ts batch <channel-url> [--limit 10] [--skip-existing]

# Resume interrupted pipeline run
bun run src/index.ts resume <run-id>

# Inspect run status
bun run src/index.ts status [run-id]

# Clean intermediate artifacts
bun run src/index.ts clean <run-id> [--all]

# Run using saved profile defaults
bun run src/index.ts pipeline-profile [profile-id] [--url <url>]
```

### Profile management

```bash
bun run src/index.ts profiles list
bun run src/index.ts profiles show [profile-id]
bun run src/index.ts profiles add <profile-id>
bun run src/index.ts profiles update <profile-id>
bun run src/index.ts profiles use <profile-id>
bun run src/index.ts profiles remove <profile-id>
```

### Queue-style run management

```bash
bun run src/index.ts runs create --profile <profile-id> [--url <url>]
bun run src/index.ts runs list [--profile <profile-id>] [--status pending|running|failed|completed|uploading|uploaded]
bun run src/index.ts runs show <run-id>
bun run src/index.ts runs start <run-id>
bun run src/index.ts runs start-selected <run-id> <run-id> ...
bun run src/index.ts runs start-all [--profile <profile-id>]
bun run src/index.ts runs resume <run-id>
bun run src/index.ts runs delete <run-id> [--delete-artifacts] [--delete-final-output]

# Upload clips for a run
bun run src/index.ts runs upload <run-id> [--platform youtube|tiktok|instagram|all]
```

### Auth and platform uploads

```bash
# GitHub Copilot auth (for clip identifier provider=copilot)
bun run src/index.ts github-auth-login
bun run src/index.ts github-auth-status

# YouTube OAuth + upload
bun run src/index.ts youtube-auth-url
bun run src/index.ts youtube-auth-exchange <code>
bun run src/index.ts youtube-auth-reauth
bun run src/index.ts upload-shorts [--dir ./output]

# TikTok OAuth + upload
bun run src/index.ts tiktok-auth-url
bun run src/index.ts tiktok-auth-exchange <code>
bun run src/index.ts upload-tiktok [--dir ./output]

# Instagram OAuth + upload
bun run src/index.ts instagram-auth-url
bun run src/index.ts instagram-auth-exchange <code>
bun run src/index.ts upload-instagram-reels [--dir ./output]
```

### Upload Automation Status
- YouTube: upload automation is available now (OAuth + bulk upload commands and run-level upload workflow).
- TikTok: upload/auth flows are available, with deeper end-to-end automation planned next.
- Instagram: upload/auth flows are available, with deeper end-to-end automation planned next.


---

## Environment Configuration

Create `.env` from `.env.example` and set the values for your setup.

### Key pipeline variables

- `CLIP_IDENTIFIER_PROVIDER` = `copilot` | `gemini`
- `GEMINI_API_KEY` (required when provider is `gemini`)
- `COPILOT_MODEL`, `COPILOT_MODEL_FALLBACKS`, `COPILOT_SINGLE_REQUEST_MODE`
- `CLIP_IDENTIFIER_RETRY_ATTEMPTS`, `CLIP_IDENTIFIER_RETRY_BASE_DELAY_MS`, `CLIP_IDENTIFIER_RETRY_MAX_DELAY_MS`
- `WHISPER_MODEL` = `tiny|base|small|medium|large`
- `MAX_PARALLEL_CLIPS`
- `SILENCE_THRESHOLD_DB`, `SILENCE_MIN_DURATION`
- `CLIP_MIN_DURATION_SEC`, `CLIP_MAX_DURATION_SEC`
- `OUTPUT_WIDTH`, `OUTPUT_HEIGHT`
- `PREFER_YOUTUBE_TRANSCRIPTS`, `CAPTION_ANIMATE`

### Upload/OAuth variables

- YouTube: `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`, `YOUTUBE_OAUTH_FILE`
- TikTok: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`, `TIKTOK_OAUTH_FILE`
- Instagram: `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET`, `INSTAGRAM_REDIRECT_URI`, `INSTAGRAM_OAUTH_FILE`, `INSTAGRAM_IG_USER_ID`

See `.env.example` for the full list.

---

## Scripts

```bash
# Main scripts
bun run start
bun run interactive
bun run pipeline
bun run batch
bun run resume
bun run status
bun run clean
bun run profiles

# Quality checks
bun test
bun run test:unit
bun run test:e2e
bun run lint
bun run format
bun run format:check
```

---

## Output and Data Layout

Default paths (from config):

- Data/checkpoints: `./data`
- Rendered outputs: `./output`
- Assets: `./assets`
- Checkpoint DB: `./data/checkpoints.db`

---

## Project Structure

```text
src/
├── index.ts               # CLI entry
├── config.ts              # env + schema validation
├── cli/                   # interactive menu, run/profile services
├── modules/               # downloader/transcriber/clip/upload modules
├── pipeline/              # orchestrator + checkpointing
├── remotion/              # rendering types/templates
└── utils/                 # fs/logger/ffmpeg helpers

tests/
├── cli/
├── modules/
├── pipeline/
└── utils/
```

---

## Development Notes

- Runtime: Bun
- Language: TypeScript (strict)
- Lint: oxlint
- Format: oxfmt

---

## License

Add your license details here.

If the upstream fork has a required license notice, keep that attribution intact in this section.
