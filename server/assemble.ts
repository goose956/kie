import { spawn } from "child_process";
import fs from "fs";
import ffmpegPath from "ffmpeg-static";
import type { Express } from "express";
import type { Multer } from "multer";
import * as db from "../lib/db";
import * as storage from "../lib/storage";

// ffmpeg-static exports the binary path (or null if unavailable on this platform).
const FFMPEG = (ffmpegPath as unknown as string) || "ffmpeg";

// ── ffmpeg helpers ────────────────────────────────────────────────────────────

// Run ffmpeg; resolve on exit code 0, reject with the tail of stderr otherwise.
export function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

// Probe a clip's resolution by parsing `ffmpeg -i` stderr (avoids a separate ffprobe dependency).
function probeResolution(absPath: string): Promise<{ width: number; height: number }> {
  return new Promise(resolve => {
    const proc = spawn(FFMPEG, ["-i", absPath], { windowsHide: true });
    let stderr = "";
    proc.stderr.on("data", d => { stderr += d.toString(); });
    const done = () => {
      // First Video stream line contains e.g. "1280x720"
      const m = stderr.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      if (m) resolve({ width: Number(m[1]), height: Number(m[2]) });
      else resolve({ width: 1280, height: 720 });
    };
    proc.on("error", done);
    proc.on("close", done);
  });
}

// Parse a scripted duration hint ("3s", "2 sec", "1.5") into seconds.
function parseSeconds(hint: string | null): number | null {
  if (!hint) return null;
  const m = hint.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

// ── Assembly ──────────────────────────────────────────────────────────────────

// Concatenate all completed clips of a production into one MP4.
// Re-encodes (rather than stream-copies) so mixed sources with different codecs/
// resolutions concat cleanly: h264/yuv420p, scaled+padded to the first clip's size.
// Clips are assumed to carry an audio track (Veo output does; dry-run placeholders do too).
export async function assembleProduction(productionId: number, musicOnly = false, fullClips = false): Promise<string> {
  const production = db.getProduction(productionId);
  if (!production) throw new Error("Production not found");

  const shots = db.getProductionShots(productionId)
    .filter(s => s.status === "video_done" && s.video_filename);
  if (shots.length === 0) throw new Error("No completed clips to assemble");

  const clipPaths = shots.map(s => {
    const abs = storage.resolveMediaPath(s.video_filename!);
    if (!abs) throw new Error(`Missing clip on disk: ${s.video_filename}`);
    return abs;
  });

  const musicPath = production.music_filename
    ? storage.resolveMediaPath(production.music_filename)
    : null;

  db.updateProduction(productionId, { status: "assembling", error: null });

  try {
    const { width: W, height: H } = await probeResolution(clipPaths[0]);
    const N = clipPaths.length;

    // Honour the scripted per-shot durations by trimming each clip (Veo always renders ~8s).
    // `-t <sec>` before `-i` limits how much of that input is read; a hint longer than the clip
    // is harmless (ffmpeg just reads the whole clip).
    const inputs: string[] = [];
    shots.forEach((s, i) => {
      const secs = fullClips ? null : parseSeconds(s.duration_hint);
      if (secs) inputs.push("-t", String(secs));
      inputs.push("-i", clipPaths[i]);
    });

    // Music is looped so it can cover the full timeline; -shortest / amix trims it back.
    const musIdx = N;
    if (musicPath) inputs.push("-stream_loop", "-1", "-i", musicPath);

    // Scale + pad each clip to a uniform canvas.
    const scale = clipPaths.map((_, i) =>
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
    ).join(";");

    const outArgs: string[] = ["-y"];
    let filter: string;
    const maps: string[] = [];

    if (musicPath && musicOnly) {
      // Replace all audio with the music track.
      const vconcat = clipPaths.map((_, i) => `[v${i}]`).join("") + `concat=n=${N}:v=1:a=0[vout]`;
      filter = `${scale};${vconcat}`;
      maps.push("-map", "[vout]", "-map", `${musIdx}:a`);
      outArgs.push("-shortest");
    } else {
      // Interleave scaled video with each clip's own audio, then concat both streams.
      const interleave = clipPaths.map((_, i) => `[v${i}][${i}:a]`).join("");
      const concat = `${interleave}concat=n=${N}:v=1:a=1[vout][aconcat]`;
      if (musicPath) {
        // Mix music under the clip audio at reduced volume.
        filter = `${scale};${concat};[${musIdx}:a]volume=0.3[m];[aconcat][m]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
        maps.push("-map", "[vout]", "-map", "[aout]");
      } else {
        filter = `${scale};${concat}`;
        maps.push("-map", "[vout]", "-map", "[aconcat]");
      }
    }

    const name = `production_${productionId}_${Date.now()}.mp4`;
    const { absPath, relPath } = storage.reserveMediaPath(name, "videos", production.project_id);

    await runFfmpeg([
      ...inputs,
      "-filter_complex", filter,
      ...maps,
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart",
      absPath,
    ]);

    if (!fs.existsSync(absPath)) throw new Error("Assembly produced no output file");

    db.updateProduction(productionId, { status: "done", final_video_filename: relPath, error: null });
    return relPath;
  } catch (err) {
    db.updateProduction(productionId, {
      status: "review",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

export function registerAssembleRoutes(app: Express, upload: Multer) {
  // Upload a music file for a production.
  app.post("/api/productions/:id/music", upload.single("file"), async (req, res) => {
    const id = Number(req.params.id);
    const production = db.getProduction(id);
    if (!production) return res.status(404).json({ error: "Production not found" });
    const file = (req as unknown as { file?: { buffer: Buffer; originalname: string } }).file;
    if (!file) return res.status(400).json({ error: "Missing file" });
    try {
      const ext = (file.originalname.match(/\.[a-z0-9]+$/i)?.[0]) || ".mp3";
      const name = `music_${Date.now()}${ext}`;
      const filename = storage.saveBuffer(file.buffer, name, "videos", production.project_id);
      db.updateProduction(id, { music_filename: filename });
      res.json({ filename });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Assemble completed clips into the final MP4.
  app.post("/api/productions/:id/assemble", async (req, res) => {
    const id = Number(req.params.id);
    try {
      const filename = await assembleProduction(id, Boolean(req.body?.musicOnly), Boolean(req.body?.fullClips));
      res.json({ ok: true, filename });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
