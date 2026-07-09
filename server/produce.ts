import type { Express } from "express";
import type { Multer } from "multer";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import * as kie from "../lib/kie";
import * as db from "../lib/db";
import * as storage from "../lib/storage";
import { runFfmpeg } from "./assemble";

const PORT = 3460;

// ── Dependencies injected from index.ts (the composition root) ─────────────────
// Keeps the prompt-engineering / character logic in one place and avoids importing
// index.ts (which would start a second server).

interface Character { id: number; name: string; description: string; }
export interface Location { id: number; name: string; description: string; palette?: string; time_of_day?: string; key_props?: string; }

export interface ProduceDeps {
  getCharacters: () => Character[];
  getLocations: () => Location[];
  isPromptEngineerEnabled: () => boolean;
  engineerPrompt: (
    prompt: string,
    type: "image" | "video",
    characters: Character[],
    projectStyle: string,
    retryNotes?: string,
    locationContext?: string,
  ) => Promise<string>;
}

// ── Run state (in-memory) ─────────────────────────────────────────────────────

const running = new Set<number>();       // production ids currently producing
const stopRequested = new Set<number>(); // graceful-stop flags

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Fixed prompt blocks for product mode (§4).
const PRODUCT_KEYFRAME_BLOCK =
  "The product must appear exactly as in the reference image — label text, colours, and " +
  "proportions unchanged. The label is large, sharp, and facing the camera unless the shot " +
  "description says otherwise. If exact text cannot be perfectly reproduced, prioritise the " +
  "bold brand name, primary colour, and overall silhouette over any fine print or small detail " +
  "— those matter far less than the product being instantly recognisable.";
const PRODUCT_VIDEO_BLOCK =
  "Moderate camera motion only — no full orbit. The product stays fully in frame throughout.";
// Used when reference images are supplied but it isn't a full product-ad shot.
const CONSISTENCY_BLOCK =
  "Reproduce the subject(s) shown in the reference image(s) exactly — same product and/or person, " +
  "same colours, proportions, and defining details. Only the scene, framing, and action change between shots.";

// Turns real product photo(s) into a clean, campaign-ready hero still — the "improve a real
// product for production" path (as opposed to generating a hero purely from a text prompt).
// Multiple angles (front/side/label close-up) give Nano Banana real 3D + label information
// instead of guessing, the same principle as the character turnaround sheet used elsewhere.
function heroFromPhotosPrompt(notes?: string): string {
  return (
    "Using the attached reference photo(s) — all showing the exact same real physical product, " +
    "possibly from different angles — produce ONE clean, production-ready hero product shot for " +
    "an ad campaign.\n" +
    "- Preserve the product's exact shape, proportions, colours, materials, and every label/logo/" +
    "text detail precisely as shown across the references — do not invent, alter, or simplify any branding\n" +
    "- Replace the background with a clean, neutral studio backdrop (soft gradient or seamless surface)\n" +
    "- Studio-quality lighting: soft, even, flattering — no harsh shadows or glare\n" +
    "- Centred, well-composed, sharp focus, product fully in frame\n" +
    "- No people, no hands, no props — the product alone" +
    (notes?.trim() ? `\n\nAdditional direction: ${notes.trim()}` : "")
  );
}

function mediaUrlAbsolute(filename: string): string {
  return `http://localhost:${PORT}/api/media/${filename}`;
}

// ── URL freshening (Fix 1) ────────────────────────────────────────────────────
// kie CDN files expire after ~3 days. Before each generation we HEAD-check every
// reference URL and re-upload from the local copy if the CDN has deleted it.

// Some CDNs don't support HEAD — confirm liveness with a tiny ranged GET before deciding a
// URL is gone, otherwise we'd needlessly re-upload every reference on every run.
async function isUrlAlive(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8_000) });
    if (r.ok) return true;
  } catch { /* fall through to ranged GET */ }
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(8_000) });
    if (r.ok || r.status === 206) return true;
  } catch { /* treat as expired */ }
  return false;
}

async function freshenUrl(url: string, localFilename: string | null): Promise<string> {
  if (await isUrlAlive(url)) return url;

  if (!localFilename) throw new Error("Reference URL expired with no local backup");
  const absPath = storage.resolveMediaPath(localFilename);
  if (!absPath || !fs.existsSync(absPath)) throw new Error(`Reference URL expired; local file missing: ${localFilename}`);
  const ext = path.extname(localFilename).toLowerCase().slice(1) || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  const b64 = fs.readFileSync(absPath).toString("base64");
  return kie.uploadImageBase64(`data:${mime};base64,${b64}`, path.basename(localFilename));
}

// ── Character filtering (Fix 4b) ──────────────────────────────────────────────
// Only inject characters whose names appear in the shot text; fall back to all
// characters if none match (avoids injecting every character into every shot).

function shotCharacters(shot: db.ProductionShot, characters: Character[]): Character[] {
  if (characters.length === 0) return [];
  const text = `${shot.description ?? ""} ${shot.image_prompt ?? ""} ${shot.video_prompt ?? ""}`.toLowerCase();
  const matched = characters.filter(c => text.includes(c.name.toLowerCase()));
  return matched.length > 0 ? matched : characters;
}

// ── Reference URL resolution (Fix 1 + 2 + 3 + 7) ─────────────────────────────
// Async: HEAD-checks every URL, re-uploads from local copy if expired.
// Chains the previous clip's last frame when shots share a scene_id.

