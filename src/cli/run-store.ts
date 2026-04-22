import { Database, type SQLQueryBindings } from "bun:sqlite";

const cliRunStatusValues = [
  "pending",
  "running",
  "failed",
  "completed",
  "uploading",
  "uploaded",
] as const;
const uploadPlatformValues = ["youtube", "tiktok", "instagram"] as const;
const cliRunUploadStatusValues = ["pending", "uploading", "uploaded", "failed"] as const;

const cliRunStatusSet = new Set<string>(cliRunStatusValues);
const uploadPlatformSet = new Set<string>(uploadPlatformValues);
const cliRunUploadStatusSet = new Set<string>(cliRunUploadStatusValues);

export type CliRunStatus = (typeof cliRunStatusValues)[number];
export type UploadPlatform = (typeof uploadPlatformValues)[number];
export type CliRunUploadStatus = (typeof cliRunUploadStatusValues)[number];

export interface CliRun {
  id: string;
  profileId: string;
  status: CliRunStatus;
  sourceUrl: string | null;
  pipelineRunId: string | null;
  outputDir: string | null;
  displayTitle: string | null;
  templateSnapshot: unknown | null;
  payloadSnapshot: unknown | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CliRunUpload {
  id: number;
  runId: string;
  platform: UploadPlatform;
  clipPath: string;
  status: CliRunUploadStatus;
  externalUploadId: string | null;
  uploadedUrl: string | null;
  lastError: string | null;
  payload: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface CliRunEvent {
  id: number;
  runId: string;
  eventType: string;
  message: string | null;
  payload: unknown | null;
  createdAt: string;
}

export interface CreateCliRunInput {
  id?: string;
  profileId: string;
  sourceUrl?: string | null;
  status?: CliRunStatus;
  pipelineRunId?: string | null;
  outputDir?: string | null;
  displayTitle?: string | null;
  templateSnapshot?: unknown | null;
  payloadSnapshot?: unknown | null;
  lastError?: string | null;
}

export interface ListCliRunsFilter {
  profileId?: string;
  status?: CliRunStatus;
  statuses?: ReadonlyArray<CliRunStatus>;
}

export interface UpdateCliRunInput {
  status?: CliRunStatus;
  sourceUrl?: string | null;
  pipelineRunId?: string | null;
  outputDir?: string | null;
  displayTitle?: string | null;
  templateSnapshot?: unknown | null;
  payloadSnapshot?: unknown | null;
  lastError?: string | null;
}

export interface RecordCliRunEventInput {
  runId: string;
  eventType: string;
  message?: string | null;
  payload?: unknown | null;
}

export interface UpsertCliRunUploadInput {
  runId: string;
  platform: UploadPlatform;
  clipPath: string;
  status: CliRunUploadStatus;
  externalUploadId?: string | null;
  uploadedUrl?: string | null;
  lastError?: string | null;
  payload?: unknown | null;
}

interface CliRunRow {
  id: string;
  profile_id: string;
  status: string;
  source_url: string | null;
  pipeline_run_id: string | null;
  output_dir: string | null;
  display_title: string | null;
  template_snapshot: string | null;
  payload_snapshot: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface CliRunUploadRow {
  id: number;
  run_id: string;
  platform: string;
  clip_path: string;
  status: string;
  external_upload_id: string | null;
  uploaded_url: string | null;
  last_error: string | null;
  payload: string | null;
  created_at: string;
  updated_at: string;
}

interface CliRunEventRow {
  id: number;
  run_id: string;
  event_type: string;
  message: string | null;
  payload: string | null;
  created_at: string;
}

export class CliRunStore {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  createRun(input: CreateCliRunInput): CliRun {
    const runId =
      input.id === undefined ? crypto.randomUUID() : normalizeRequiredText(input.id, "id");
    const profileId = normalizeRequiredText(input.profileId, "profileId");
    const status = parseCliRunStatus(input.status ?? "pending", "status");
    const sourceUrl = normalizeOptionalText(input.sourceUrl);
    const pipelineRunId = normalizeOptionalText(input.pipelineRunId);
    const outputDir = normalizeOptionalText(input.outputDir);
    const displayTitle = normalizeOptionalText(input.displayTitle);
    const lastError = normalizeOptionalText(input.lastError);
    const templateSnapshot = serializeJson(input.templateSnapshot);
    const payloadSnapshot = serializeJson(input.payloadSnapshot);
    const now = new Date().toISOString();

    try {
      this.db
        .prepare<
          unknown,
          [
            string,
            string,
            CliRunStatus,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string,
            string,
          ]
        >(
          `INSERT INTO cli_runs (
            id,
            profile_id,
            status,
            source_url,
            pipeline_run_id,
            output_dir,
            display_title,
            template_snapshot,
            payload_snapshot,
            last_error,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          profileId,
          status,
          sourceUrl,
          pipelineRunId,
          outputDir,
          displayTitle,
          templateSnapshot,
          payloadSnapshot,
          lastError,
          now,
          now,
        );
    } catch (error) {
      const sqliteCode = getSqliteErrorCode(error);
      if (
        sqliteCode === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        sqliteCode === "SQLITE_CONSTRAINT_UNIQUE"
      ) {
        throw new Error(`Run already exists: ${runId}`);
      }
      throw error;
    }

    const created = this.getRunById(runId);
    if (!created) {
      throw new Error(`Created run was not found: ${runId}`);
    }

    return created;
  }

  listRuns(filter: ListCliRunsFilter = {}): CliRun[] {
    if (filter.status && filter.statuses) {
      throw new Error("Provide either status or statuses filter, not both.");
    }

    if (filter.statuses && filter.statuses.length === 0) {
      return [];
    }

    const where: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (filter.profileId !== undefined) {
      where.push("profile_id = ?");
      params.push(normalizeRequiredText(filter.profileId, "profileId"));
    }

    if (filter.status !== undefined) {
      where.push("status = ?");
      params.push(parseCliRunStatus(filter.status, "status"));
    }

    if (filter.statuses !== undefined) {
      const statuses = filter.statuses.map((status) => parseCliRunStatus(status, "statuses"));
      const placeholders = statuses.map(() => "?").join(", ");
      where.push(`status IN (${placeholders})`);
      params.push(...statuses);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare<CliRunRow, SQLQueryBindings[]>(
        `SELECT * FROM cli_runs ${whereClause} ORDER BY created_at DESC, id DESC`,
      )
      .all(...params);

    return rows.map((row) => toCliRun(row));
  }

  getRunById(runId: string): CliRun | null {
    const normalizedRunId = normalizeRequiredText(runId, "runId");
    const row = this.db
      .prepare<CliRunRow, [string]>("SELECT * FROM cli_runs WHERE id = ?")
      .get(normalizedRunId);
    if (!row) {
      return null;
    }

    return toCliRun(row);
  }

  updateRun(runId: string, patch: UpdateCliRunInput): CliRun {
    const normalizedRunId = normalizeRequiredText(runId, "runId");
    const setClauses: string[] = [];
    const params: SQLQueryBindings[] = [];

    if (patch.status !== undefined) {
      setClauses.push("status = ?");
      params.push(parseCliRunStatus(patch.status, "status"));
    }

    if (patch.sourceUrl !== undefined) {
      setClauses.push("source_url = ?");
      params.push(normalizeOptionalText(patch.sourceUrl));
    }

    if (patch.pipelineRunId !== undefined) {
      setClauses.push("pipeline_run_id = ?");
      params.push(normalizeOptionalText(patch.pipelineRunId));
    }

    if (patch.outputDir !== undefined) {
      setClauses.push("output_dir = ?");
      params.push(normalizeOptionalText(patch.outputDir));
    }

    if (patch.displayTitle !== undefined) {
      setClauses.push("display_title = ?");
      params.push(normalizeOptionalText(patch.displayTitle));
    }

    if (patch.templateSnapshot !== undefined) {
      setClauses.push("template_snapshot = ?");
      params.push(serializeJson(patch.templateSnapshot));
    }

    if (patch.payloadSnapshot !== undefined) {
      setClauses.push("payload_snapshot = ?");
      params.push(serializeJson(patch.payloadSnapshot));
    }

    if (patch.lastError !== undefined) {
      setClauses.push("last_error = ?");
      params.push(normalizeOptionalText(patch.lastError));
    }

    if (setClauses.length === 0) {
      throw new Error("No run fields were provided for update.");
    }

    setClauses.push("updated_at = ?");
    params.push(new Date().toISOString());
    params.push(normalizedRunId);

    const result = this.db
      .prepare<unknown, SQLQueryBindings[]>(
        `UPDATE cli_runs SET ${setClauses.join(", ")} WHERE id = ?`,
      )
      .run(...params);

    if (result.changes === 0) {
      throw new Error(`Run not found: ${normalizedRunId}`);
    }

    const updated = this.getRunById(normalizedRunId);
    if (!updated) {
      throw new Error(`Updated run was not found: ${normalizedRunId}`);
    }

    return updated;
  }

  deleteRunById(runId: string): boolean {
    const normalizedRunId = normalizeRequiredText(runId, "runId");
    const result = this.db
      .prepare<unknown, [string]>("DELETE FROM cli_runs WHERE id = ?")
      .run(normalizedRunId);
    return result.changes > 0;
  }

  recordEvent(input: RecordCliRunEventInput): CliRunEvent {
    const runId = normalizeRequiredText(input.runId, "runId");
    const eventType = normalizeRequiredText(input.eventType, "eventType");
    const message = normalizeOptionalText(input.message);
    const payload = serializeJson(input.payload);
    const createdAt = new Date().toISOString();

    try {
      const result = this.db
        .prepare<unknown, [string, string, string | null, string | null, string]>(
          `INSERT INTO cli_run_events (run_id, event_type, message, payload, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(runId, eventType, message, payload, createdAt);

      return {
        id: Number(result.lastInsertRowid),
        runId,
        eventType,
        message,
        payload: deserializeJson(payload, "cli_run_events.payload"),
        createdAt,
      };
    } catch (error) {
      if (getSqliteErrorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new Error(`Run not found: ${runId}`);
      }
      throw error;
    }
  }

  listEventsForRun(runId: string): CliRunEvent[] {
    const normalizedRunId = normalizeRequiredText(runId, "runId");
    const rows = this.db
      .prepare<CliRunEventRow, [string]>(
        "SELECT * FROM cli_run_events WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(normalizedRunId);

    return rows.map((row) => toCliRunEvent(row));
  }

  upsertUpload(input: UpsertCliRunUploadInput): CliRunUpload {
    const runId = normalizeRequiredText(input.runId, "runId");
    const platform = parseUploadPlatform(input.platform, "platform");
    const clipPath = normalizeRequiredText(input.clipPath, "clipPath");
    const status = parseCliRunUploadStatus(input.status, "status");
    const externalUploadId = normalizeOptionalText(input.externalUploadId);
    const uploadedUrl = normalizeOptionalText(input.uploadedUrl);
    const lastError = normalizeOptionalText(input.lastError);
    const payload = serializeJson(input.payload);
    const now = new Date().toISOString();

    try {
      this.db
        .prepare<
          unknown,
          [
            string,
            UploadPlatform,
            string,
            CliRunUploadStatus,
            string | null,
            string | null,
            string | null,
            string | null,
            string,
            string,
          ]
        >(
          `INSERT INTO cli_run_uploads (
            run_id,
            platform,
            clip_path,
            status,
            external_upload_id,
            uploaded_url,
            last_error,
            payload,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, platform, clip_path) DO UPDATE SET
            status = excluded.status,
            external_upload_id = excluded.external_upload_id,
            uploaded_url = excluded.uploaded_url,
            last_error = excluded.last_error,
            payload = excluded.payload,
            updated_at = excluded.updated_at`,
        )
        .run(
          runId,
          platform,
          clipPath,
          status,
          externalUploadId,
          uploadedUrl,
          lastError,
          payload,
          now,
          now,
        );
    } catch (error) {
      if (getSqliteErrorCode(error) === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        throw new Error(`Run not found: ${runId}`);
      }
      throw error;
    }

    const row = this.db
      .prepare<CliRunUploadRow, [string, UploadPlatform, string]>(
        "SELECT * FROM cli_run_uploads WHERE run_id = ? AND platform = ? AND clip_path = ?",
      )
      .get(runId, platform, clipPath);

    if (!row) {
      throw new Error(
        `Upload row was not found after upsert for run ${runId}, platform ${platform}, clip ${clipPath}.`,
      );
    }

    return toCliRunUpload(row);
  }

  listUploadsForRun(runId: string): CliRunUpload[] {
    const normalizedRunId = normalizeRequiredText(runId, "runId");
    const rows = this.db
      .prepare<CliRunUploadRow, [string]>(
        "SELECT * FROM cli_run_uploads WHERE run_id = ? ORDER BY created_at ASC, id ASC",
      )
      .all(normalizedRunId);

    return rows.map((row) => toCliRunUpload(row));
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cli_runs (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        status TEXT NOT NULL,
        source_url TEXT,
        pipeline_run_id TEXT,
        output_dir TEXT,
        display_title TEXT,
        template_snapshot TEXT,
        payload_snapshot TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_cli_runs_profile_id ON cli_runs (profile_id);
      CREATE INDEX IF NOT EXISTS idx_cli_runs_status ON cli_runs (status);
      CREATE INDEX IF NOT EXISTS idx_cli_runs_created_at ON cli_runs (created_at DESC);

      CREATE TABLE IF NOT EXISTS cli_run_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        clip_path TEXT NOT NULL,
        status TEXT NOT NULL,
        external_upload_id TEXT,
        uploaded_url TEXT,
        last_error TEXT,
        payload TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES cli_runs(id) ON DELETE CASCADE,
        UNIQUE (run_id, platform, clip_path)
      );

      CREATE INDEX IF NOT EXISTS idx_cli_run_uploads_run_id ON cli_run_uploads (run_id);
      CREATE INDEX IF NOT EXISTS idx_cli_run_uploads_status ON cli_run_uploads (status);

      CREATE TABLE IF NOT EXISTS cli_run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        message TEXT,
        payload TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES cli_runs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_cli_run_events_run_id ON cli_run_events (run_id);
      CREATE INDEX IF NOT EXISTS idx_cli_run_events_created_at ON cli_run_events (created_at);
    `);
  }
}

function toCliRun(row: CliRunRow): CliRun {
  return {
    id: row.id,
    profileId: row.profile_id,
    status: parseCliRunStatus(row.status, "cli_runs.status"),
    sourceUrl: row.source_url,
    pipelineRunId: row.pipeline_run_id,
    outputDir: row.output_dir,
    displayTitle: row.display_title,
    templateSnapshot: deserializeJson(row.template_snapshot, "cli_runs.template_snapshot"),
    payloadSnapshot: deserializeJson(row.payload_snapshot, "cli_runs.payload_snapshot"),
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCliRunUpload(row: CliRunUploadRow): CliRunUpload {
  return {
    id: row.id,
    runId: row.run_id,
    platform: parseUploadPlatform(row.platform, "cli_run_uploads.platform"),
    clipPath: row.clip_path,
    status: parseCliRunUploadStatus(row.status, "cli_run_uploads.status"),
    externalUploadId: row.external_upload_id,
    uploadedUrl: row.uploaded_url,
    lastError: row.last_error,
    payload: deserializeJson(row.payload, "cli_run_uploads.payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCliRunEvent(row: CliRunEventRow): CliRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    eventType: row.event_type,
    message: row.message,
    payload: deserializeJson(row.payload, "cli_run_events.payload"),
    createdAt: row.created_at,
  };
}

function parseCliRunStatus(value: string, fieldName: string): CliRunStatus {
  const normalized = normalizeRequiredText(value, fieldName);
  if (cliRunStatusSet.has(normalized)) {
    return normalized as CliRunStatus;
  }

  throw new Error(`Invalid ${fieldName}: ${value}.`);
}

function parseUploadPlatform(value: string, fieldName: string): UploadPlatform {
  const normalized = normalizeRequiredText(value, fieldName);
  if (uploadPlatformSet.has(normalized)) {
    return normalized as UploadPlatform;
  }

  throw new Error(`Invalid ${fieldName}: ${value}.`);
}

function parseCliRunUploadStatus(value: string, fieldName: string): CliRunUploadStatus {
  const normalized = normalizeRequiredText(value, fieldName);
  if (cliRunUploadStatusSet.has(normalized)) {
    return normalized as CliRunUploadStatus;
  }

  throw new Error(`Invalid ${fieldName}: ${value}.`);
}

function normalizeRequiredText(value: string | null | undefined, fieldName: string): string {
  if (typeof value !== "string") {
    throw new Error(`${fieldName} is required.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }

  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

function deserializeJson<T>(value: string | null, fieldName: string): T | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`Invalid JSON payload in ${fieldName}.`);
  }
}

function getSqliteErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
