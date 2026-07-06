import "dotenv/config";
import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import * as kie from "../lib/kie";
import * as db from "../lib/db";
import * as storage from "../lib/storage";
import { registerProduceRoutes } from "./produce";
import { registerAssembleRoutes } from "./assemble";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.join(__dirname, "../dist")));
}

// ── Settings & Characters ─────────────────────────────────────────────────────

export interface Character { id: number; name: string; description: string; }
export interface Location { id: number; name: string; description: string; palette?: string; time_of_day?: string; key_props?: string; }

interface AppSettings {
  KIE_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  promptEngineer?: boolean;
  characters?: Character[];
  locations?: Location[];
}

const SETTINGS_FILE = path.join(__dirname, "../settings.json");

function loadSettings(): AppSettings {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}

function saveSettings(data: AppSettings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Merge saved API keys into process.env on startup
const boot = loadSettings();
if (boot.KIE_API_KEY) process.env.KIE_API_KEY = boot.KIE_API_KEY;
if (boot.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = boot.ANTHROPIC_API_KEY;

function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// Parse model JSON tolerantly: strip ```json fences and any preamble before the first bracket.
function parseModelJson(raw: string): unknown {
  let t = raw.trim();
  if (t.startsWith("```")) t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const firstArr = t.indexOf("[");
  const firstObj = t.indexOf("{");
  const start = firstArr === -1 ? firstObj : firstObj === -1 ? firstArr : Math.min(firstArr, firstObj);
  if (start > 0) t = t.slice(start);
  return JSON.parse(t);
}

function getCharacters(): Character[] {
  return loadSettings().characters ?? [];
}

function getLocations(): Location[] {
  return loadSettings().locations ?? [];
}

function isPromptEngineerEnabled(): boolean {
  return loadSettings().promptEngineer !== false;
}

// ── Prompt engineer ───────────────────────────────────────────────────────────

async function engineerPrompt(
  prompt: string,
  type: "image" | "video",
  characters: Character[],
  projectStyle: string,
  retryNotes?: string,
  locationContext?: string,
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY) return prompt;

  const charBlock = characters.length
    ? `\nRecurring subjects (describe explicitly — must be consistent across all shots):\n${characters.map(c => `- ${c.name}: ${c.description}`).join("\n")}`
    : "";

  const styleBlock = projectStyle ? `\nVisual style: ${projectStyle}` : "";
  const retryBlock = retryNotes ? `\nUser feedback on previous attempt: "${retryNotes}" — address this specifically.` : "";
  const locBlock = locationContext ? `\nEnvironment for this shot: ${locationContext}` : "";

  const system = type === "image"
    ? `You are a prompt engineer specialising in AI image generation (Nano Banana / Flux models).
Rewrite the given prompt to maximise cinematic quality and subject consistency.
Rules:
- If characters are listed, describe their appearance explicitly — never leave it ambiguous
- Add specific lighting quality (direction, colour temperature, softness)
- Add lens/depth-of-field feel (shallow DOF, bokeh, focal length) where appropriate
- Add mood and atmosphere descriptors at the end
- Keep under 200 words
- Output ONLY the rewritten prompt, no preamble or explanation${charBlock}${styleBlock}${locBlock}${retryBlock}`
    : `You are a prompt engineer specialising in Veo 3 AI video generation.
Rewrite the given prompt to maximise cinematic quality and motion coherence.
Rules:
- Lead with camera movement or subject action — Veo 3 reads the first clause as the primary motion instruction
- If characters are listed, describe their appearance explicitly in the first sentence
- Include lighting direction, atmosphere, and mood
- Specify the motion arc clearly (e.g. "camera slowly drifts left as subject turns toward lens, revealing…")
- End with a texture or atmosphere descriptor
- Keep under 150 words
- Output ONLY the rewritten prompt, no preamble${charBlock}${styleBlock}${locBlock}${retryBlock}`;

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 350,
      system,
      messages: [{ role: "user", content: `Original prompt:\n${prompt}` }],
    });
    return (msg.content[0] as { type: string; text: string }).text.trim();
  } catch {
    return prompt;
  }
}

// ── Settings API ──────────────────────────────────────────────────────────────

app.get("/api/settings", (_req, res) => {
  const s = loadSettings();
  res.json({
    KIE_API_KEY: process.env.KIE_API_KEY ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
    promptEngineer: s.promptEngineer !== false,
  });
});

