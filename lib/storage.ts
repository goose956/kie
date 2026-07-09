import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

export const MEDIA_ROOT =
  process.env.MEDIA_ROOT ??
  path.join("C:\\Users\\User\\Desktop\\mission contol\\outputs\\kie-studio");

// Legacy flat dirs (uncategorised / backward compat)
export const IMAGES_DIR = path.join(MEDIA_ROOT, "images");
export const VIDEOS_DIR = path.join(MEDIA_ROOT, "videos");

[IMAGES_DIR, VIDEOS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

function projectDirs(projectId: number) {
  const base = path.join(MEDIA_ROOT, "projects", String(projectId));
  const images = path.join(base, "images");
  const videos = path.join(base, "videos");
  fs.mkdirSync(images, { recursive: true });
  fs.mkdirSync(videos, { recursive: true });
  return { images, videos };
}

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client
      .get(url, res => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume(); // drain so the socket can close cleanly
          reject(new Error(`Download failed: ${url} returned HTTP ${status}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on("finish", () => file.close(() => resolve()));
        file.on("error", err => { fs.unlink(dest, () => {}); reject(err); });
      })
      .on("error", err => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

// Returns a path relative to MEDIA_ROOT — stored in the DB as media_filename
function relPath(...segments: string[]): string {
  return path.join(...segments).replace(/\\/g, "/");
}

export async function saveImage(remoteUrl: string, filename: string, projectId?: number | null): Promise<string> {
  const ext = path.extname(new URL(remoteUrl).pathname) || ".png";
  const name = `${filename}${ext}`;
  if (projectId) {
    const { images } = projectDirs(projectId);
    await download(remoteUrl, path.join(images, name));
    return relPath("projects", String(projectId), "images", name);
  }
  await download(remoteUrl, path.join(IMAGES_DIR, name));
  return relPath("images", name);
}

export async function saveVideo(remoteUrl: string, filename: string, projectId?: number | null): Promise<string> {
  const ext = path.extname(new URL(remoteUrl).pathname) || ".mp4";
  const name = `${filename}${ext}`;
  if (projectId) {
    const { videos } = projectDirs(projectId);
    await download(remoteUrl, path.join(videos, name));
    return relPath("projects", String(projectId), "videos", name);
  }
  await download(remoteUrl, path.join(VIDEOS_DIR, name));
  return relPath("videos", name);
}

export async function saveUpload(buffer: Buffer, originalName: string, type: "images" | "videos", projectId?: number | null): Promise<string> {
  const ext = path.extname(originalName);
  const name = `upload_${Date.now()}${ext}`;
  if (projectId) {
    const dirs = projectDirs(projectId);
    fs.writeFileSync(path.join(dirs[type], name), buffer);
    return relPath("projects", String(projectId), type, name);
  }
  const dir = type === "images" ? IMAGES_DIR : VIDEOS_DIR;
  fs.writeFileSync(path.join(dir, name), buffer);
  return relPath(type, name);
}

// Reserve an absolute + relative path for a media file the caller will write itself
// (used by the Produce pipeline: ffmpeg writes placeholder clips and the assembled MP4 directly).
export function reserveMediaPath(
  name: string,
  type: "images" | "videos",
  projectId?: number | null,
): { absPath: string; relPath: string } {
  if (projectId) {
    const dirs = projectDirs(projectId);
    return { absPath: path.join(dirs[type], name), relPath: relPath("projects", String(projectId), type, name) };
  }
  const dir = type === "images" ? IMAGES_DIR : VIDEOS_DIR;
  return { absPath: path.join(dir, name), relPath: relPath(type, name) };
}

// Write a buffer to a named media file, returning the relative path stored in the DB.
export function saveBuffer(
  buffer: Buffer,
  name: string,
  type: "images" | "videos",
  projectId?: number | null,
): string {
  const { absPath, relPath: rel } = reserveMediaPath(name, type, projectId);
  fs.writeFileSync(absPath, buffer);
  return rel;
}

// True if `candidate` resolves to somewhere inside `root` — blocks "../" escaping the media dirs
// (this feeds a public GET /api/media/* route, so containment must be enforced, not assumed).
function isWithin(root: string, candidate: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  return c === r || c.startsWith(r + path.sep);
}

// Resolve a stored media_filename (relative path OR legacy bare filename) to an absolute path
export function resolveMediaPath(mediaFilename: string): string | null {
  // Try as relative path from MEDIA_ROOT first
  const abs = path.resolve(MEDIA_ROOT, mediaFilename);
  if (isWithin(MEDIA_ROOT, abs) && fs.existsSync(abs)) return abs;
  // Legacy: bare filename — try images/ then videos/
  const asImage = path.resolve(IMAGES_DIR, mediaFilename);
  if (isWithin(IMAGES_DIR, asImage) && fs.existsSync(asImage)) return asImage;
  const asVideo = path.resolve(VIDEOS_DIR, mediaFilename);
  if (isWithin(VIDEOS_DIR, asVideo) && fs.existsSync(asVideo)) return asVideo;
  return null;
}