async function keyframeReferenceUrls(production: db.Production, shot: db.ProductionShot): Promise<string[]> {
  const refs: string[] = [];

  // Product / hero reference (only on shots that feature the product label)
  if (shot.label_visible) {
    if (production.hero_ref_url) {
      try {
        const fresh = await freshenUrl(production.hero_ref_url, production.hero_ref_filename);
        if (fresh !== production.hero_ref_url) db.updateProduction(production.id, { hero_ref_url: fresh });
        refs.push(fresh);
      } catch (e) { console.warn("[produce] hero_ref_url unavailable:", e); }
    } else if (production.product_image_url) {
      try {
        const fresh = await freshenUrl(production.product_image_url, production.product_image_filename);
        if (fresh !== production.product_image_url) db.updateProduction(production.id, { product_image_url: fresh });
        refs.push(fresh);
      } catch (e) { console.warn("[produce] product_image_url unavailable:", e); }
    }
  }

  // Character reference: per-shot (use_character flag lets close-ups drop it)
  if (shot.use_character) {
    const proj = production.project_id ? db.getProject(production.project_id) : null;
    if (proj?.character_image_url) {
      try {
        const fresh = await freshenUrl(proj.character_image_url, proj.character_image);
        if (fresh !== proj.character_image_url) db.setProjectCharacterImage(proj.id, proj.character_image, fresh);
        refs.push(fresh);
      } catch (e) { console.warn("[produce] character_image_url unavailable:", e); }
    }
  }

  // Background / set-plate reference
  if (shot.bg_asset_id) {
    const bg = db.getLibraryAsset(shot.bg_asset_id);
    if (bg?.url) {
      try {
        const fresh = await freshenUrl(bg.url, bg.filename);
        if (fresh !== bg.url) db.updateLibraryAssetUrl(bg.id, fresh);
        refs.push(fresh);
      } catch (e) { console.warn("[produce] bg_asset url unavailable:", e); }
    }
  }

  // Scene continuity: Fix 3 (last frame of prev shot) or Fix 2 / manual ref_shot (scene anchor).
  // ref_shot === 0 is an explicit "no continuity" override (distinct from null = let the
  // pipeline auto-decide) — it skips BOTH the automatic last-frame chaining below and the
  // scene-anchor fallback, so a shot can be deliberately unrelated to earlier ones even when
  // it shares a scene_id.
  const allShots = db.getProductionShots(production.id);
  if (shot.ref_shot !== 0 && shot.scene_id) {
    // Prefer the immediately preceding shot's last frame — true temporal continuity
    const prevWithFrame = [...allShots]
      .filter(s => s.scene_id === shot.scene_id && s.shot_number < shot.shot_number && s.last_frame_url)
      .sort((a, b) => b.shot_number - a.shot_number)[0];
    if (prevWithFrame?.last_frame_url) {
      try {
        const fresh = await freshenUrl(prevWithFrame.last_frame_url, prevWithFrame.last_frame_filename);
        if (fresh !== prevWithFrame.last_frame_url) db.updateProductionShot(prevWithFrame.id, { last_frame_url: fresh });
        refs.push(fresh);
      } catch (e) { console.warn("[produce] last_frame_url unavailable:", e); }
    } else if (shot.ref_shot) {
      // Fall back to the scene-anchor keyframe (auto-set by runProduction, Fix 2)
      const anchor = allShots.find(s => s.shot_number === shot.ref_shot);
      if (anchor?.keyframe_url) {
        try {
          const fresh = await freshenUrl(anchor.keyframe_url, anchor.keyframe_filename);
          if (fresh !== anchor.keyframe_url) db.updateProductionShot(anchor.id, { keyframe_url: fresh });
          refs.push(fresh);
        } catch (e) { console.warn("[produce] scene anchor keyframe_url unavailable:", e); }
      }
    }
  } else if (shot.ref_shot) {
    // Manual override (no scene_id set)
    const carry = allShots.find(s => s.shot_number === shot.ref_shot);
    if (carry?.keyframe_url) {
      try {
        const fresh = await freshenUrl(carry.keyframe_url, carry.keyframe_filename);
        if (fresh !== carry.keyframe_url) db.updateProductionShot(carry.id, { keyframe_url: fresh });
        refs.push(fresh);
      } catch (e) { console.warn("[produce] manual ref_shot keyframe_url unavailable:", e); }
    }
  }

  // Style reference image (Fix 7) — sets visual tone, no local backup needed
  if (production.style_ref_url) {
    if (await isUrlAlive(production.style_ref_url)) refs.push(production.style_ref_url);
    else console.warn("[produce] style_ref_url unreachable — skipping");
  }

  return refs;
}

// ── Prompt composition (reuses /api/generate-image logic) ─────────────────────

async function composeKeyframePrompt(
  shot: db.ProductionShot,
  projectStyle: string,
  productInShot: boolean, // product mode AND this shot features the product (label_visible)
  hasRefs: boolean,
  deps: ProduceDeps,
  dryRun: boolean,
  retryNotes?: string,
): Promise<string> {
  let base = shot.image_prompt || shot.description || "";

  // Fix 4b: only inject characters present in this shot; fallback to all
  const chars = shotCharacters(shot, deps.getCharacters());

  // Fix 5: location context from the environment bible
  let locationContext = "";
  if (shot.scene_id) {
    const loc = deps.getLocations().find(l => l.name.toLowerCase() === shot.scene_id!.toLowerCase());
    if (loc) {
      const parts = [loc.description];
      if (loc.palette) parts.push(`Colour palette: ${loc.palette}`);
      if (loc.time_of_day) parts.push(`Time of day: ${loc.time_of_day}`);
      if (loc.key_props) parts.push(`Key props present: ${loc.key_props}`);
      locationContext = `Location — ${loc.name}: ${parts.join(". ")}`;
    }
  }

  if (!dryRun) {
    if (deps.isPromptEngineerEnabled() || retryNotes) {
      base = await deps.engineerPrompt(base, "image", chars, projectStyle, retryNotes, locationContext || undefined);
    } else if (chars.length) {
      const charBlock = chars.map(c => `${c.name}: ${c.description}`).join(". ");
      base = `${base}. Subject reference: ${charBlock}`;
      if (locationContext) base = `${base}. ${locationContext}`;
    } else if (locationContext) {
      base = `${base}. ${locationContext}`;
    }
  }

  // The "product must appear exactly" block only belongs on shots that actually feature the product;
  // otherwise use the generic consistency block when any reference (e.g. the character) is supplied.
  if (productInShot) base = `${base}\n\n${PRODUCT_KEYFRAME_BLOCK}`;
  else if (hasRefs) base = `${base}\n\n${CONSISTENCY_BLOCK}`;
  // Global style appended deterministically (after engineering) so the medium can't be dropped.
  if (projectStyle) base = `${base}\n\nRendering style — MUST be identical in every shot: ${projectStyle}.`;
  return base;
}

async function composeVideoPrompt(
  shot: db.ProductionShot,
  projectStyle: string,
  productMode: boolean,
  deps: ProduceDeps,
  dryRun: boolean,
  retryNotes?: string,
): Promise<string> {
  // Prefer an explicit motion-first video prompt; otherwise derive from the shot.
  let base = shot.video_prompt || shot.description || shot.image_prompt || "";
  if (shot.camera_shot) base = `${shot.camera_shot}. ${base}`;

  // Fix 4b: only inject characters present in this shot
  const chars = shotCharacters(shot, deps.getCharacters());

  if (!dryRun) {
    if (deps.isPromptEngineerEnabled() || retryNotes) {
      base = await deps.engineerPrompt(base, "video", chars, projectStyle, retryNotes);
    }
  }

  if (productMode && shot.label_visible) base = `${base}\n\n${PRODUCT_VIDEO_BLOCK}`;
  if (projectStyle) base = `${base}\n\nRendering style — MUST match every other shot: ${projectStyle}.`;
  return base;
}

