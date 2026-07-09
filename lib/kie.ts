// kie.ai API client — verified against docs.kie.ai
// Image: POST /api/v1/jobs/createTask  →  GET /api/v1/jobs/recordInfo?taskId=
// Video: POST /api/v1/veo/generate     →  GET /api/v1/veo/record-info?taskId=

const BASE = "https://api.kie.ai";
const TIMEOUT_MS = 30_000;

function headers() {
  return {
    Authorization: `Bearer ${process.env.KIE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

function withTimeout(ms: number): AbortSignal {
  return AbortSignal.timeout(ms);
}

// ── Image (Nano Banana) ───────────────────────────────────────────────────────

export type ImageModel = "google/nano-banana" | "nano-banana-2";

export interface ImageTask { taskId: string; }

export interface ImageResult {
  status: "pending" | "success" | "failed";
  imageUrl?: string;
  errorMessage?: string;
}

export type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";

export type ImageResolution = "1K" | "2K" | "4K";

export async function createImageTask(
  prompt: string,
  model: ImageModel = "google/nano-banana",
  imageUrls: string[] = [],
  aspectRatio: AspectRatio = "1:1",
  resolution?: ImageResolution
): Promise<ImageTask> {
  const input: Record<string, unknown> = { prompt, aspect_ratio: aspectRatio };
  if (imageUrls.length > 0) input.image_input = imageUrls;
  if (resolution && model === "nano-banana-2") input.resolution = resolution;

  const res = await fetch(`${BASE}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model, input }),
    signal: withTimeout(TIMEOUT_MS),
  });

  const data = await res.json();
  if (data.code !== 200 || !data.data?.taskId) {
    throw new Error(`Kie image task failed: ${data.msg ?? res.status}`);
  }
  return { taskId: data.data.taskId };
}