app.post("/api/settings", (req, res) => {
  try {
    const { KIE_API_KEY, ANTHROPIC_API_KEY, promptEngineer } = req.body;
    const current = loadSettings();
    if (KIE_API_KEY !== undefined) { current.KIE_API_KEY = KIE_API_KEY; process.env.KIE_API_KEY = KIE_API_KEY; }
    if (ANTHROPIC_API_KEY !== undefined) { current.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = ANTHROPIC_API_KEY; }
    if (promptEngineer !== undefined) current.promptEngineer = Boolean(promptEngineer);
    saveSettings(current);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Characters API ────────────────────────────────────────────────────────────

app.get("/api/characters", (_req, res) => {
  res.json(getCharacters());
});

app.post("/api/characters", (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) return res.status(400).json({ error: "Missing name or description" });
  const current = loadSettings();
  const chars = current.characters ?? [];
  const char: Character = { id: Date.now(), name: name.trim(), description: description.trim() };
  chars.push(char);
  current.characters = chars;
  saveSettings(current);
  res.json(char);
});

app.delete("/api/characters", (req, res) => {
  const { id } = req.body;
  const current = loadSettings();
  current.characters = (current.characters ?? []).filter(c => c.id !== Number(id));
  saveSettings(current);
  res.json({ ok: true });
});

// ── Locations API (Fix 5) ─────────────────────────────────────────────────────

app.get("/api/locations", (_req, res) => {
  res.json(getLocations());
});

app.post("/api/locations", (req, res) => {
  const { name, description, palette, time_of_day, key_props } = req.body;
  if (!name || !description) return res.status(400).json({ error: "Missing name or description" });
  const current = loadSettings();
  const locs = current.locations ?? [];
  const loc: Location = { id: Date.now(), name: name.trim(), description: description.trim(), palette: palette?.trim() || undefined, time_of_day: time_of_day?.trim() || undefined, key_props: key_props?.trim() || undefined };
  locs.push(loc);
  current.locations = locs;
  saveSettings(current);
  res.json(loc);
});

app.delete("/api/locations", (req, res) => {
  const { id } = req.body;
  const current = loadSettings();
  current.locations = (current.locations ?? []).filter(l => l.id !== Number(id));
  saveSettings(current);
  res.json({ ok: true });
});

// ── Projects API ──────────────────────────────────────────────────────────────

app.get("/api/projects", (_req, res) => {
  res.json(db.listProjects());
});

app.post("/api/projects", (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Missing name" });
  res.json(db.createProject(name.trim()));
});

app.patch("/api/projects", (req, res) => {
  const { id, name } = req.body;
  if (!id || !name?.trim()) return res.status(400).json({ error: "Missing id or name" });
  db.renameProject(Number(id), name.trim());
  res.json({ ok: true });
});

app.delete("/api/projects", (req, res) => {
  db.deleteProject(Number(req.body.id));
  res.json({ ok: true });
});

app.post("/api/projects/character", (req, res) => {
  const { id, filename } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  db.setProjectCharacterImage(Number(id), filename ?? null);
  res.json({ ok: true });
});

// Remove character image from a project
app.post("/api/projects/remove-character", (req, res) => {
  const { projectId } = req.body;
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });
  db.setProjectCharacterImage(Number(projectId), null, null);
  res.json({ ok: true });
});

