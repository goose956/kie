import { DatabaseSync } from "node:sqlite";
import path from "path";
import fs from "fs";

const DB_DIR =
  process.env.MEDIA_ROOT ??
  "C:\\Users\\User\\Desktop\\mission contol\\outputs\\kie-studio";

fs.mkdirSync(DB_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DB_DIR, "studio.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title      TEXT NOT NULL DEFAULT 'New conversation',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL CHECK(role IN ('user','assistant')),
    text            TEXT,
    media_type      TEXT,
    media_filename  TEXT,
    media_subtype   TEXT,
    job_id          TEXT,
    job_type        TEXT,
    status          TEXT NOT NULL DEFAULT 'done',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS productions (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title                  TEXT NOT NULL DEFAULT 'Untitled production',
    status                 TEXT NOT NULL DEFAULT 'draft',
    music_filename         TEXT,
    product_image_filename TEXT,
    product_image_url      TEXT,
    hero_ref_filename      TEXT,
    hero_ref_url           TEXT,
    style                  TEXT,
    platform               TEXT,
    aspect_ratio           TEXT NOT NULL DEFAULT '16:9',
    final_video_filename   TEXT,
    error                  TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS production_shots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    production_id     INTEGER NOT NULL REFERENCES productions(id) ON DELETE CASCADE,
    shot_number       INTEGER NOT NULL,
    description       TEXT,
    image_prompt      TEXT,
    video_prompt      TEXT,
    camera_shot       TEXT,
    duration_hint     TEXT,
    status            TEXT NOT NULL DEFAULT 'pending',
    keyframe_filename TEXT,
    keyframe_task_id  TEXT,
    keyframe_url      TEXT,
    video_filename    TEXT,
    video_task_id     TEXT,
    error             TEXT,
    take_count        INTEGER NOT NULL DEFAULT 0,
    label_visible     INTEGER NOT NULL DEFAULT 1,
    is_still          INTEGER NOT NULL DEFAULT 0,
    ref_shot          INTEGER,
    use_character     INTEGER NOT NULL DEFAULT 1,
    bg_asset_id       INTEGER
  );

  CREATE TABLE IF NOT EXISTS library_assets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    name       TEXT NOT NULL,
    filename   TEXT,
    url        TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrations for existing DBs
try { db.exec("ALTER TABLE conversations ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN character_image TEXT"); } catch {}
try { db.exec("ALTER TABLE projects ADD COLUMN character_image_url TEXT"); } catch {}
// Persisted kie CDN url for the keyframe, so it can be re-used as a publicly-fetchable
// reference on video retries (the local /api/media path is not reachable by kie's servers).
try { db.exec("ALTER TABLE production_shots ADD COLUMN keyframe_url TEXT"); } catch {}
// Hero reference: a generated still (kie CDN url, publicly fetchable) fed into every keyframe
// so the product stays visually consistent across shots.
try { db.exec("ALTER TABLE productions ADD COLUMN hero_ref_filename TEXT"); } catch {}
try { db.exec("ALTER TABLE productions ADD COLUMN hero_ref_url TEXT"); } catch {}
// Still/freeze shots: hold the keyframe for the shot's duration instead of animating with Veo.
try { db.exec("ALTER TABLE production_shots ADD COLUMN is_still INTEGER NOT NULL DEFAULT 0"); } catch {}
// Scene continuity: carry an earlier shot's keyframe in as a reference (shot_number).
try { db.exec("ALTER TABLE production_shots ADD COLUMN ref_shot INTEGER"); } catch {}
// Per-shot reference control (keep the reference set small to avoid dilution).
try { db.exec("ALTER TABLE production_shots ADD COLUMN use_character INTEGER NOT NULL DEFAULT 1"); } catch {}
try { db.exec("ALTER TABLE production_shots ADD COLUMN bg_asset_id INTEGER"); } catch {}
// Global rendering style appended to every shot prompt (e.g. "claymation stop-motion") so the
// medium/look stays uniform across shots instead of flipping (clay in one shot, photoreal in the next).
try { db.exec("ALTER TABLE productions ADD COLUMN style TEXT"); } catch {}
// Uploaded product photo's kie CDN url (fetchable) — so a real client's product can be a reference.
try { db.exec("ALTER TABLE productions ADD COLUMN product_image_url TEXT"); } catch {}
// Target platform + aspect ratio (drives keyframe + Veo aspect through the whole pipeline).
try { db.exec("ALTER TABLE productions ADD COLUMN platform TEXT"); } catch {}
try { db.exec("ALTER TABLE productions ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '16:9'"); } catch {}
// Style reference image: a kie-uploaded image that sets the visual tone (passed to every keyframe).
try { db.exec("ALTER TABLE productions ADD COLUMN style_ref_url TEXT"); } catch {}
// Content style ("polished" | "ugc") persisted from Ad Pack generation — read later (e.g. by the
// character-reference generator) to decide a turnaround sheet (polished) vs single pose (UGC).
try { db.exec("ALTER TABLE productions ADD COLUMN content_style TEXT"); } catch {}
// scene_id: short grouping key from the breakdown (e.g. "kitchen") — used to auto-anchor continuity.
try { db.exec("ALTER TABLE production_shots ADD COLUMN scene_id TEXT"); } catch {}
// last_frame_url / last_frame_filename: final frame of the shot's clip, uploaded to kie for chaining.
try { db.exec("ALTER TABLE production_shots ADD COLUMN last_frame_url TEXT"); } catch {}
try { db.exec("ALTER TABLE production_shots ADD COLUMN last_frame_filename TEXT"); } catch {}
// audit_notes: consistency issue + suggested fix emitted by the cross-shot visual audit.
try { db.exec("ALTER TABLE production_shots ADD COLUMN audit_notes TEXT"); } catch {}
// Running total of kie credits actually spent generating this production (snapshot of
// account balance before/after each real generation call — see trackCredits in produce.ts).
try { db.exec("ALTER TABLE productions ADD COLUMN credits_spent REAL NOT NULL DEFAULT 0"); } catch {}
// Hides a production from the Costs page's per-production list once reviewed — the credits it
// spent still count toward the grand total / by-project rollups, only the itemised row is hidden.
try { db.exec("ALTER TABLE productions ADD COLUMN cost_cleared INTEGER NOT NULL DEFAULT 0"); } catch {}
// A template is a production whose shot STRUCTURE (camera direction, pacing, prompts) is meant
// to be reused across different products — see server/templates.ts. Templates are always
// project_id=null and never appear in the normal Produce list.
try { db.exec("ALTER TABLE productions ADD COLUMN is_template INTEGER NOT NULL DEFAULT 0"); } catch {}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Project {
  id: number;
  name: string;
  character_image: string | null;
  character_image_url: string | null;
  created_at: string;
}

export interface Conversation {
  id: number;
  project_id: number | null;
  title: string;
  created_at: string;
}

export interface Message {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  text: string | null;
  media_type: "image" | "video" | null;
  media_filename: string | null;
  media_subtype: string | null;
  job_id: string | null;
  job_type: "image" | "video" | null;
  status: "done" | "pending" | "failed";
  created_at: string;
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function listProjects(): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as unknown as Project[];
}

export function getProject(id: number): Project | null {
  return (db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as Project) ?? null;
}

export function createProject(name: string): Project {
  const { lastInsertRowid } = db.prepare("INSERT INTO projects (name) VALUES (?)").run(name);
  return db.prepare("SELECT * FROM projects WHERE id = ?").get(Number(lastInsertRowid)) as unknown as Project;
}

export function deleteProject(id: number): void {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

export function renameProject(id: number, name: string): void {
  db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
}

export function setProjectCharacterImage(id: number, imageFilename: string | null, imageUrl?: string | null): void {
  db.prepare("UPDATE projects SET character_image = ?, character_image_url = ? WHERE id = ?")
    .run(imageFilename, imageUrl ?? null, id);
}

// ── Conversations ─────────────────────────────────────────────────────────────

export function listConversations(projectId?: number | null): Conversation[] {
  if (projectId != null) {
    return db.prepare("SELECT * FROM conversations WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as unknown as Conversation[];
  }
  return db.prepare("SELECT * FROM conversations ORDER BY created_at DESC").all() as unknown as Conversation[];
}

export function createConversation(title = "New conversation", projectId?: number | null): Conversation {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO conversations (title, project_id) VALUES (?, ?)")
    .run(title, projectId ?? null);
  return db.prepare("SELECT * FROM conversations WHERE id = ?").get(Number(lastInsertRowid)) as unknown as Conversation;
}

export function getConversation(id: number): Conversation | null {
  return (db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as unknown as Conversation) ?? null;
}

export function updateConversationTitle(id: number, title: string): void {
  db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, id);
}

export function deleteConversation(id: number): void {
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
}

// ── Messages ──────────────────────────────────────────────────────────────────

export function getMessages(conversationId: number): Message[] {
  return db
    .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, id ASC")
    .all(conversationId) as unknown as Message[];
}

export function insertMessage(msg: Omit<Message, "id" | "created_at">): Message {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO messages
         (conversation_id, role, text, media_type, media_filename, media_subtype, job_id, job_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      msg.conversation_id,
      msg.role,
      msg.text ?? null,
      msg.media_type ?? null,
      msg.media_filename ?? null,
      msg.media_subtype ?? null,
      msg.job_id ?? null,
      msg.job_type ?? null,
      msg.status
    );
  return getMessage(Number(lastInsertRowid))!;
}

export function getMessage(id: number): Message | null {
  return (db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as unknown as Message) ?? null;
}

export function updateMessageJob(
  id: number,
  fields: Partial<Pick<Message, "status" | "media_filename" | "media_type">>
): void {
  const keys = Object.keys(fields);
  const sets = keys.map(k => `${k} = ?`).join(", ");
  db.prepare(`UPDATE messages SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
}

// ── Productions ───────────────────────────────────────────────────────────────

export type ProductionStatus = "draft" | "producing" | "review" | "assembling" | "done" | "failed";
export type ShotStatus = "pending" | "keyframe" | "keyframe_done" | "video" | "video_done" | "failed" | "skipped";

export interface Production {
  id: number;
  project_id: number | null;
  title: string;
  status: ProductionStatus;
  music_filename: string | null;
  product_image_filename: string | null;
  product_image_url: string | null;
  hero_ref_filename: string | null;
  hero_ref_url: string | null;
  style: string | null;
  style_ref_url: string | null;
  platform: string | null;
  aspect_ratio: string; // "16:9" | "9:16"
  content_style: string | null; // "polished" | "ugc"
  credits_spent: number; // running total of kie credits spent generating this production
  cost_cleared: number; // 0 | 1 — hidden from the Costs page's per-production list (totals unaffected)
  is_template: number; // 0 | 1 — a reusable shot structure rather than a real production
  final_video_filename: string | null;
  error: string | null;
  created_at: string;
}

export interface ProductionShot {
  id: number;
  production_id: number;
  shot_number: number;
  description: string | null;
  image_prompt: string | null;
  video_prompt: string | null;
  camera_shot: string | null;
  duration_hint: string | null;
  status: ShotStatus;
  keyframe_filename: string | null;
  keyframe_task_id: string | null;
  keyframe_url: string | null;
  video_filename: string | null;
  video_task_id: string | null;
  error: string | null;
  take_count: number;
  label_visible: number; // 0 | 1 (SQLite has no bool)
  is_still: number; // 0 | 1 — hold the keyframe instead of animating with Veo
  ref_shot: number | null; // shot_number whose keyframe to carry in as a scene reference
  use_character: number; // 0 | 1 — include the project character reference on this shot
  bg_asset_id: number | null; // library background asset to reference on this shot
  scene_id: string | null; // grouping key from breakdown — drives auto-anchoring and last-frame chaining
  last_frame_url: string | null; // kie CDN url of the final frame of this shot's clip
  last_frame_filename: string | null; // local copy of the last-frame grab
  audit_notes: string | null; // visual audit inconsistency + suggested retry notes
}

export interface NewProductionShot {
  shot_number: number;
  description?: string | null;
  image_prompt?: string | null;
  video_prompt?: string | null;
  camera_shot?: string | null;
  duration_hint?: string | null;
  label_visible?: boolean;
  scene_id?: string | null;
  use_character?: boolean;
}

export function listProductions(projectId?: number | null): Production[] {
  if (projectId != null) {
    return db.prepare("SELECT * FROM productions WHERE project_id = ? AND is_template = 0 ORDER BY created_at DESC").all(projectId) as unknown as Production[];
  }
  return db.prepare("SELECT * FROM productions WHERE is_template = 0 ORDER BY created_at DESC").all() as unknown as Production[];
}

export function listTemplates(): Production[] {
  return db.prepare("SELECT * FROM productions WHERE is_template = 1 ORDER BY created_at DESC").all() as unknown as Production[];
}

export function getProduction(id: number): Production | null {
  return (db.prepare("SELECT * FROM productions WHERE id = ?").get(id) as unknown as Production) ?? null;
}

export function createProduction(
  title: string,
  projectId?: number | null,
  productImageFilename?: string | null,
): Production {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO productions (title, project_id, product_image_filename) VALUES (?, ?, ?)")
    .run(title, projectId ?? null, productImageFilename ?? null);
  return getProduction(Number(lastInsertRowid))!;
}

export function updateProduction(
  id: number,
  fields: Partial<Pick<Production, "title" | "status" | "music_filename" | "product_image_filename" | "product_image_url" | "hero_ref_filename" | "hero_ref_url" | "style" | "style_ref_url" | "platform" | "aspect_ratio" | "content_style" | "cost_cleared" | "is_template" | "final_video_filename" | "error">>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(", ");
  db.prepare(`UPDATE productions SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
}

// Atomic increment (not read-modify-write in JS) so concurrent shots/productions can't clobber
// each other's credit tracking.
export function addProductionCredits(id: number, delta: number): void {
  if (!delta) return;
  db.prepare("UPDATE productions SET credits_spent = credits_spent + ? WHERE id = ?").run(delta, id);
}

export function deleteProduction(id: number): void {
  db.prepare("DELETE FROM productions WHERE id = ?").run(id);
}

export function createProductionShot(productionId: number, shot: NewProductionShot): ProductionShot {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO production_shots
         (production_id, shot_number, description, image_prompt, video_prompt, camera_shot, duration_hint, label_visible, scene_id, use_character)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      productionId,
      shot.shot_number,
      shot.description ?? null,
      shot.image_prompt ?? null,
      shot.video_prompt ?? null,
      shot.camera_shot ?? null,
      shot.duration_hint ?? null,
      shot.label_visible === false ? 0 : 1,
      shot.scene_id ?? null,
      shot.use_character === false ? 0 : 1,
    );
  return getProductionShot(Number(lastInsertRowid))!;
}

export function getProductionShots(productionId: number): ProductionShot[] {
  return db
    .prepare("SELECT * FROM production_shots WHERE production_id = ? ORDER BY shot_number ASC")
    .all(productionId) as unknown as ProductionShot[];
}

export function getProductionShot(id: number): ProductionShot | null {
  return (db.prepare("SELECT * FROM production_shots WHERE id = ?").get(id) as unknown as ProductionShot) ?? null;
}

// ── Library assets (reusable cast & products) ─────────────────────────────────

export type LibraryKind = "character" | "product" | "background";

export interface LibraryAsset {
  id: number;
  kind: LibraryKind;
  name: string;
  filename: string | null; // local media path (thumbnail)
  url: string | null;      // kie CDN url — fetchable, so it can be reused as a reference
  created_at: string;
}

export function listLibraryAssets(kind?: LibraryKind): LibraryAsset[] {
  if (kind) {
    return db.prepare("SELECT * FROM library_assets WHERE kind = ? ORDER BY created_at DESC").all(kind) as unknown as LibraryAsset[];
  }
  return db.prepare("SELECT * FROM library_assets ORDER BY created_at DESC").all() as unknown as LibraryAsset[];
}

export function getLibraryAsset(id: number): LibraryAsset | null {
  return (db.prepare("SELECT * FROM library_assets WHERE id = ?").get(id) as unknown as LibraryAsset) ?? null;
}

export function createLibraryAsset(kind: LibraryKind, name: string, filename: string | null, url: string | null): LibraryAsset {
  const { lastInsertRowid } = db
    .prepare("INSERT INTO library_assets (kind, name, filename, url) VALUES (?, ?, ?, ?)")
    .run(kind, name, filename ?? null, url ?? null);
  return getLibraryAsset(Number(lastInsertRowid))!;
}

export function deleteLibraryAsset(id: number): void {
  db.prepare("DELETE FROM library_assets WHERE id = ?").run(id);
}

export function updateLibraryAssetUrl(id: number, url: string): void {
  db.prepare("UPDATE library_assets SET url = ? WHERE id = ?").run(url, id);
}

export function updateProductionShot(
  id: number,
  fields: Partial<Pick<ProductionShot,
    "status" | "keyframe_filename" | "keyframe_task_id" | "keyframe_url" | "video_filename" | "video_task_id" |
    "error" | "take_count" | "description" | "image_prompt" | "video_prompt" | "label_visible" | "duration_hint" | "is_still" | "ref_shot" | "use_character" | "bg_asset_id" |
    "scene_id" | "last_frame_url" | "last_frame_filename" | "audit_notes" | "shot_number">>,
): void {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const sets = keys.map(k => `${k} = ?`).join(", ");
  db.prepare(`UPDATE production_shots SET ${sets} WHERE id = ?`).run(...Object.values(fields), id);
}

export function deleteProductionShot(id: number): void {
  db.prepare("DELETE FROM production_shots WHERE id = ?").run(id);
}
