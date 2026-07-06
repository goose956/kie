# Kie Studio — "Produce" Pipeline Implementation Plan

Goal: extend Kie Studio from a per-shot chat tool into a batch video production
pipeline — shot list in, finished MP4 out — with a product-ad mode. Written by a
planning session on 2026-07-05; intended to be executed by a fresh Claude Code
session (any capable model) with this file as the spec.

## Context for the implementing session

- Electron + Vite/React app; Express backend in `server/index.ts` spawned by
  `electron/main.cjs`. Read both before starting.
- kie.ai client in `lib/kie.ts`: `createImageTask`/`pollImageTask` (Nano Banana)
  and `createVideoTask`/`pollVideoTask` (Veo 3). All jobs async task-id + poll.
- SQLite via `lib/db.ts` (projects, conversations, messages with job columns);
  media saved under `MEDIA_ROOT` by `lib/storage.ts`, served at `/api/media/*`.
- Script Writer already produces shot lists: `/api/script/breakdown` returns
  shots with `shot_number`, `camera_shot`, `description`, `image_prompt`.
- Claude calls: prompt-engineer uses `claude-haiku-4-5-20251001`; script writer
  uses `claude-opus-4-8`. Keep those models as-is.
- Frontend components: `src/components/Chat.tsx`, `ScriptWriter.tsx`,
  `DirectorPanel.tsx`, `Settings.tsx`.

Guardrails: match existing code style (plain Express handlers, no new
frameworks). Don't refactor working code beyond what the features need. Verify
with `npx vite build` and `node --check electron/main.cjs` (server is TS run via
tsx — `npx tsc --noEmit` for it). No new subscriptions/services — kie.ai only.

## Phase 1 — batch Produce + product mode + assembly

### 1. Productions data model (`lib/db.ts`)

New table `productions`: id, project_id, title, status
(`draft|producing|review|assembling|done|failed`), music_filename (nullable),
product_image_filename (nullable), created_at. New table `production_shots`:
id, production_id, shot_number, description, image_prompt, video_prompt
(nullable — derive from description + camera_shot if absent), camera_shot,
duration_hint, status (`pending|keyframe|keyframe_done|video|video_done|failed|skipped`),
keyframe_filename, keyframe_task_id, video_filename, video_task_id, error,
take_count. CRUD functions following the existing patterns in db.ts.

### 2. Produce orchestrator (`server/produce.ts`, wired into `server/index.ts`)

Endpoints:
- `POST /api/productions` — create from a Script Writer breakdown (accepts the
  shots array) or empty draft.
- `POST /api/productions/:id/produce` — starts the run. Sequential loop (one
  shot at a time is fine — simplicity over speed; kie tasks are the slow part):
  for each pending shot: (a) build keyframe prompt = image_prompt + project
  style block + character bible block (reuse the exact composition logic already
  in `/api/generate-image`) + product-mode block (see §4); (b) createImageTask →
  poll to completion → save keyframe; (c) createVideoTask with keyframe as
  reference image, prompt = motion-first video prompt → poll → save clip;
  update shot status at every transition.
- `GET /api/productions/:id` — full state for UI polling (the frontend polls
  this every 4s like the existing `/api/poll` pattern; no websockets).
- `POST /api/productions/:id/retry-shot` — regenerate one shot (optionally
  keyframe-only or video-only, with optional user notes appended to the prompt).
- `POST /api/productions/:id/stop` — graceful stop after current shot.

Resilience: one shot failing marks that shot `failed` and continues; the run
never dies mid-list. Persist state in SQLite so an app restart doesn't lose a
half-finished production.

### 3. Assembly (`server/assemble.ts`)

- Add `ffmpeg-static` dependency.
- `POST /api/productions/:id/assemble` — concat all `video_done` clips in
  shot_number order (re-encode to a common format rather than stream-copy, so
  mixed sources don't break: h264, yuv420p, keep source resolution of first
  clip, scale/pad others to match). Optional music: if music_filename set, mix
  under the concat at reduced volume (video models' native audio kept on top),
  or replace audio entirely if a `musicOnly` flag is passed. Output MP4 to the
  production's media folder; store filename on the production row.
- `POST /api/productions/:id/music` — upload endpoint for a music file (reuse
  multer setup).

### 4. Product mode

- Production accepts an uploaded product image (`product_image_filename`).
- When set, every keyframe generation includes the product image as the FIRST
  reference image, and the keyframe prompt is appended with a fixed block:
  product must appear exactly as in the reference — label text, colours,
  proportions unchanged; label large, sharp, facing camera unless the shot
  says otherwise.
- Video prompts for shots flagged label-visible get: moderate camera motion,
  no full orbit, product remains in frame. Add a boolean `label_visible` per
  shot (default true in product mode) that gates this block.

### 5. Shot-grammar rules (prompt edits in `server/index.ts` script routes)

Extend the `/api/script/breakdown` system prompt so generated shot lists:
vary shot sizes (wide/medium/close in deliberate rhythm), keep consistent
screen direction, one motion per shot, open on an establishing or hero shot,
end on product/CTA shot when in product mode, and include a `video_prompt`
field per shot (motion-first phrasing for Veo). Add an optional `mode:
"product"` param that adds drink-ad-style guidance (macro, splash, condensation,
studio lighting) and requires the final shot to be a clean product hero.

### 6. UI (`src/components/ProducePanel.tsx`, new)

- Entry points: "Produce this script" button in ScriptWriter (passes breakdown
  straight in), and a Productions list (per project).
- Panel shows: product image slot (product mode), music slot, shot table with
  per-shot status chips + thumbnails (keyframe then clip preview), retry button
  per shot, overall progress, Produce / Stop / Assemble buttons, final video
  player + "open folder" when done.
- Polls `GET /api/productions/:id` every 4s while status is active. Follow the
  existing Tailwind styling conventions in Chat.tsx.

### Acceptance criteria (Phase 1)

1. From ScriptWriter: generate a 6-shot breakdown → click Produce → all shots
   run keyframe→video unattended → Assemble → playable MP4 in the app and on
   disk under MEDIA_ROOT.
2. Product mode: upload a product photo → keyframes visibly contain that
   product → final ad assembles.
3. Kill the app mid-run, relaunch → production state intact, can resume
   remaining shots (a fresh `produce` call skips completed shots).
4. One deliberately bad shot (force an error) doesn't abort the run.
5. `npx vite build` and `npx tsc --noEmit` pass.

## Phase 2 (do NOT build unless asked)

- Model dropdown: add Sora 2 / Kling 3.0 via kie.ai's endpoints for those
  model families in `lib/kie.ts` (same createTask/poll shape, different paths —
  check kie.ai docs for exact routes); per-shot model override in the shot table
  (cheap model for drafts, Veo quality for hero shots).
- Director gating: before video generation, send each keyframe through the
  existing `/api/director/review-frame`; auto-regenerate once if the review
  fails, then flag for manual review instead of spending video credits.
- Suno music generation via kie.ai instead of manual upload.

## Notes for the implementing session

- Test with cheap settings first (Nano Banana 1K images, Veo fast) — real
  generations cost real money; add a `dryRun` flag to the orchestrator that
  fakes task completion with placeholder files so the loop + UI + assembly can
  be tested without spending kie.ai credits. Test ffmpeg assembly with any two
  local MP4s.
- Poll kie.ai every 4-5s per the existing pattern; don't tighten it.
- API keys live in `settings.json` (project root) — already loaded by the
  server; nothing to add.