export async function pollImageTask(taskId: string): Promise<ImageResult> {
  const res = await fetch(
    `${BASE}/api/v1/jobs/recordInfo?taskId=${taskId}`,
    { headers: headers(), signal: withTimeout(TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Kie image poll failed: ${res.status}`);
  const data = await res.json();
  const record = data.data;
  if (!record) throw new Error("Kie image poll: empty response");

  if (record.state === "success") {
    let imageUrl: string | undefined;
    try { imageUrl = JSON.parse(record.resultJson)?.resultUrls?.[0]; } catch {}
    return { status: "success", imageUrl };
  }
  if (record.state === "fail") {
    return { status: "failed", errorMessage: record.failMsg ?? "Generation failed" };
  }
  return { status: "pending" };
}

// ── Video (Veo 3.1) ───────────────────────────────────────────────────────────
// model: "veo3" (Quality) | "veo3_fast" (Fast) | "veo3_lite" (cheapest — verified via
// docs.kie.ai/veo3-api/generate-veo-3-video). Separate "resolution" param (720p/1080p/4k,
// default 720p) exists too but we don't expose it yet — out of scope for this pass.

export type VideoQuality = "lite" | "fast" | "quality";

export interface VideoTask { taskId: string; }

export interface VideoResult {
  status: "pending" | "success" | "failed";
  videoUrl?: string;
  errorMessage?: string;
}

export type VideoAspect = "16:9" | "9:16";

export async function createVideoTask(
  prompt: string,
  imageUrls: string[] = [],
  quality: VideoQuality = "fast",
  aspectRatio: VideoAspect = "16:9"
): Promise<VideoTask> {
  const model = quality === "lite" ? "veo3_lite" : quality === "fast" ? "veo3_fast" : "veo3";
  const body: Record<string, unknown> = {
    prompt,
    model,
    generationType: imageUrls.length > 0 ? "REFERENCE_2_VIDEO" : "TEXT_2_VIDEO",
    aspect_ratio: aspectRatio,
  };
  if (imageUrls.length > 0) body.imageUrls = imageUrls;

  const res = await fetch(`${BASE}/api/v1/veo/generate`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: withTimeout(TIMEOUT_MS),
  });

  const data = await res.json();
  if (data.code !== 200 || !data.data?.taskId) {
    throw new Error(`Kie video task failed: ${data.msg ?? res.status}`);
  }
  return { taskId: data.data.taskId };
}

export async function pollVideoTask(taskId: string): Promise<VideoResult> {
  const res = await fetch(
    `${BASE}/api/v1/veo/record-info?taskId=${taskId}`,
    { headers: headers(), signal: withTimeout(TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Kie video poll failed: ${res.status}`);
  const data = await res.json();
  const record = data.data;
  if (!record) throw new Error("Kie video poll: empty response");

  if (record.successFlag === 1) {
    const videoUrl = record.response?.resultUrls?.[0] ?? record.response?.fullResultUrls?.[0];
    return { status: "success", videoUrl };
  }
  if (record.successFlag === 2 || record.successFlag === 3) {
    return { status: "failed", errorMessage: record.errorMessage ?? "Generation failed" };
  }
  return { status: "pending" };
}

// ── Alternate video engines (Kling, Seedance) — cost/quality comparison ───────
// Both route through the SAME generic jobs/createTask + jobs/recordInfo endpoints already
// used for image generation above (unlike Veo's dedicated /api/v1/veo/* pair), so they share
// one poll function. Verified directly against docs.kie.ai — see pollMarketTask for the
// confirmed response shape (identical structure to pollImageTask: state/resultJson/failMsg).

export type MarketVideoEngine = "kling" | "seedance";

export interface MarketVideoResult {
  status: "pending" | "success" | "failed";
  videoUrl?: string;
  errorMessage?: string;
}

// Kling 3.0 (model "kling-3.0/video"). mode controls resolution: std=720p, pro=1080p, 4K=4K.
// duration "3".."15" (1s increments) — unlike Veo's fixed ~8s, we can request the exact length.
export async function createKlingVideoTask(
  prompt: string,
  imageUrl: string,
  opts: { aspectRatio?: "16:9" | "9:16" | "1:1"; mode?: "std" | "pro" | "4K"; sound?: boolean; duration?: string } = {}
): Promise<{ taskId: string }> {
  const res = await fetch(`${BASE}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "kling-3.0/video",
      input: {
        prompt,
        image_urls: [imageUrl],
        aspect_ratio: opts.aspectRatio ?? "16:9",
        mode: opts.mode ?? "std",
        sound: opts.sound ?? false,
        duration: opts.duration ?? "5",
      },
    }),
    signal: withTimeout(TIMEOUT_MS),
  });
  const data = await res.json();
  if (data.code !== 200 || !data.data?.taskId) throw new Error(`Kling video task failed: ${data.msg ?? res.status}`);
  return { taskId: data.data.taskId };
}

// ByteDance Seedance 1.5 Pro (model "bytedance/seedance-1.5-pro"). When an input image is
// supplied, output resolution is INHERITED from the image's own dimensions — the separate
// "resolution" field only applies to text-to-video (no reference image), so we don't send it.
export async function createSeedanceVideoTask(
  prompt: string,
  imageUrl: string,
  opts: { aspectRatio?: string; duration?: string; fixedLens?: boolean; generateAudio?: boolean } = {}
): Promise<{ taskId: string }> {
  const res = await fetch(`${BASE}/api/v1/jobs/createTask`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      model: "bytedance/seedance-1.5-pro",
      input: {
        prompt,
        input_urls: [imageUrl],
        aspect_ratio: opts.aspectRatio ?? "16:9",
        duration: opts.duration ?? "5",
        fixed_lens: opts.fixedLens ?? false,
        generate_audio: opts.generateAudio ?? false,
      },
    }),
    signal: withTimeout(TIMEOUT_MS),
  });
  const data = await res.json();
  if (data.code !== 200 || !data.data?.taskId) throw new Error(`Seedance video task failed: ${data.msg ?? res.status}`);
  return { taskId: data.data.taskId };
}

// Shared poll for any jobs/createTask-based model (Kling, Seedance, and the image models above).
export async function pollMarketTask(taskId: string): Promise<MarketVideoResult> {
  const res = await fetch(
    `${BASE}/api/v1/jobs/recordInfo?taskId=${taskId}`,
    { headers: headers(), signal: withTimeout(TIMEOUT_MS) }
  );
  if (!res.ok) throw new Error(`Market task poll failed: ${res.status}`);
  const data = await res.json();
  const record = data.data;
  if (!record) throw new Error("Market task poll: empty response");

  if (record.state === "success") {
    let videoUrl: string | undefined;
    try { videoUrl = JSON.parse(record.resultJson)?.resultUrls?.[0]; } catch {}
    return { status: "success", videoUrl };
  }
  if (record.state === "fail") {
    return { status: "failed", errorMessage: record.failMsg ?? "Generation failed" };
  }
  return { status: "pending" };
}

// ── File upload (make a local image fetchable by kie) ─────────────────────────
// POST https://api.kie.ai/api/file-base64-upload → { data: { downloadUrl } }.
// Note: uploaded files are temporary (deleted after ~3 days), same as generated images.

export async function uploadImageBase64(dataUrl: string, fileName: string): Promise<string> {
  const res = await fetch(`${BASE}/api/file-base64-upload`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ base64Data: dataUrl, uploadPath: "kie-studio", fileName }),
    signal: withTimeout(60_000),
  });
  const data = await res.json();
  const url = data?.data?.downloadUrl;
  if (!url) throw new Error(`Kie file upload failed: ${data?.msg ?? res.status}`);
  return url as string;
}

// ── Credits ───────────────────────────────────────────────────────────────────

export async function getCredits(): Promise<number> {
  const res = await fetch(`${BASE}/api/v1/chat/credit`, { headers: headers() });
  if (!res.ok) throw new Error(`Kie credits failed: ${res.status}`);
  const data = await res.json();
  return data.data?.balance ?? data.balance ?? 0;
}