// Generate a character reference image for a project (no conversation needed)
app.post("/api/projects/generate-character", async (req, res) => {
  const { projectId, prompt, model, aspectRatio, resolution, imageUrl } = req.body;
  if (!projectId || !prompt) return res.status(400).json({ error: "Missing projectId or prompt" });
  try {
    let finalPrompt = prompt;
    if (isPromptEngineerEnabled()) {
      finalPrompt = await engineerPrompt(prompt, "image", [], "", "");
    }
    const imageModel = (model === "nano-banana-2" ? "nano-banana-2" : "google/nano-banana") as kie.ImageModel;
    const refUrls = imageUrl ? [imageUrl] : [];
    const { taskId } = await kie.createImageTask(finalPrompt, imageModel, refUrls, aspectRatio ?? "1:1", resolution);
    res.json({ taskId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Poll a character generation task — saves + sets character when done
app.get("/api/projects/poll-character", async (req, res) => {
  const { taskId, projectId } = req.query;
  if (!taskId || !projectId) return res.status(400).json({ error: "Missing taskId or projectId" });
  try {
    const result = await kie.pollImageTask(String(taskId));
    if (result.status === "success" && result.imageUrl) {
      const filename = await storage.saveImage(result.imageUrl, `char_${taskId}`, Number(projectId));
      db.setProjectCharacterImage(Number(projectId), filename, result.imageUrl);
      return res.json({ status: "done", filename, imageUrl: result.imageUrl });
    }
    if (result.status === "failed") return res.json({ status: "failed", error: result.errorMessage });
    res.json({ status: "pending" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Library assets (reusable cast & products) ─────────────────────────────────

app.get("/api/library-assets", (req, res) => {
  const kind = req.query.kind === "character" || req.query.kind === "product" ? req.query.kind : undefined;
  res.json(db.listLibraryAssets(kind as db.LibraryKind | undefined));
});

const LIBRARY_KINDS = ["character", "product", "background"];

// Save an already-generated image to the reusable library.
app.post("/api/library-assets", (req, res) => {
  const { kind, name, filename, url } = req.body as { kind?: string; name?: string; filename?: string; url?: string };
  if (!kind || !LIBRARY_KINDS.includes(kind)) return res.status(400).json({ error: "kind must be character|product|background" });
  if (!name?.trim()) return res.status(400).json({ error: "Missing name" });
  if (!url) return res.status(400).json({ error: "Asset has no fetchable URL — only kie-generated images can be reused" });
  res.json(db.createLibraryAsset(kind as db.LibraryKind, name.trim(), filename ?? null, url));
});

// Generate a new library asset (e.g. a background plate) via kie, then save it.
app.post("/api/library-assets/generate", async (req, res) => {
  const { kind, prompt } = req.body as { kind?: string; prompt?: string };
  if (!kind || !LIBRARY_KINDS.includes(kind)) return res.status(400).json({ error: "kind must be character|product|background" });
  if (!prompt?.trim()) return res.status(400).json({ error: "Missing prompt" });
  try {
    let finalPrompt = prompt;
    if (isPromptEngineerEnabled()) finalPrompt = await engineerPrompt(prompt, "image", [], "");
    const { taskId } = await kie.createImageTask(finalPrompt, "nano-banana-2", [], "16:9");
    res.json({ taskId });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Poll a library-asset generation; on success saves it and creates the library entry.
app.get("/api/library-assets/generate-poll", async (req, res) => {
  const { taskId, kind, name } = req.query;
  if (!taskId || !kind) return res.status(400).json({ error: "Missing taskId or kind" });
  try {
    const result = await kie.pollImageTask(String(taskId));
    if (result.status === "success" && result.imageUrl) {
      const filename = await storage.saveImage(result.imageUrl, `lib_${taskId}`, null);
      const asset = db.createLibraryAsset(String(kind) as db.LibraryKind, String(name || "Untitled").trim(), filename, result.imageUrl);
      return res.json({ status: "done", asset });
    }
    if (result.status === "failed") return res.json({ status: "failed", error: result.errorMessage });
    res.json({ status: "pending" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/library-assets", (req, res) => {
  db.deleteLibraryAsset(Number(req.body.id));
  res.json({ ok: true });
});

// Apply a saved library character to a project (reuses the same reference image — no regeneration).
app.post("/api/library-assets/apply-character", (req, res) => {
  const { assetId, projectId } = req.body as { assetId?: number; projectId?: number };
  const asset = assetId ? db.getLibraryAsset(Number(assetId)) : null;
  if (!asset || asset.kind !== "character") return res.status(400).json({ error: "Invalid character assetId" });
  if (!projectId) return res.status(400).json({ error: "Missing projectId" });
  db.setProjectCharacterImage(Number(projectId), asset.filename, asset.url);
  res.json({ ok: true });
});

// ── Conversations ─────────────────────────────────────────────────────────────

app.get("/api/conversations", (req, res) => {
  const { id, projectId } = req.query;
  if (id) return res.json(db.getMessages(Number(id)));
  const pid = projectId ? Number(projectId) : undefined;
  res.json(db.listConversations(pid));
});

app.post("/api/conversations", (req, res) => {
  const { title, projectId } = req.body;
  const conv = db.createConversation(title, projectId ? Number(projectId) : null);
  res.json(conv);
});

app.delete("/api/conversations", (req, res) => {
  db.deleteConversation(Number(req.body.id));
  res.json({ ok: true });
});

// ── Upload ────────────────────────────────────────────────────────────────────

app.post("/api/upload", upload.single("file"), async (req, res) => {
  const file = req.file;
  const conversationId = Number(req.body.conversationId);
  const projectId = req.body.projectId ? Number(req.body.projectId) : null;
  if (!file || !conversationId) return res.status(400).json({ error: "Missing file or conversationId" });

  const isVideo = file.mimetype.startsWith("video/");
  const filename = await storage.saveUpload(file.buffer, file.originalname, isVideo ? "videos" : "images", projectId);
  const message = db.insertMessage({
    conversation_id: conversationId, role: "user", text: null,
    media_type: isVideo ? "video" : "image", media_filename: filename,
    media_subtype: null, job_id: null, job_type: null, status: "done",
  });
  res.json(message);
});

// ── Generate image ────────────────────────────────────────────────────────────

app.post("/api/generate-image", async (req, res) => {
  const { conversationId, prompt, model, imageUrls, aspectRatio, shotStyle, projectStyle } = req.body;
  if (!conversationId || !prompt) return res.status(400).json({ error: "Missing fields" });

  db.insertMessage({
    conversation_id: conversationId, role: "user", text: prompt,
    media_type: null, media_filename: null, media_subtype: null,
    job_id: null, job_type: null, status: "done",
  });

  const existing = db.getMessages(conversationId);
  if (existing.length <= 1) db.updateConversationTitle(conversationId, prompt.slice(0, 60));

  try {
    // 1. Shot style prefix
    let finalPrompt = shotStyle ? `${shotStyle} photo. ${prompt}` : prompt;

    // 2. Prompt engineer (rewrites for cinematic quality + injects characters)
    if (isPromptEngineerEnabled()) {
      finalPrompt = await engineerPrompt(finalPrompt, "image", getCharacters(), projectStyle ?? "");
    } else if (getCharacters().length) {
      // Always inject characters even without full engineering
      const charBlock = getCharacters().map(c => `${c.name}: ${c.description}`).join(". ");
      finalPrompt = `${finalPrompt}. Subject reference: ${charBlock}`;
    }

    const { taskId } = await kie.createImageTask(finalPrompt, model ?? "google/nano-banana", imageUrls ?? [], aspectRatio ?? "1:1");
    const message = db.insertMessage({
      conversation_id: conversationId, role: "assistant", text: null,
      media_type: "image", media_filename: null, media_subtype: model ?? "google/nano-banana",
      job_id: taskId, job_type: "image", status: "pending",
    });
    res.json({ messageId: message.id, taskId });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Generate video ────────────────────────────────────────────────────────────

app.post("/api/generate-video", async (req, res) => {
  const { conversationId, prompt, imageUrls, mode, quality, cameraShot, videoLighting, projectStyle } = req.body;
  if (!conversationId || !prompt) return res.status(400).json({ error: "Missing fields" });

  db.insertMessage({
    conversation_id: conversationId, role: "user", text: prompt,
    media_type: null, media_filename: null, media_subtype: null,
    job_id: null, job_type: null, status: "done",
  });

  const existing = db.getMessages(conversationId);
  if (existing.length <= 1) db.updateConversationTitle(conversationId, prompt.slice(0, 60));

  // video mode determined by imageUrls presence

  const prefix = [cameraShot, videoLighting].filter(Boolean).join(", ");
  let finalPrompt = prefix ? `${prefix}. ${prompt}` : prompt;

  try {
    if (isPromptEngineerEnabled()) {
      finalPrompt = await engineerPrompt(finalPrompt, "video", getCharacters(), projectStyle ?? "");
    } else if (getCharacters().length) {
      const charBlock = getCharacters().map(c => `${c.name}: ${c.description}`).join(". ");
      finalPrompt = `${finalPrompt}. Subject: ${charBlock}`;
    }

    const { taskId } = await kie.createVideoTask(finalPrompt, imageUrls ?? [], quality ?? "fast");
    const message = db.insertMessage({
      conversation_id: conversationId, role: "assistant", text: null,
      media_type: "video", media_filename: null, media_subtype: quality ?? "fast",
      job_id: taskId, job_type: "video", status: "pending",
    });
    res.json({ messageId: message.id, taskId });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Retry generate (with notes) ───────────────────────────────────────────────

app.post("/api/generate-retry", async (req, res) => {
  const { conversationId, originalPrompt, retryNotes, type, model, aspectRatio, shotStyle, imageUrls, quality, cameraShot, videoLighting, projectStyle } = req.body;
  if (!conversationId || !originalPrompt || !type) return res.status(400).json({ error: "Missing fields" });

  try {
    // Rewrite prompt with retry notes regardless of engineer toggle (notes always need addressing)
    const engineered = await engineerPrompt(
      shotStyle ? `${shotStyle} photo. ${originalPrompt}` : originalPrompt,
      type,
      getCharacters(),
      projectStyle ?? "",
      retryNotes,
    );

    if (type === "image") {
      const { taskId } = await kie.createImageTask(engineered, model ?? "google/nano-banana", imageUrls ?? [], aspectRatio ?? "1:1");
      const message = db.insertMessage({
        conversation_id: conversationId, role: "assistant", text: null,
        media_type: "image", media_filename: null, media_subtype: model ?? "google/nano-banana",
        job_id: taskId, job_type: "image", status: "pending",
      });
      return res.json({ messageId: message.id, taskId });
    }

    if (type === "video") {
      const prefix = [cameraShot, videoLighting].filter(Boolean).join(", ");
      const finalPrompt = prefix ? `${prefix}. ${engineered}` : engineered;
      // video mode determined by imageUrls presence
      const { taskId } = await kie.createVideoTask(finalPrompt, imageUrls ?? [], quality ?? "fast");
      const message = db.insertMessage({
        conversation_id: conversationId, role: "assistant", text: null,
        media_type: "video", media_filename: null, media_subtype: quality ?? "fast",
        job_id: taskId, job_type: "video", status: "pending",
      });
      return res.json({ messageId: message.id, taskId });
    }

    res.status(400).json({ error: "Unknown type" });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Poll ──────────────────────────────────────────────────────────────────────

app.get("/api/poll", async (req, res) => {
  const messageId = Number(req.query.messageId);
  if (!messageId) return res.status(400).json({ error: "Missing messageId" });

  const msg = db.getMessage(messageId);
  if (!msg) return res.status(404).json({ error: "Not found" });
  if (msg.status !== "pending") return res.json({ ...msg, resolved: true });

  // Resolve project for this message's conversation
  const conv = db.getConversation(msg.conversation_id);
  const projectId = conv?.project_id ?? null;

  try {
    if (msg.job_type === "image") {
      const result = await kie.pollImageTask(msg.job_id!);
      if (result.status === "success" && result.imageUrl) {
        const filename = await storage.saveImage(result.imageUrl, `img_${msg.job_id}`, projectId);
        db.updateMessageJob(messageId, { status: "done", media_filename: filename, media_type: "image" });
        return res.json({ ...db.getMessage(messageId), resolved: true });
      }
      if (result.status === "failed") {
        db.updateMessageJob(messageId, { status: "failed" });
        return res.json({ ...db.getMessage(messageId), resolved: true });
      }
    }
    if (msg.job_type === "video") {
      const result = await kie.pollVideoTask(msg.job_id!);
      if (result.status === "success" && result.videoUrl) {
        const filename = await storage.saveVideo(result.videoUrl, `vid_${msg.job_id}`, projectId);
        db.updateMessageJob(messageId, { status: "done", media_filename: filename, media_type: "video" });
        return res.json({ ...db.getMessage(messageId), resolved: true });
      }
      if (result.status === "failed") {
        db.updateMessageJob(messageId, { status: "failed" });
        return res.json({ ...db.getMessage(messageId), resolved: true });
      }
    }
  } catch (err) {
    console.error("Poll error:", err);
  }
  res.json({ ...msg, resolved: false });
});

// ── Media serve ───────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
};

// Serves any relative path from MEDIA_ROOT — handles both legacy and project-scoped paths
app.get("/api/media/*", (req, res) => {
  const relPath = (req.params as Record<string, string>)[0];
  const filePath = storage.resolveMediaPath(relPath);
  if (!filePath) return res.status(404).send("Not found");
  res.setHeader("Content-Type", MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
  res.sendFile(filePath);
});

// ── Library ───────────────────────────────────────────────────────────────────

app.get("/api/library", (req, res) => {
  const projectId = req.query.projectId ? Number(req.query.projectId) : null;

  function readDir(dir: string, type: "image" | "video", relBase: string) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => !f.startsWith(".") && fs.statSync(path.join(dir, f)).isFile())
      .map(filename => {
        const stat = fs.statSync(path.join(dir, filename));
        return {
          filename: `${relBase}/${filename}`,  // relative path for /api/media/
          basename: filename,
          type,
          size: stat.size,
          created_at: stat.birthtime.toISOString(),
        };
      })
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  if (projectId) {
    const projectsRoot = path.join(storage.MEDIA_ROOT, "projects", String(projectId));
    res.json({
      images: readDir(path.join(projectsRoot, "images"), "image", `projects/${projectId}/images`),
      videos: readDir(path.join(projectsRoot, "videos"), "video", `projects/${projectId}/videos`),
    });
  } else {
    // Uncategorised: legacy flat dirs
    res.json({
      images: readDir(storage.IMAGES_DIR, "image", "images"),
      videos: readDir(storage.VIDEOS_DIR, "video", "videos"),
    });
  }
});

// ── Export ────────────────────────────────────────────────────────────────────

app.get("/api/export", (req, res) => {
  const conversationId = Number(req.query.conversationId);
  if (!conversationId) return res.status(400).json({ error: "Missing conversationId" });

  const messages = db.getMessages(conversationId);
  const lines: string[] = [
    `EDIT LIST`,
    `Conversation ID: ${conversationId}`,
    `Exported: ${new Date().toISOString().slice(0, 10)}`,
    ``,
  ];

  let shotNum = 0;
  messages.forEach(m => {
    if (m.role === "assistant" && m.status === "done" && m.media_filename) {
      shotNum++;
      const type = m.media_type === "video" ? "VIDEO" : "IMAGE";
      lines.push(`${String(shotNum).padStart(2, "0")} | ${type} | ${m.media_filename} | ${m.media_subtype ?? ""}`);
    }
  });

  if (shotNum === 0) lines.push("No completed media in this conversation.");

  res.setHeader("Content-Type", "text/plain");
  res.setHeader("Content-Disposition", `attachment; filename="edit-list-${conversationId}.txt"`);
  res.send(lines.join("\n"));
});

// ── Script writer: ideas ──────────────────────────────────────────────────────

app.post("/api/script/ideas", async (req, res) => {
  const { concept, brand, tone, duration, audience } = req.body;
  if (!concept) return res.status(400).json({ error: "Missing concept" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const userPrompt = [
    `Concept: ${concept}`,
    brand ? `Brand / product: ${brand}` : null,
    tone ? `Tone: ${tone}` : null,
    duration ? `Target duration: ${duration}` : null,
    audience ? `Target audience: ${audience}` : null,
  ].filter(Boolean).join("\n");

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1500,
      system: `You are a creative director specialising in short-form video advertising (social media, brand films, product launches).
Generate exactly 3 distinct video concepts. Each must have genuine creative differentiation — not just variations of the same idea.
Return a JSON array of 3 objects with this exact shape:
{
  "hook": "Compelling title AND opening visual/line that stops the scroll (2 sentences max)",
  "flow": ["beat 1", "beat 2", "beat 3", "beat 4", "beat 5"],
  "payoff": "The final reveal, emotional climax, or memorable closing moment (2 sentences max)"
}
Rules:
- The hook must earn attention in under 3 seconds
- Flow beats should be specific actions/visuals, not vague directions
- The payoff must feel earned — not just a logo slam
- Each idea must have a different emotional register (e.g. one aspirational, one humorous, one visceral)
Output ONLY valid JSON. No preamble, no markdown code fences.`,
      messages: [{ role: "user", content: userPrompt }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    res.json({ ideas: JSON.parse(raw) });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Script writer: breakdown ──────────────────────────────────────────────────

app.post("/api/script/breakdown", async (req, res) => {
  const { idea, brand, tone, visualStyle, screenDirection, mode, duration } = req.body;
  if (!idea) return res.status(400).json({ error: "Missing idea" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const productMode = mode === "product";

  // Target runtime drives shot count + per-shot durations so they sum to the target.
  const lengthRule = duration
    ? `- TARGET RUNTIME ≈ ${duration}. Choose the number of shots and each shot's "duration" so the durations SUM to approximately this total (within ±15%). Guide: ~15s → 4–6 shots, ~30s → 6–9, ~60s → 9–14. Keep individual shots roughly 1–4s. Fewer, well-chosen shots beat cramming.`
    : `- 6 to 10 shots`;

  const characters = getCharacters();
  const charBlock = characters.length
    ? `\nCharacter bible (use these descriptions consistently in every image_prompt):\n${characters.map(c => `- ${c.name}: ${c.description}`).join("\n")}`
    : "";

  const context = [
    brand ? `Brand: ${brand}` : null,
    tone ? `Tone: ${tone}` : null,
    visualStyle ? `Visual style: ${visualStyle}` : null,
    screenDirection ? `Screen direction: ${screenDirection}` : null,
    productMode ? `Mode: product advertisement` : null,
  ].filter(Boolean).join(" | ");

  const productGuidance = productMode
    ? `
This is a PRODUCT ADVERTISEMENT. Apply drink-ad / commercial craft:
- Use macro detail, splash, condensation, and studio lighting where they sell texture and desirability
- The product is the hero — feature it clearly and keep its label readable in hero shots
- The FINAL shot MUST be a clean product hero (product centred, label sharp and facing camera, on brand)
- Set "label_visible": true on any shot where the product label should read clearly, false otherwise`
    : "";

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      system: `You are a cinematographer and storyboard artist breaking a video concept into individual shots.
${context ? `Context: ${context}` : ""}${charBlock}${productGuidance}
Return a JSON array of shot objects. Each shot:
{
  "shot_number": 1,
  "scene_id": "kitchen",
  "duration": "3s",
  "description": "What physically happens in this shot",
  "image_prompt": "Nano Banana compatible still-frame prompt. Describe subject (using character bible if provided), composition, lighting, mood. No camera model names.",
  "video_prompt": "Veo-compatible motion-first prompt: LEAD with the single camera move or subject action, then the scene. One motion only. No camera model names.",
  "camera_shot": "e.g. Wide shot / Close-up / Extreme close-up / Aerial",
  "lighting": "e.g. Golden hour / Studio / Neon",
  "label_visible": true,
  "director_note": "Continuity or action note for the editor"
}
Rules:
${lengthRule}
- scene_id: a short kebab-case name for the location/set (e.g. "kitchen", "city-street", "studio"). Shots that share the same physical location get the same scene_id.
- Open on an establishing or hero shot; ${productMode ? "end on a clean product / CTA hero shot" : "end on the payoff moment"}
- Vary shot sizes in a deliberate rhythm (wide / medium / close) — no two adjacent shots the same size
- Keep consistent screen direction across cuts; maintain the 180-degree rule
- Exactly one motion per shot — video_prompt must describe a single camera move or action, never two
- image_prompt must be vivid and self-contained; video_prompt must be motion-first
- director_note should flag cut-on-action opportunities, eyeline matches, or continuity risks
Output ONLY valid JSON array. No preamble, no markdown.`,
      messages: [{
        role: "user",
        content: `Hook: ${idea.hook}\n\nFlow:\n${idea.flow.map((b: string, i: number) => `${i + 1}. ${b}`).join("\n")}\n\nPayoff: ${idea.payoff}`,
      }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    res.json({ shots: parseModelJson(raw) });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Script writer: B-roll ─────────────────────────────────────────────────────

app.post("/api/script/broll", async (req, res) => {
  const { shots, brand, tone } = req.body;
  if (!shots?.length) return res.status(400).json({ error: "Missing shots" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const characters = getCharacters();
  const charBlock = characters.length
    ? `\nCharacter bible: ${characters.map(c => `${c.name}: ${c.description}`).join("; ")}`
    : "";

  const shotSummary = shots.map((s: { shot_number: number; camera_shot: string; description: string }) =>
    `Shot ${s.shot_number} (${s.camera_shot}): ${s.description}`
  ).join("\n");

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1500,
      system: `You are a cinematographer suggesting B-roll and cutaway shots to enrich a video edit.
For each main shot pair that would benefit from a cutaway, suggest 1-2 B-roll shots.
Each B-roll shot should add texture, context, or emotion without interrupting narrative flow.${charBlock}

Return a JSON array of B-roll suggestions:
{
  "after_shot": 2,
  "type": "cutaway" | "detail" | "reaction" | "environmental",
  "description": "What the shot shows",
  "image_prompt": "Nano Banana compatible still-frame prompt",
  "duration": "1s",
  "purpose": "Why this B-roll improves the edit"
}
Suggest 3-6 total. Output ONLY valid JSON array. No preamble.`,
      messages: [{
        role: "user",
        content: `Brand: ${brand ?? "Unspecified"}\nTone: ${tone ?? "Unspecified"}\n\nMain shot list:\n${shotSummary}`,
      }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    res.json({ broll: JSON.parse(raw) });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Director: outline ─────────────────────────────────────────────────────────

app.post("/api/script/outline", async (req, res) => {
  const { shots, projectSettings } = req.body;
  if (!shots?.length) return res.status(400).json({ error: "Missing shots" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const shotSummary = shots.map((s: { shot_number: number; camera_shot: string; duration: string; description: string }) =>
    `Shot ${s.shot_number} (${s.camera_shot}, ${s.duration}): ${s.description}`
  ).join("\n");

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 1200,
      system: `You are a film director reviewing a shot list for continuity and cinematic logic.
Return a JSON object:
{
  "synopsis": "One sentence describing the overall arc",
  "rhythm": "Brief pacing note",
  "shots": [
    {
      "shot_number": 1,
      "screen_direction": "left-to-right" | "right-to-left" | "towards-camera" | "away-from-camera" | "neutral",
      "shot_size": "extreme-wide" | "wide" | "medium-wide" | "medium" | "medium-close" | "close-up" | "extreme-close-up",
      "continuity_note": "One line or null",
      "warning": "One line continuity risk or null"
    }
  ]
}
Output ONLY valid JSON. No preamble.`,
      messages: [{
        role: "user",
        content: `Project: ${projectSettings?.name ?? "Untitled"}\nVisual style: ${projectSettings?.visualStyle ?? ""}\nScreen direction: ${projectSettings?.screenDirection ?? "Not established"}\n\nShot list:\n${shotSummary}`,
      }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    res.json(JSON.parse(raw));
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Director: review frame ────────────────────────────────────────────────────

app.post("/api/director/review-frame", async (req, res) => {
  const { shot, previousShot, nextShot, originalPrompt, projectSettings } = req.body;
  if (!shot || !originalPrompt) return res.status(400).json({ error: "Missing shot or prompt" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const characters = getCharacters();
  const charBlock = characters.length
    ? `\nCharacter bible: ${characters.map(c => `${c.name}: ${c.description}`).join("; ")}`
    : "";

  const context = [
    `Project: ${projectSettings?.name ?? "Untitled"}`,
    `Visual style: ${projectSettings?.visualStyle ?? ""}`,
    `Screen direction: ${projectSettings?.screenDirection ?? "Not established"}`,
    `Colour mood: ${projectSettings?.colourMood ?? ""}`,
    previousShot ? `\nPREVIOUS SHOT (${previousShot.camera_shot}): ${previousShot.description}` : "\nThis is the OPENING shot.",
    `\nCURRENT SHOT ${shot.shot_number} (${shot.camera_shot}, ${shot.duration}): ${shot.description}`,
    nextShot ? `\nNEXT SHOT (${nextShot.camera_shot}): ${nextShot.description}` : "\nThis is the CLOSING shot.",
  ].join("\n");

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 400,
      system: `You are a cinematographer and storyboard artist. Rewrite still-frame image prompts for video continuity.
Rewrite to explicitly specify:
1. Subject position in frame (left/centre/right third) matching screen direction
2. Eyeline direction and height
3. Negative space side (for motion to move into)
4. Lighting direction matching colour mood
5. Any compositional detail for the cut${charBlock}
Output ONLY the rewritten prompt — 2-4 sentences, no preamble.`,
      messages: [{
        role: "user",
        content: `${context}\n\nORIGINAL PROMPT:\n${originalPrompt}`,
      }],
    });

    res.json({ refined: (msg.content[0] as { type: string; text: string }).text.trim() });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Director: shot continuity ─────────────────────────────────────────────────

const DIRECTOR_SYSTEM = `You are an AI film director specialising in cinematic advertising.
Maintain strict continuity: 180° rule, logical shot size progression, screen direction matching, eyeline matching, cut on action, consistent colour mood.
Output every shot description as a single Veo-compatible prompt: action-first, specific, 2-4 sentences. No camera model names.`;

app.post("/api/director", async (req, res) => {
  const { projectSettings, lastShot, nextImageUrl, userIntent } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const characters = getCharacters();
  const charBlock = characters.length
    ? `\nCharacter bible: ${characters.map(c => `${c.name}: ${c.description}`).join("; ")}`
    : "";

  const contextLines = [
    `Project: ${projectSettings?.name ?? "Untitled"}`,
    `Visual style: ${projectSettings?.visualStyle ?? "Not specified"}`,
    `Screen direction: ${projectSettings?.screenDirection ?? "Not specified"}`,
    `Colour mood: ${projectSettings?.colourMood ?? "Not specified"}`,
    charBlock,
    lastShot?.prompt ? `\nLast shot: "${lastShot.prompt}"` : "\nThis is the opening shot.",
    lastShot?.cameraShot ? `Last framing: ${lastShot.cameraShot}` : null,
    userIntent ? `\nDirector intent: ${userIntent}` : null,
  ].filter(Boolean).join("\n");

  type ContentBlock = { type: "text"; text: string } | { type: "image"; source: { type: "url"; url: string } };
  const content: ContentBlock[] = [{ type: "text", text: contextLines }];

  if (nextImageUrl) {
    try {
      const imgRes = await fetch(`http://localhost:3460${nextImageUrl}`);
      const b64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");
      const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
      content.push({ type: "image", source: { type: "base64", mediaType: mimeType, data: b64 } as never });
      content.push({ type: "text", text: "Reference image for next shot. Analyse subject position, eyeline, lighting, screen placement." });
    } catch {}
  }

  content.push({ type: "text", text: "Generate a single Veo-compatible shot prompt maintaining perfect continuity. Output only the prompt." });

  try {
    const message = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 300,
      system: DIRECTOR_SYSTEM,
      messages: [{ role: "user", content: content as never }],
    });
    res.json({ prompt: (message.content[0] as { type: string; text: string }).text.trim() });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── Produce pipeline (batch productions, product mode, assembly) ──────────────

// Style reference image (Fix 7) — sets visual tone, passed to every keyframe prompt.
app.post("/api/productions/:id/style-ref", upload.single("file"), async (req, res) => {
  const id = Number(req.params.id);
  const production = db.getProduction(id);
  if (!production) return res.status(404).json({ error: "Production not found" });
  const file = (req as unknown as { file?: { buffer: Buffer; originalname: string; mimetype?: string } }).file;
  if (!file) return res.status(400).json({ error: "Missing file" });
  try {
    const mime = file.mimetype || "image/png";
    const ext = (file.originalname.match(/\.[a-z0-9]+$/i)?.[0]) || ".png";
    const name = `styleref_${Date.now()}${ext}`;
    const url = await kie.uploadImageBase64(`data:${mime};base64,${file.buffer.toString("base64")}`, name);
    db.updateProduction(id, { style_ref_url: url });
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Visual audit (Fix 6) — sends all keyframes to Claude vision; flags inconsistencies per shot.
app.post("/api/productions/:id/audit", async (req, res) => {
  const id = Number(req.params.id);
  const production = db.getProduction(id);
  if (!production) return res.status(404).json({ error: "Production not found" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const shots = db.getProductionShots(id).filter(s => s.keyframe_filename);
  if (shots.length === 0) return res.status(400).json({ error: "No keyframes yet — run keyframes stage first" });

  // Build a multi-image message: text label + base64 image per shot.
  const imageContents: unknown[] = [];
  for (const shot of shots) {
    const absPath = storage.resolveMediaPath(shot.keyframe_filename!);
    if (!absPath || !fs.existsSync(absPath)) continue;
    const b64 = fs.readFileSync(absPath).toString("base64");
    const ext = path.extname(shot.keyframe_filename!).slice(1).toLowerCase() || "png";
    const mediaType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
    imageContents.push({ type: "text", text: `Shot ${shot.shot_number}${shot.scene_id ? ` (scene: ${shot.scene_id})` : ""}${shot.description ? `: ${shot.description}` : ""}` });
    imageContents.push({ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } });
  }

  if (imageContents.length === 0) return res.status(400).json({ error: "No accessible keyframe files" });

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      system: `You are a visual continuity supervisor reviewing AI-generated keyframes for a video production.
Examine the keyframes in shot order and identify inconsistencies between shots that would look jarring in the final cut.
Focus on: costume/wardrobe changes, lighting direction flips, colour temperature shifts, prop changes, skin tone drift, hair/makeup changes, background continuity.
For each problem you find, return one entry. If a shot is consistent, do NOT include it.
Return a JSON array:
[
  {
    "shot_number": 3,
    "issue": "One-line description of the inconsistency",
    "suggestion": "One-line suggested fix to include in the retry prompt"
  }
]
Output ONLY valid JSON array. No preamble.`,
      messages: [{ role: "user", content: imageContents as Anthropic.MessageParam["content"] }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    const issues = parseModelJson(raw) as Array<{ shot_number: number; issue: string; suggestion: string }>;

    // Persist audit notes on each flagged shot.
    for (const issue of issues) {
      const shot = shots.find(s => s.shot_number === issue.shot_number);
      if (shot) {
        db.updateProductionShot(shot.id, { audit_notes: `${issue.issue} — Suggested fix: ${issue.suggestion}` });
      }
    }

    res.json({ issues });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Batch prompt engineering (Fix 4a) — engineers all pending shot prompts in one Claude call
// so wording stays coherent across shots instead of drifting per-call.
app.post("/api/productions/:id/engineer-prompts", async (req, res) => {
  const id = Number(req.params.id);
  const production = db.getProduction(id);
  if (!production) return res.status(404).json({ error: "Production not found" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: "ANTHROPIC_API_KEY not set" });

  const allShots = db.getProductionShots(id);
  // Default: only re-engineer shots that haven't been generated yet; `all` flag re-engineers everything.
  const targetShots = req.body?.all
    ? allShots
    : allShots.filter(s => !s.keyframe_filename && s.status !== "skipped");

  if (targetShots.length === 0) return res.json({ updated: 0 });

  const characters = getCharacters();
  const locations = getLocations();
  const style = production.style ?? "";
  const charBlock = characters.length
    ? `\nCharacter bible (use these descriptions consistently across ALL shots):\n${characters.map(c => `- ${c.name}: ${c.description}`).join("\n")}`
    : "";
  const locBlock = locations.length
    ? `\nLocation bible:\n${locations.map(l => {
        const parts = [l.description];
        if (l.palette) parts.push(`palette: ${l.palette}`);
        if (l.time_of_day) parts.push(`time: ${l.time_of_day}`);
        if (l.key_props) parts.push(`props: ${l.key_props}`);
        return `- ${l.name}: ${parts.join(", ")}`;
      }).join("\n")}`
    : "";
  const styleBlock = style ? `\nGlobal visual style (apply to every shot): ${style}` : "";

  const shotList = targetShots.map(s => JSON.stringify({
    shot_number: s.shot_number,
    scene_id: s.scene_id ?? undefined,
    description: s.description,
    image_prompt: s.image_prompt,
    video_prompt: s.video_prompt,
    camera_shot: s.camera_shot,
  })).join("\n");

  try {
    const msg = await getAnthropic().messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8000,
      system: `You are a prompt engineer rewriting a shot list for AI image + video generation.
Rewrite EVERY shot's image_prompt and video_prompt so the wording is consistent across shots (same character vocabulary, same lighting language, same atmosphere tone).${charBlock}${locBlock}${styleBlock}

Rules:
- image_prompt: vivid still-frame description, under 200 words, no camera model names
- video_prompt: motion-first (lead with camera move or subject action), under 150 words, no camera model names
- Do NOT change shot_number, scene_id, description, or camera_shot
- Keep all shots in the same JSON array — one entry per shot
Return a JSON array of objects with keys: shot_number, image_prompt, video_prompt.
Output ONLY valid JSON array. No preamble.`,
      messages: [{ role: "user", content: `Shot list:\n${shotList}` }],
    });

    const raw = (msg.content[0] as { type: string; text: string }).text.trim();
    const rewrites = parseModelJson(raw) as Array<{ shot_number: number; image_prompt: string; video_prompt: string }>;

    let updated = 0;
    for (const r of rewrites) {
      const shot = targetShots.find(s => s.shot_number === r.shot_number);
      if (shot && (r.image_prompt || r.video_prompt)) {
        db.updateProductionShot(shot.id, {
          image_prompt: r.image_prompt || shot.image_prompt,
          video_prompt: r.video_prompt || shot.video_prompt,
        });
        updated++;
      }
    }

    res.json({ updated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

registerProduceRoutes(app, upload, {
  getCharacters,
  getLocations,
  isPromptEngineerEnabled,
  engineerPrompt,
});
registerAssembleRoutes(app, upload);

// ── Global error handler (always returns JSON, never HTML) ────────────────────

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = 3460;
app.listen(PORT, () => console.log(`Kie Studio server on http://localhost:${PORT}`));