// ── Transient-error auto-retry ────────────────────────────────────────────────
// kie occasionally returns a generic "Internal Error, Please try again later" — a
// server-side hiccup, not a real problem with the prompt/references. Retrying the
// whole create+poll cycle a couple of times with backoff rides through it instead
// of failing the shot on the first blip.

const TRANSIENT_PATTERNS = [/internal error/i, /try again later/i, /timed out/i, /timeout/i, /rate limit/i, /503/, /502/, /504/];
const RETRY_DELAYS_MS = [5000, 15000, 30000]; // 3 retries: 5s, 15s, 30s backoff

export function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some(p => p.test(msg));
}

export async function withTransientRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === RETRY_DELAYS_MS.length) throw err;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[produce] ${label} hit a transient error, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length}):`, err instanceof Error ? err.message : err);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Cost tracking ─────────────────────────────────────────────────────────────
// Snapshots the account's kie credit balance before/after a real generation call and adds the
// delta to the production's running total. Two productions generating concurrently can both
// spend between one snapshot pair, so this is an approximation, not an exact ledger — but for
// a single-user local app it's a good enough real cost-per-ad figure. Never lets a tracking
// failure (or the extra balance calls themselves) block or fail the actual generation.
export async function trackCredits<T>(productionId: number, fn: () => Promise<T>): Promise<T> {
  let before: number | null = null;
  try { before = await kie.getCredits(); } catch { /* tracking is best-effort */ }

  const result = await fn();

  if (before != null) {
    try {
      const after = await kie.getCredits();
      const delta = before - after;
      if (delta > 0) db.addProductionCredits(productionId, delta);
    } catch { /* tracking is best-effort */ }
  }
  return result;
}

// ── kie polling helpers ───────────────────────────────────────────────────────

async function pollImageToUrl(taskId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    const r = await kie.pollImageTask(taskId);
    if (r.status === "success" && r.imageUrl) return r.imageUrl;
    if (r.status === "failed") throw new Error(r.errorMessage || "Keyframe generation failed");
    await sleep(4500);
  }
  throw new Error("Keyframe generation timed out");
}

async function pollVideoToUrl(taskId: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const r = await kie.pollVideoTask(taskId);
    if (r.status === "success" && r.videoUrl) return r.videoUrl;
    if (r.status === "failed") throw new Error(r.errorMessage || "Clip generation failed");
    await sleep(4500);
  }
  throw new Error("Clip generation timed out");
}

// Kling/Seedance share the generic jobs/recordInfo poll shape — see kie.pollMarketTask.
async function pollMarketVideoToUrl(taskId: string): Promise<string> {
  for (let i = 0; i < 120; i++) {
    const r = await kie.pollMarketTask(taskId);
    if (r.status === "success" && r.videoUrl) return r.videoUrl;
    if (r.status === "failed") throw new Error(r.errorMessage || "Clip generation failed");
    await sleep(4500);
  }
  throw new Error("Clip generation timed out");
}

// ── Dry-run placeholders (no kie.ai credits spent) ────────────────────────────
// Synthesises real, playable media with ffmpeg so the loop + UI + assembly can be
// exercised end-to-end without firing paid generations.

const DRY_COLOURS = ["red", "green", "blue", "orange", "purple", "teal", "maroon", "navy", "olive", "gray"];

// Pixel dimensions for an aspect ratio (used by dry-run placeholders so they match real output).
function aspectDims(aspect: string): { w: number; h: number } {
  return aspect === "9:16" ? { w: 720, h: 1280 } : { w: 1280, h: 720 };
}

async function synthPlaceholderImage(shot: db.ProductionShot, projectId: number | null, aspect: string): Promise<string> {
  const colour = DRY_COLOURS[(shot.shot_number - 1) % DRY_COLOURS.length];
  const { w, h } = aspectDims(aspect);
  const name = `keyframe_dry_${shot.id}_${Date.now()}.png`;
  const { absPath, relPath } = storage.reserveMediaPath(name, "images", projectId);
  await runFfmpeg([
    "-y", "-f", "lavfi",
    "-i", `color=c=${colour}:s=${w}x${h}:d=1`,
    "-frames:v", "1", absPath,
  ]);
  return relPath;
}

async function synthPlaceholderVideo(shot: db.ProductionShot, projectId: number | null, aspect: string): Promise<string> {
  // Test seam: KIE_STUDIO_FAIL_SHOTS="4,7" forces those shot numbers to fail during a
  // dry run, so the failure-resilience path can be exercised without spending credits.
  const failList = (process.env.KIE_STUDIO_FAIL_SHOTS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (failList.includes(String(shot.shot_number))) {
    throw new Error(`Forced dry-run failure (shot ${shot.shot_number})`);
  }

  const colour = DRY_COLOURS[(shot.shot_number - 1) % DRY_COLOURS.length];
  const { w, h } = aspectDims(aspect);
  const name = `clip_dry_${shot.id}_${Date.now()}.mp4`;
  const { absPath, relPath } = storage.reserveMediaPath(name, "videos", projectId);
  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-i", `color=c=${colour}:s=${w}x${h}:d=2:r=24`,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-shortest", "-pix_fmt", "yuv420p",
    "-c:v", "libx264", "-c:a", "aac", absPath,
  ]);
  return relPath;
}

// Parse a duration hint ("3s", "1.5") into seconds.
function parseSeconds(hint: string | null): number | null {
  if (!hint) return null;
  const m = hint.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// Freeze/still shot: hold the keyframe for its duration as a real MP4 (no Veo credits spent).
async function synthStillFromKeyframe(shot: db.ProductionShot, projectId: number | null, seconds: number): Promise<string> {
  const src = shot.keyframe_filename ? storage.resolveMediaPath(shot.keyframe_filename) : null;
  if (!src) throw new Error("Still shot needs a keyframe first");
  const name = `still_${shot.id}_${Date.now()}.mp4`;
  const { absPath, relPath } = storage.reserveMediaPath(name, "videos", projectId);
  await runFfmpeg([
    "-y",
    "-loop", "1", "-i", src,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-t", String(seconds),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", absPath,
  ]);
  return relPath;
}

// ── Last-frame grab (Fix 3) ──────────────────────────────────────────────────
// Extracts the final frame of a clip, saves it locally, uploads to kie.
// Called after each real (non-dry-run) clip, so the next shot in the same scene
// can use it as a reference — locking lighting state and prop positions.

async function grabLastFrame(
  videoFilename: string,
  shotId: number,
  projectId: number | null,
): Promise<{ url: string; filename: string } | null> {
  const src = storage.resolveMediaPath(videoFilename);
  if (!src || !fs.existsSync(src)) return null;
  const name = `lastframe_${shotId}_${Date.now()}.png`;
  const { absPath, relPath } = storage.reserveMediaPath(name, "images", projectId);
  await runFfmpeg(["-y", "-sseof", "-0.5", "-i", src, "-update", "1", "-frames:v", "1", "-q:v", "2", absPath]);
  const b64 = fs.readFileSync(absPath).toString("base64");
  const url = await kie.uploadImageBase64(`data:image/png;base64,${b64}`, name);
  return { url, filename: relPath };
}

// ── Single-shot processing ────────────────────────────────────────────────────

type Stage = "keyframes" | "videos" | "all";

interface ShotOptions {
  dryRun: boolean;
  quality: kie.VideoQuality; // Veo sub-tier (lite/fast/quality) — only used when videoEngine is "veo"
  videoEngine?: kie.MarketVideoEngine | "veo"; // which model actually renders the clip; default "veo"
  imageModel: kie.ImageModel; // keyframe model — nano-banana-2 holds a reference far better than v1
  stage?: Stage; // keyframes-first workflow: review stills before spending on video
  keyframeOnly?: boolean;
  videoOnly?: boolean;
  notes?: string;
}

async function processShot(
  production: db.Production,
  shotId: number,
  deps: ProduceDeps,
  opts: ShotOptions,
): Promise<void> {
  const projectId = production.project_id;
  const productMode = Boolean(production.product_image_filename);
  const projectStyle = production.style ?? ""; // global rendering medium, applied to every shot
  const aspect = production.aspect_ratio || "16:9"; // drives keyframe + Veo aspect

  const doKeyframe = !opts.videoOnly;
  const doVideo = !opts.keyframeOnly;

  let shot = db.getProductionShot(shotId)!;
  let keyframeRefUrl: string | null = null;

  // ── Keyframe stage ──
  if (doKeyframe) {
    db.updateProductionShot(shotId, { status: "keyframe", error: null });
    const refUrls = opts.dryRun ? [] : await keyframeReferenceUrls(production, shot);
    const productInShot = productMode && !!shot.label_visible;
    const prompt = await composeKeyframePrompt(shot, projectStyle, productInShot, refUrls.length > 0, deps, opts.dryRun, opts.notes);

    if (opts.dryRun) {
      const filename = await synthPlaceholderImage(shot, projectId, aspect);
      keyframeRefUrl = mediaUrlAbsolute(filename);
      db.updateProductionShot(shotId, {
        status: "keyframe_done",
        keyframe_filename: filename,
        keyframe_task_id: `dry_${Date.now()}`,
        take_count: shot.take_count + 1,
      });
    } else {
      const cdnUrl = await trackCredits(production.id, () => withTransientRetry(`keyframe (shot ${shot.shot_number})`, async () => {
        const { taskId } = await kie.createImageTask(prompt, opts.imageModel, refUrls, aspect as kie.AspectRatio);
        db.updateProductionShot(shotId, { keyframe_task_id: taskId });
        return pollImageToUrl(taskId);
      }));
      const filename = await storage.saveImage(cdnUrl, `keyframe_${Date.now()}`, projectId);
      keyframeRefUrl = cdnUrl; // kie CDN url — publicly fetchable for the video stage
      db.updateProductionShot(shotId, {
        status: "keyframe_done",
        keyframe_filename: filename,
        keyframe_url: cdnUrl, // persisted so clip-only retries have a fetchable reference
        take_count: shot.take_count + 1,
      });
    }
    shot = db.getProductionShot(shotId)!;
  }

  // ── Video stage ──
  if (doVideo) {
    db.updateProductionShot(shotId, { status: "video", error: null });

    // Freeze/still shots hold the keyframe — no Veo call, in dry run or for real.
    if (shot.is_still) {
      const secs = parseSeconds(shot.duration_hint) ?? 2;
      const filename = await synthStillFromKeyframe(shot, projectId, secs); // holds the keyframe, so it inherits its aspect
      db.updateProductionShot(shotId, { status: "video_done", video_filename: filename, video_task_id: "still" });
      return;
    }

    const prompt = await composeVideoPrompt(shot, projectStyle, productMode, deps, opts.dryRun, opts.notes);

    if (opts.dryRun) {
      const filename = await synthPlaceholderVideo(shot, projectId, aspect);
      db.updateProductionShot(shotId, {
        status: "video_done",
        video_filename: filename,
        video_task_id: `dry_${Date.now()}`,
      });
    } else {
      // Reference image must be a kie-fetchable URL: the freshly generated keyframe's CDN url,
      // or the one persisted from when the keyframe was made. The local /api/media path is NOT
      // reachable by kie's servers, so never fall back to it.
      // A video-only retry skips the keyframe stage entirely, so this falls back to the
      // persisted url — which may be a kie CDN link generated days ago. Freshen it the same
      // way every other reference (hero/character/background/carried keyframe) already is.
      if (!keyframeRefUrl && shot.keyframe_url) {
        keyframeRefUrl = await freshenUrl(shot.keyframe_url, shot.keyframe_filename);
      }
      if (!keyframeRefUrl) {
        throw new Error("No fetchable keyframe reference — regenerate the keyframe (retry with 'Keyframe + clip').");
      }
      const engine = opts.videoEngine ?? "veo";
      const cdnUrl = await trackCredits(production.id, () => withTransientRetry(`clip (shot ${shot.shot_number}, ${engine})`, async () => {
        if (engine === "kling") {
          const { taskId } = await kie.createKlingVideoTask(prompt, keyframeRefUrl!, { aspectRatio: aspect as "16:9" | "9:16" });
          db.updateProductionShot(shotId, { video_task_id: taskId });
          return pollMarketVideoToUrl(taskId);
        }
        if (engine === "seedance") {
          const { taskId } = await kie.createSeedanceVideoTask(prompt, keyframeRefUrl!, { aspectRatio: aspect });
          db.updateProductionShot(shotId, { video_task_id: taskId });
          return pollMarketVideoToUrl(taskId);
        }
        const { taskId } = await kie.createVideoTask(prompt, [keyframeRefUrl!], opts.quality, aspect as kie.VideoAspect);
        db.updateProductionShot(shotId, { video_task_id: taskId });
        return pollVideoToUrl(taskId);
      }));
      const filename = await storage.saveVideo(cdnUrl, `clip_${Date.now()}`, projectId);
      db.updateProductionShot(shotId, { status: "video_done", video_filename: filename });

      // Fix 3: grab the final frame of this clip and upload to kie so the next shot
      // in the same scene can use it as a reference (lighting/prop continuity).
      try {
        const frame = await grabLastFrame(filename, shotId, projectId);
        if (frame) db.updateProductionShot(shotId, { last_frame_url: frame.url, last_frame_filename: frame.filename });
      } catch (e) {
        // Non-fatal: clip is done, chaining just won't be available for the next shot.
        console.warn(`[produce] last-frame grab failed for shot ${shotId}:`, e);
      }
    }
  }
}

// ── Full production run ───────────────────────────────────────────────────────

async function runProduction(productionId: number, deps: ProduceDeps, opts: ShotOptions): Promise<void> {
  if (running.has(productionId)) return;
  running.add(productionId);
  stopRequested.delete(productionId);
  db.updateProduction(productionId, { status: "producing", error: null });

  try {
    // Re-read shots each iteration so retries/edits are picked up.
    let stopped = false;
    const stage: Stage = opts.stage ?? "all";
    for (const base of db.getProductionShots(productionId)) {
      if (stopRequested.has(productionId)) { stopped = true; break; }
      const shot = db.getProductionShot(base.id)!;
      if (shot.status === "skipped") continue;

      // Decide what to do for this shot based on the stage.
      let shotOpts = opts;
      if (stage === "keyframes") {
        // Only make stills; skip shots that already have a keyframe.
        if (shot.keyframe_filename || shot.status === "video_done") continue;
        shotOpts = { ...opts, keyframeOnly: true };
      } else if (stage === "videos") {
        // Only animate shots that have an approved keyframe and no clip yet.
        if (shot.status === "video_done") continue;
        if (!shot.keyframe_filename) continue;
        shotOpts = { ...opts, videoOnly: true };
      } else {
        // "all" — full keyframe→video, resume-friendly.
        if (shot.status === "video_done") continue;
      }

      // Fix 2: auto scene grouping — before generating this shot's keyframe, anchor it to
      // the first completed keyframe in its scene (if no manual ref_shot is already set).
      // Uses loose equality deliberately: ref_shot === 0 (explicit "no continuity") is NOT
      // null, so this correctly skips auto-anchoring a shot the user turned continuity off for.
      if (shot.scene_id && shot.ref_shot == null) {
        const allShots = db.getProductionShots(productionId);
        const anchor = allShots.find(s =>
          s.scene_id === shot.scene_id &&
          s.shot_number < shot.shot_number &&
          s.keyframe_filename,
        );
        if (anchor) db.updateProductionShot(shot.id, { ref_shot: anchor.shot_number });
      }

      const production = db.getProduction(productionId)!;
      try {
        await processShot(production, shot.id, deps, shotOpts);
      } catch (err) {
        // Resilience: one bad shot is marked failed and the run continues.
        db.updateProductionShot(shot.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const shots = db.getProductionShots(productionId);
    const anyDone = shots.some(s => s.status === "video_done");
    const allTerminal = shots.every(s => ["video_done", "failed", "skipped"].includes(s.status));
    if (stopped) {
      db.updateProduction(productionId, { status: "review" });
    } else if (anyDone) {
      db.updateProduction(productionId, { status: "review" });
    } else if (allTerminal) {
      db.updateProduction(productionId, { status: "failed", error: "All shots failed" });
    } else {
      db.updateProduction(productionId, { status: "review" });
    }
  } finally {
    running.delete(productionId);
    stopRequested.delete(productionId);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

interface BreakdownShot {
  shot_number: number;
  duration?: string;
  description?: string;
  image_prompt?: string;
  video_prompt?: string;
  camera_shot?: string;
  label_visible?: boolean;
  scene_id?: string;
}

export function registerProduceRoutes(app: Express, upload: Multer, deps: ProduceDeps) {
  // Create a production from a Script Writer breakdown (or an empty draft).
  app.post("/api/productions", (req, res) => {
    const { projectId, title, shots, productImageFilename } = req.body as {
      projectId?: number | null; title?: string; shots?: BreakdownShot[]; productImageFilename?: string | null;
    };
    try {
      const production = db.createProduction(
        title?.trim() || "Untitled production",
        projectId ?? null,
        productImageFilename ?? null,
      );
      if (Array.isArray(shots)) {
        shots.forEach(s => {
          db.createProductionShot(production.id, {
            shot_number: s.shot_number,
            description: s.description ?? null,
            image_prompt: s.image_prompt ?? null,
            video_prompt: s.video_prompt ?? null,
            camera_shot: s.camera_shot ?? null,
            duration_hint: s.duration ?? null,
            label_visible: s.label_visible ?? true,
            scene_id: s.scene_id ?? null,
          });
        });
      }
      res.json({ production, shots: db.getProductionShots(production.id) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // List productions (optionally scoped to a project).
  app.get("/api/productions", (req, res) => {
    const projectId = req.query.projectId ? Number(req.query.projectId) : null;
    res.json(db.listProductions(projectId));
  });

  // Full state for UI polling.
  app.get("/api/productions/:id", (req, res) => {
    const production = db.getProduction(Number(req.params.id));
    if (!production) return res.status(404).json({ error: "Production not found" });
    res.json({
      production,
      shots: db.getProductionShots(production.id),
      running: running.has(production.id),
    });
  });

  // Upload a product image (enables product mode).
  app.post("/api/productions/:id/product-image", upload.single("file"), async (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    const file = (req as unknown as { file?: { buffer: Buffer; originalname: string; mimetype?: string } }).file;
    if (!file) return res.status(400).json({ error: "Missing file" });
    try {
      const ext = (file.originalname.match(/\.[a-z0-9]+$/i)?.[0]) || ".png";
      const name = `product_${Date.now()}${ext}`;
      const filename = storage.saveBuffer(file.buffer, name, "images", production.project_id);
      db.updateProduction(id, { product_image_filename: filename });
      // Upload to kie so the product photo is fetchable and usable as a reference.
      let url: string | null = null;
      try {
        const mime = file.mimetype || "image/png";
        url = await kie.uploadImageBase64(`data:${mime};base64,${file.buffer.toString("base64")}`, name);
        db.updateProduction(id, { product_image_url: url });
      } catch (e) {
        // Keep the local copy; the reference just won't be available until re-uploaded.
        return res.json({ filename, url: null, warning: `Uploaded locally but kie upload failed: ${e instanceof Error ? e.message : String(e)}` });
      }
      res.json({ filename, url });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Generate a hero reference still. Its kie CDN url is fetchable, so it can anchor every
  // keyframe for product consistency (unlike an uploaded product image on localhost).
  app.post("/api/productions/:id/hero", async (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    const { prompt, dryRun } = req.body as { prompt?: string; dryRun?: boolean };
    try {
      const heroAspect = (production.aspect_ratio || "16:9") as kie.AspectRatio;
      if (dryRun) {
        const dims = heroAspect === "9:16" ? "720x1280" : "1280x720";
        const name = `hero_dry_${id}_${Date.now()}.png`;
        const { absPath, relPath } = storage.reserveMediaPath(name, "images", production.project_id);
        await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=c=slateblue:s=${dims}:d=1`, "-frames:v", "1", absPath]);
        db.updateProduction(id, { hero_ref_filename: relPath, hero_ref_url: mediaUrlAbsolute(relPath) });
        return res.json({ status: "done", filename: relPath });
      }
      if (!prompt?.trim()) return res.status(400).json({ error: "Missing prompt" });
      let finalPrompt = prompt;
      if (deps.isPromptEngineerEnabled()) finalPrompt = await deps.engineerPrompt(prompt, "image", deps.getCharacters(), production.style ?? "");
      if (production.style) finalPrompt = `${finalPrompt}\n\nRendering style: ${production.style}.`;
      const { taskId } = await kie.createImageTask(finalPrompt, "nano-banana-2", [], heroAspect);
      res.json({ taskId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Poll a hero-still generation; on success saves it and stores the CDN url on the production.
  app.get("/api/productions/:id/hero-poll", async (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    try {
      const result = await kie.pollImageTask(String(req.query.taskId));
      if (result.status === "success" && result.imageUrl) {
        const filename = await storage.saveImage(result.imageUrl, `hero_${req.query.taskId}`, production.project_id);
        db.updateProduction(id, { hero_ref_filename: filename, hero_ref_url: result.imageUrl });
        return res.json({ status: "done", filename, imageUrl: result.imageUrl });
      }
      if (result.status === "failed") return res.json({ status: "failed", error: result.errorMessage });
      res.json({ status: "pending" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Generate a hero still FROM real product photos (1-3 angles) instead of a text prompt —
  // uploads each photo to kie, then asks nano-banana-2 to produce a clean, production-ready
  // still using them as references. Polled via the same /hero-poll endpoint above (it doesn't
  // care how the taskId's generation was seeded).
  app.post("/api/productions/:id/hero-from-photos", upload.array("files", 3), async (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    const files = (req as unknown as { files?: { buffer: Buffer; originalname: string; mimetype?: string }[] }).files;
    if (!files || files.length === 0) return res.status(400).json({ error: "Missing photo(s)" });
    const { notes } = req.body as { notes?: string };
    try {
      const photoUrls = await Promise.all(files.map((file, i) => {
        const ext = (file.originalname.match(/\.[a-z0-9]+$/i)?.[0]) || ".png";
        const mime = file.mimetype || "image/png";
        return kie.uploadImageBase64(`data:${mime};base64,${file.buffer.toString("base64")}`, `hero_src_${Date.now()}_${i}${ext}`);
      }));
      const heroAspect = (production.aspect_ratio || "16:9") as kie.AspectRatio;
      const { taskId } = await kie.createImageTask(heroFromPhotosPrompt(notes), "nano-banana-2", photoUrls, heroAspect);
      res.json({ taskId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Grab a frame from a completed clip, upload it to kie (so it's fetchable), and save it
  // as a reusable background library asset.
  app.post("/api/backgrounds/grab", async (req, res) => {
    const { videoFilename, name, atSeconds } = req.body as { videoFilename?: string; name?: string; atSeconds?: number };
    if (!videoFilename) return res.status(400).json({ error: "Missing videoFilename" });
    const src = storage.resolveMediaPath(videoFilename);
    if (!src) return res.status(404).json({ error: "Clip not found on disk" });
    try {
      const fname = `bggrab_${Date.now()}.png`;
      const { absPath, relPath } = storage.reserveMediaPath(fname, "images", null);
      // Seek: an explicit time from the start, otherwise a frame near the end (settled state).
      const seek = typeof atSeconds === "number" && atSeconds >= 0 ? ["-ss", String(atSeconds), "-i", src] : ["-sseof", "-0.3", "-i", src];
      await runFfmpeg(["-y", ...seek, "-update", "1", "-frames:v", "1", "-q:v", "2", absPath]);
      const dataUrl = `data:image/png;base64,${fs.readFileSync(absPath).toString("base64")}`;
      const url = await kie.uploadImageBase64(dataUrl, fname);
      const asset = db.createLibraryAsset("background", (name || "Grabbed frame").trim(), relPath, url);
      res.json({ ok: true, asset });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Set the target platform + aspect ratio for a production.
  app.post("/api/productions/:id/platform", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    const { platform, aspectRatio } = req.body as { platform?: string; aspectRatio?: string };
    if (platform !== undefined) db.updateProduction(id, { platform: platform || null });
    if (aspectRatio === "9:16" || aspectRatio === "16:9") db.updateProduction(id, { aspect_ratio: aspectRatio });
    res.json({ ok: true });
  });

  // Set the global rendering style (appended to every keyframe + video prompt).
  app.post("/api/productions/:id/style", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    db.updateProduction(id, { style: (req.body?.style ?? "").trim() || null });
    res.json({ ok: true });
  });

  // Rename a production (e.g. to tell apart several Ad Pack angles for the same campaign).
  app.post("/api/productions/:id/title", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    const title = (req.body?.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "Missing title" });
    db.updateProduction(id, { title });
    res.json({ ok: true });
  });

  // Hide a production from the Costs page's per-production list once reviewed. The credits it
  // spent still count toward the grand total / by-project rollups — only the itemised row hides.
  app.post("/api/productions/:id/clear-cost", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    const cleared = req.body?.cleared !== false; // default true (clear); pass {cleared:false} to restore
    db.updateProduction(id, { cost_cleared: cleared ? 1 : 0 });
    res.json({ ok: true });
  });

  // Clear the hero reference.
  app.post("/api/productions/:id/hero-clear", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    db.updateProduction(id, { hero_ref_filename: null, hero_ref_url: null });
    res.json({ ok: true });
  });

  // Start (or resume) a production run. Fire-and-forget; the client polls GET.
  app.post("/api/productions/:id/produce", (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    if (running.has(id)) return res.status(409).json({ error: "Production already running" });

    const stageReq = req.body?.stage;
    const videoEngineReq = req.body?.videoEngine;
    const opts: ShotOptions = {
      dryRun: Boolean(req.body?.dryRun),
      quality: (req.body?.quality === "quality" ? "quality" : req.body?.quality === "lite" ? "lite" : "fast") as kie.VideoQuality,
      videoEngine: (videoEngineReq === "kling" || videoEngineReq === "seedance" ? videoEngineReq : "veo") as ShotOptions["videoEngine"],
      imageModel: (req.body?.imageModel === "google/nano-banana" ? "google/nano-banana" : "nano-banana-2") as kie.ImageModel,
      stage: (stageReq === "keyframes" || stageReq === "videos" ? stageReq : "all") as Stage,
    };
    runProduction(id, deps, opts).catch(err => {
      db.updateProduction(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    });
    res.json({ ok: true, production: db.getProduction(id) });
  });

  // Graceful stop — finishes the current shot, then halts.
  app.post("/api/productions/:id/stop", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    stopRequested.add(id);
    res.json({ ok: true });
  });

  // Regenerate a single shot (keyframe-only / video-only / with notes).
  app.post("/api/productions/:id/retry-shot", (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    if (running.has(id)) return res.status(409).json({ error: "Production is running — stop it first" });

    const { shotId, keyframeOnly, videoOnly, notes, dryRun, quality, imageModel, videoEngine } = req.body as {
      shotId?: number; keyframeOnly?: boolean; videoOnly?: boolean; notes?: string; dryRun?: boolean; quality?: string; imageModel?: string; videoEngine?: string;
    };
    const shot = shotId ? db.getProductionShot(Number(shotId)) : null;
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });

    const opts: ShotOptions = {
      dryRun: Boolean(dryRun),
      quality: (quality === "quality" ? "quality" : quality === "lite" ? "lite" : "fast") as kie.VideoQuality,
      videoEngine: (videoEngine === "kling" || videoEngine === "seedance" ? videoEngine : "veo") as ShotOptions["videoEngine"],
      imageModel: (imageModel === "google/nano-banana" ? "google/nano-banana" : "nano-banana-2") as kie.ImageModel,
      keyframeOnly: Boolean(keyframeOnly),
      videoOnly: Boolean(videoOnly),
      notes: notes?.trim() || undefined,
    };

    running.add(id);
    (async () => {
      try {
        await processShot(production, shot.id, deps, opts);
      } catch (err) {
        db.updateProductionShot(shot.id, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        running.delete(id);
      }
    })();

    res.json({ ok: true });
  });

  // Duplicate a production as a fresh copy — same shot list, all shots reset to pending.
  // Used to start a real run after a dry-run rehearsal (dry-run clips are marked done and
  // would otherwise be skipped on resume).
  app.post("/api/productions/:id/duplicate", (req, res) => {
    const src = db.getProduction(Number(req.params.id));
    if (!src) return res.status(404).json({ error: "Production not found" });
    try {
      const copy = db.createProduction(`${src.title} (copy)`, src.project_id, src.product_image_filename);
      // Carry over reference assets + global style so a fresh run keeps the same look.
      db.updateProduction(copy.id, {
        music_filename: src.music_filename,
        product_image_url: src.product_image_url,
        hero_ref_filename: src.hero_ref_filename,
        hero_ref_url: src.hero_ref_url,
        style: src.style,
        style_ref_url: src.style_ref_url,
        platform: src.platform,
        aspect_ratio: src.aspect_ratio,
        content_style: src.content_style,
      });
      db.getProductionShots(src.id).forEach(s => {
        const copyShot = db.createProductionShot(copy.id, {
          shot_number: s.shot_number,
          description: s.description,
          image_prompt: s.image_prompt,
          video_prompt: s.video_prompt,
          camera_shot: s.camera_shot,
          duration_hint: s.duration_hint,
          label_visible: s.label_visible !== 0,
          scene_id: s.scene_id, // keep scene grouping so continuity (Fix 2/3) still works after duplicate
        });
        // Carry the creative/structural per-shot choices; run outputs (keyframes, last-frames) stay reset.
        db.updateProductionShot(copyShot.id, {
          is_still: s.is_still,
          use_character: s.use_character,
          bg_asset_id: s.bg_asset_id,
          ref_shot: s.ref_shot,
        });
      });
      res.json({ production: copy, shots: db.getProductionShots(copy.id) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Update a shot's scripted duration (honoured when assembling the final cut).
  app.post("/api/productions/:id/shot-duration", (req, res) => {
    const id = Number(req.params.id);
    const { shotId, duration } = req.body as { shotId?: number; duration?: string };
    const shot = shotId ? db.getProductionShot(Number(shotId)) : null;
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });
    db.updateProductionShot(shot.id, { duration_hint: (duration ?? "").trim() || null });
    res.json({ ok: true });
  });

  // Edit a shot's script text (description / image prompt / video prompt).
  app.post("/api/productions/:id/shot-edit", (req, res) => {
    const id = Number(req.params.id);
    const { shotId, description, image_prompt, video_prompt } = req.body as {
      shotId?: number; description?: string; image_prompt?: string; video_prompt?: string;
    };
    const shot = shotId ? db.getProductionShot(Number(shotId)) : null;
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });
    const fields: Record<string, unknown> = {};
    if (description !== undefined) fields.description = description;
    if (image_prompt !== undefined) fields.image_prompt = image_prompt;
    if (video_prompt !== undefined) fields.video_prompt = video_prompt;
    db.updateProductionShot(shot.id, fields);
    res.json({ ok: true });
  });

  // Insert a brand-new shot (e.g. an extra product demo) between existing ones. afterShotNumber
  // = 0 inserts at the very start. Renumbers everything after it, and fixes up any ref_shot
  // pointers so scene-continuity references still point at the correct (shifted) shot.
  app.post("/api/productions/:id/shots/insert", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    const { afterShotNumber, description, duration, labelVisible } = req.body as {
      afterShotNumber?: number; description?: string; duration?: string; labelVisible?: boolean;
    };
    if (!description?.trim()) return res.status(400).json({ error: "Missing description" });
    const after = Math.max(0, Number(afterShotNumber) || 0);
    const newNumber = after + 1;

    const shots = db.getProductionShots(id);
    // Shift everything at/after the new slot up by one — descending order so no intermediate
    // shot_number collides with one not yet moved (harmless here since there's no unique
    // constraint, but keeps the sequence sane to reason about).
    shots
      .filter(s => s.shot_number >= newNumber)
      .sort((a, b) => b.shot_number - a.shot_number)
      .forEach(s => db.updateProductionShot(s.id, { shot_number: s.shot_number + 1 }));
    // Any manual scene-continuity reference pointing at a shot that just shifted must shift too.
    shots.forEach(s => {
      if (s.ref_shot != null && s.ref_shot >= newNumber) {
        db.updateProductionShot(s.id, { ref_shot: s.ref_shot + 1 });
      }
    });

    const shot = db.createProductionShot(id, {
      shot_number: newNumber,
      description: description.trim(),
      duration_hint: duration?.trim() || null,
      label_visible: labelVisible ?? true,
    });
    res.json({ ok: true, shot, shots: db.getProductionShots(id) });
  });

  // Delete a shot. Renumbers everything after it down by one and clears/shifts any ref_shot
  // pointers so continuity references never dangle or point at the wrong shot.
  app.post("/api/productions/:id/shots/:shotId/delete", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    const shot = db.getProductionShot(Number(req.params.shotId));
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });

    const removedNumber = shot.shot_number;
    const shots = db.getProductionShots(id);
    db.deleteProductionShot(shot.id);
    shots.forEach(s => {
      if (s.id === shot.id) return;
      if (s.ref_shot === removedNumber) db.updateProductionShot(s.id, { ref_shot: null });
      else if (s.ref_shot != null && s.ref_shot > removedNumber) db.updateProductionShot(s.id, { ref_shot: s.ref_shot - 1 });
    });
    shots
      .filter(s => s.id !== shot.id && s.shot_number > removedNumber)
      .sort((a, b) => a.shot_number - b.shot_number)
      .forEach(s => db.updateProductionShot(s.id, { shot_number: s.shot_number - 1 }));
    res.json({ ok: true, shots: db.getProductionShots(id) });
  });

  // Toggle a shot as a still/freeze (holds the keyframe instead of animating with Veo).
  app.post("/api/productions/:id/shot-still", (req, res) => {
    const id = Number(req.params.id);
    const { shotId, isStill } = req.body as { shotId?: number; isStill?: boolean };
    const shot = shotId ? db.getProductionShot(Number(shotId)) : null;
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });
    db.updateProductionShot(shot.id, { is_still: isStill ? 1 : 0 });
    res.json({ ok: true });
  });

  // Set per-shot reference controls (character on/off, hero on/off, background pick).
  app.post("/api/productions/:id/shot-refs", (req, res) => {
    const id = Number(req.params.id);
    const { shotId, useCharacter, useHero, bgAssetId } = req.body as {
      shotId?: number; useCharacter?: boolean; useHero?: boolean; bgAssetId?: number | null;
    };
    const shot = shotId ? db.getProductionShot(Number(shotId)) : null;
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });
    const fields: Record<string, unknown> = {};
    if (useCharacter !== undefined) fields.use_character = useCharacter ? 1 : 0;
    if (useHero !== undefined) fields.label_visible = useHero ? 1 : 0; // hero gate reuses label_visible
    if (bgAssetId !== undefined) fields.bg_asset_id = bgAssetId ? Number(bgAssetId) : null;
    db.updateProductionShot(shot.id, fields);
    res.json({ ok: true });
  });

  // Set (or clear) which earlier shot's keyframe this shot carries in for scene continuity.
  app.post("/api/productions/:id/shot-ref", (req, res) => {
    const id = Number(req.params.id);
    const { shotId, refShot } = req.body as { shotId?: number; refShot?: number | null };
    const shot = shotId ? db.getProductionShot(Number(shotId)) : null;
    if (!shot || shot.production_id !== id) return res.status(400).json({ error: "Invalid shotId" });
    // 0 = explicit "no continuity" override (must be preserved, not coerced to null — a plain
    // truthy check would treat 0 as "unset"). A positive number must be an EARLIER shot (its
    // keyframe exists first in the keyframes stage). null/undefined = auto (pipeline decides).
    let ref: number | null;
    if (refShot === 0) ref = 0;
    else if (refShot != null && Number(refShot) < shot.shot_number) ref = Number(refShot);
    else ref = null;
    db.updateProductionShot(shot.id, { ref_shot: ref });
    res.json({ ok: true });
  });

  // Apply a saved library product as this production's hero reference.
  app.post("/api/productions/:id/apply-library-product", (req, res) => {
    const id = Number(req.params.id);
    if (!db.getProduction(id)) return res.status(404).json({ error: "Production not found" });
    const asset = req.body?.assetId ? db.getLibraryAsset(Number(req.body.assetId)) : null;
    if (!asset || asset.kind !== "product") return res.status(400).json({ error: "Invalid product assetId" });
    db.updateProduction(id, { hero_ref_filename: asset.filename, hero_ref_url: asset.url });
    res.json({ ok: true });
  });

  // Reveal the final video's folder in the OS file explorer.
  app.post("/api/productions/:id/reveal", (req, res) => {
    const production = db.getProduction(Number(req.params.id));
    if (!production?.final_video_filename) return res.status(400).json({ error: "No final video yet" });
    const abs = storage.resolveMediaPath(production.final_video_filename);
    if (!abs) return res.status(404).json({ error: "File not found on disk" });
    try {
      const dir = path.dirname(abs);
      if (process.platform === "win32") spawn("explorer", [dir], { detached: true });
      else if (process.platform === "darwin") spawn("open", [dir], { detached: true });
      else spawn("xdg-open", [dir], { detached: true });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Delete a production and its shots.
  app.delete("/api/productions/:id", (req, res) => {
    const id = Number(req.params.id);
    stopRequested.add(id);
    db.deleteProduction(id);
    res.json({ ok: true });
  });
}
