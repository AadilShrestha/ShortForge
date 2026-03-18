# jiang-clips

Automated short-form clip extraction pipeline for YouTube videos using AI.

## Prerequisites

- **Runtime**: Bun
- **FFmpeg**: Required for video processing
- **Google Gemini API Key**: Required for AI content generation

## Setup

```bash
# Install dependencies
bun install

# Set environment variables
export GEMINI_API_KEY="your-api-key"
```

## Usage

```bash
# Run the pipeline on a single video
bun run src/index.ts pipeline <youtube-url>

# Batch process a channel
bun run src/index.ts batch <channel-url>

# Resume a previous run
bun run src/index.ts resume <run-id>

# Check status
bun run src/index.ts status [run-id]

# Clean up a run
bun run src/index.ts clean <run-id>
```

## Configuration

Environment variables (all optional with defaults):

| Variable | Default | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | (required) | Google Gemini API key |
| `WHISPER_MODEL` | `base` | Whisper model size (tiny\|base\|small\|medium\|large) |
| `MAX_PARALLEL_CLIPS` | `3` | Max parallel clip processing (1-10) |
| `SILENCE_THRESHOLD_DB` | `-35` | Silence detection threshold |
| `OUTPUT_WIDTH` | `1080` | Output video width |
| `OUTPUT_HEIGHT` | `1920` | Output video height |

## Testing

```bash
bun test                     # All tests
bun test tests/utils         # Single test directory
bun test tests/utils/fs.test.ts  # Single test file
```

## Linting & Formatting

```bash
oxlint                       # Lint src/ and tests/
oxfmt --write src tests      # Format and write changes
oxfmt --check src tests      # Check formatting without writing
```

## Project Structure

```
src/
├── index.ts          # CLI entry point
├── config.ts         # Configuration schema
├── pipeline/         # Pipeline orchestration
├── modules/          # Processing modules
├── utils/            # Utilities
└── remotion/         # Video rendering

tests/
├── pipeline/
├── modules/
└── utils/
```
