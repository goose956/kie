"use client";

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import DirectorPanel from "./DirectorPanel";
import ScriptWriter from "./ScriptWriter";
import ProducePanel from "./ProducePanel";
import AdPackPanel from "./AdPackPanel";
import CostsPanel from "./CostsPanel";
import TemplatesPanel from "./TemplatesPanel";
import Settings from "./Settings";

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

interface Conversation { id: number; title: string; created_at: string; }

interface Message {
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

interface RetryState {
  msgId: number;
  type: "image" | "video";
  originalPrompt: string;
}

type Mode = "image" | "video";
type ImageModel = "google/nano-banana" | "nano-banana-2";
type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
type VideoQuality = "fast" | "quality";
type ShotStyle = "" | "Selfie" | "35mm film" | "Cinematic" | "Macro" | "Polaroid" | "DSLR portrait" | "Drone aerial" | "Fish-eye" | "Long exposure" | "Black and white" | "Double exposure" | "Tilt-shift";
type CameraShot = "" | "Wide shot" | "Close-up shot" | "Extreme close-up" | "Aerial shot" | "Low angle shot" | "High angle shot" | "Pan left" | "Pan right" | "Tilt up" | "Tilt down" | "Zoom in" | "Zoom out" | "Tracking shot" | "Dolly shot" | "Handheld shot" | "Static shot";
type VideoLighting = "" | "Natural daylight" | "Golden hour" | "Blue hour" | "Overcast" | "Studio lighting" | "Neon lights" | "Candlelight" | "Backlit" | "High contrast" | "Soft diffused" | "Harsh shadows" | "Practical lights only";

interface Project { id: number; name: string; character_image: string | null; character_image_url: string | null; created_at: string; }

function mediaUrl(msg: Message) {
  if (!msg.media_filename) return null;
  // media_filename is now a relative path like "images/foo.png" or "projects/1/images/foo.png"
  return `/api/media/${msg.media_filename}`;
}

function loadProjectMeta() {
  try { return JSON.parse(localStorage.getItem("kie-studio-project") ?? "{}"); } catch { return {}; }
}

function Spinner() {
  return (
    <div className="flex items-center gap-2 text-sm text-gray-500">
      <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
      Generating…
    </div>
  );
}

// ── Message bubble ────────────────────────────────────────────────────────────

interface BubbleProps {
  msg: Message;
  onUseAsRef: (url: string) => void;
  onGenerateVideo: (imageUrl: string, prompt: string) => void;
  onRetry: (state: RetryState) => void;
  precedingUserText: string;
}

function MessageBubble({ msg, onUseAsRef, onGenerateVideo, onRetry, precedingUserText }: BubbleProps) {
  const url = mediaUrl(msg);
  const isAssistant = msg.role === "assistant";

  return (
    <div className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-xl rounded-2xl px-4 py-3 text-sm ${
        msg.role === "user"
          ? "bg-gray-100 text-gray-800"
          : "bg-[#161616] border border-gray-200 text-gray-500"
      }`}>
        {msg.text && <p className="whitespace-pre-wrap">{msg.text}</p>}
        {msg.status === "pending" && <Spinner />}
        {msg.status === "failed" && (
          <div className="space-y-2">
            <p className="text-red-400 text-xs">Generation failed.</p>
            {isAssistant && precedingUserText && (
              <button
                onClick={() => onRetry({ msgId: msg.id, type: msg.job_type ?? "image", originalPrompt: precedingUserText })}
                className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
              >
                Retry →
              </button>
            )}
          </div>
        )}

        {msg.status === "done" && url && msg.media_type === "image" && (
          <div className="mt-2 space-y-2">
            <img src={url} alt="Generated" className="rounded-lg max-w-full border border-gray-200" />
            <div className="flex gap-3 flex-wrap">
              <a href={url} download className="text-xs text-gray-500 hover:text-gray-500 transition-colors">Download</a>
              <button onClick={() => onUseAsRef(url)} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                Use as reference
              </button>
              <button
                onClick={() => onGenerateVideo(url, precedingUserText)}
                className="text-xs text-green-400 hover:text-green-300 transition-colors"
              >
                Generate video from this →
              </button>
              {precedingUserText && (
                <button
                  onClick={() => onRetry({ msgId: msg.id, type: "image", originalPrompt: precedingUserText })}
                  className="text-xs text-gray-500 hover:text-gray-500 transition-colors"
                >
                  Retry with notes
                </button>
              )}
            </div>
          </div>
        )}

        {msg.status === "done" && url && msg.media_type === "video" && (
          <div className="mt-2 space-y-2">
            <video src={url} controls className="rounded-lg max-w-full border border-gray-200" />
            <div className="flex gap-3">
              <a href={url} download className="text-xs text-gray-500 hover:text-gray-500 transition-colors block">Download</a>
              {precedingUserText && (
                <button
                  onClick={() => onRetry({ msgId: msg.id, type: "video", originalPrompt: precedingUserText })}
                  className="text-xs text-gray-500 hover:text-gray-500 transition-colors"
                >
                  Retry with notes
                </button>
              )}
            </div>
          </div>
        )}

        {msg.media_subtype && isAssistant && (
          <p className="text-xs text-gray-500 mt-1">{msg.media_subtype}</p>
        )}
      </div>
    </div>
  );
}

// ── Retry panel ───────────────────────────────────────────────────────────────

interface RetryPanelProps {
  state: RetryState;
  activeId: number;
  mode: Mode;
  imageModel: ImageModel;
  aspectRatio: AspectRatio;
  shotStyle: ShotStyle;
  videoQuality: VideoQuality;
  cameraShot: CameraShot;
  videoLighting: VideoLighting;
  attachedImages: string[];
  onDone: (messageId: number) => void;
  onCancel: () => void;
}

function RetryPanel({ state, activeId, mode, imageModel, aspectRatio, shotStyle, videoQuality, cameraShot, videoLighting, attachedImages, onDone, onCancel }: RetryPanelProps) {
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const meta = loadProjectMeta();

  async function submit() {
    setLoading(true); setError("");
    try {
      const res = await fetch("/api/generate-retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: activeId,
          originalPrompt: state.originalPrompt,
          retryNotes: notes,
          type: state.type,
          model: imageModel,
          aspectRatio,
          shotStyle,
          imageUrls: attachedImages,
          quality: videoQuality,
          cameraShot,
          videoLighting,
          projectStyle: meta.visualStyle ?? "",
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      onDone(data.messageId);
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  return (
    <div className="border border-amber-500/30 rounded-xl p-4 space-y-3 bg-gray-50">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-amber-400">Retry: {state.type}</p>
        <button onClick={onCancel} className="text-xs text-gray-500 hover:text-gray-500">✕ Cancel</button>
      </div>
      <p className="text-xs text-gray-500">Original: <span className="text-gray-500 italic">"{state.originalPrompt.slice(0, 80)}{state.originalPrompt.length > 80 ? "…" : ""}"</span></p>
      <textarea
        value={notes}
        onChange={e => setNotes(e.target.value)}
        placeholder="What to change — e.g. 'more dramatic lighting', 'subject should be looking left', 'too busy, simplify the background'"
        rows={2}
        autoFocus
        className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500"
      />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <button onClick={submit} disabled={loading}
        className="w-full bg-amber-500 text-black text-xs font-semibold rounded-lg py-2 hover:bg-amber-400 disabled:opacity-40 transition-colors">
        {loading ? "Generating…" : "Regenerate with these notes"}
      </button>
    </div>
  );
}

// ── Library ───────────────────────────────────────────────────────────────────

interface LibraryFile { filename: string; basename?: string; type: "image" | "video"; size: number; created_at: string; }

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function Library({ projectId, projects, onProjectsChange }: { projectId: number | null; projects: Project[]; onProjectsChange: () => void }) {
  const [images, setImages] = useState<LibraryFile[]>([]);
  const [videos, setVideos] = useState<LibraryFile[]>([]);
  const [tab, setTab] = useState<"images" | "videos">("images");
  const [selected, setSelected] = useState<LibraryFile | null>(null);
  const [viewProjectId, setViewProjectId] = useState<number | null>(projectId);

  async function setAsCharacter(filename: string | null) {
    if (viewProjectId == null) return;
    await fetch("/api/projects/character", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: viewProjectId, filename }),
    });
    onProjectsChange();
  }

  const activeViewProject = projects.find(p => p.id === viewProjectId);

  useEffect(() => { setViewProjectId(projectId); }, [projectId]);

  useEffect(() => {
    const url = viewProjectId != null ? `/api/library?projectId=${viewProjectId}` : "/api/library";
    fetch(url).then(r => r.json()).then(d => { setImages(d.images ?? []); setVideos(d.videos ?? []); setSelected(null); });
  }, [viewProjectId]);

  const files = tab === "images" ? images : videos;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-1 px-4 py-3 border-b border-gray-200 flex-wrap">
        {/* Project filter */}
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto">
          <button onClick={() => setViewProjectId(null)}
            className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex-shrink-0 ${viewProjectId === null ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-500"}`}>
            Uncategorised
          </button>
          {projects.map(p => (
            <button key={p.id} onClick={() => setViewProjectId(p.id)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors flex-shrink-0 ${viewProjectId === p.id ? "bg-gray-900 text-white" : "text-gray-500 hover:text-gray-500"}`}>
              {p.name}
            </button>
          ))}
        </div>
        {/* Images / Videos toggle */}
        <div className="flex gap-1 flex-shrink-0">
          {(["images", "videos"] as const).map(t => (
            <button key={t} onClick={() => { setTab(t); setSelected(null); }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors capitalize ${tab === t ? "bg-gray-200 text-gray-900" : "text-gray-500 hover:text-gray-500"}`}>
              {t} ({(t === "images" ? images : videos).length})
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">
          {files.length === 0 && <p className="text-gray-500 text-sm text-center mt-12">No {tab} yet</p>}
          <div className="grid grid-cols-3 gap-3">
            {files.map(f => {
              const url = `/api/media/${f.filename}`;
              const isActive = selected?.filename === f.filename;
              return (
                <div key={f.filename} onClick={() => setSelected(isActive ? null : f)}
                  className={`cursor-pointer rounded-xl overflow-hidden border transition-all ${isActive ? "border-white" : "border-gray-200 hover:border-gray-300"}`}>
                  {f.type === "image" ? (
                    <img src={url} alt="" className="w-full aspect-square object-cover" />
                  ) : (
                    <div className="w-full aspect-square bg-gray-100 relative">
                      <video src={url} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 flex items-center justify-center bg-gray-900/30">
                        <div className="w-8 h-8 rounded-full bg-gray-900/20 flex items-center justify-center">
                          <span className="text-gray-900 text-xs">▶</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {selected && (() => {
          const url = `/api/media/${selected.filename}`;
          return (
            <div className="w-72 border-l border-gray-200 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {selected.type === "image"
                  ? <img src={url} alt="" className="w-full rounded-lg border border-gray-200" />
                  : <video src={url} controls className="w-full rounded-lg border border-gray-200" />}
                <div className="space-y-1 text-xs text-gray-500">
                  <p className="text-gray-500 break-all">{selected.basename ?? selected.filename}</p>
                  <p>{formatBytes(selected.size)}</p>
                  <p>{new Date(selected.created_at).toLocaleString()}</p>
                </div>
                {selected.type === "image" && viewProjectId != null && (() => {
                  const isChar = activeViewProject?.character_image === selected.filename;
                  return isChar ? (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200">
                        <span className="text-[10px] text-green-500 font-medium">★ Project character</span>
                      </div>
                      <button onClick={() => setAsCharacter(null)}
                        className="w-full text-center text-[10px] text-gray-500 hover:text-gray-500 py-1 transition-colors">
                        Remove character
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setAsCharacter(selected.filename)}
                      className="w-full text-center bg-gray-100 border border-gray-200 text-gray-500 text-xs font-medium py-2 rounded-lg hover:bg-gray-100 hover:border-gray-300 transition-colors">
                      ★ Set as character
                    </button>
                  );
                })()}
                <a href={url} download={selected.basename ?? selected.filename}
                  className="block w-full text-center bg-gray-900 text-white text-xs font-semibold py-2 rounded-lg hover:bg-gray-700 transition-colors">
                  Download
                </a>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function Chat() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number | null>(null);
  const [newProjectName, setNewProjectName] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [view, setView] = useState<"chat" | "library" | "script" | "produce" | "adpack" | "costs" | "templates" | "settings">("adpack");
  const [activeProductionId, setActiveProductionId] = useState<number | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<number | null>(null);
  const [projectError, setProjectError] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<Mode>("image");
  const [imageModel, setImageModel] = useState<ImageModel>("google/nano-banana");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("1:1");
  const [shotStyle, setShotStyle] = useState<ShotStyle>("");
  const [videoQuality, setVideoQuality] = useState<VideoQuality>("fast");
  const [cameraShot, setCameraShot] = useState<CameraShot>("");
  const [videoLighting, setVideoLighting] = useState<VideoLighting>("");
  const [attachedImages, setAttachedImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState<RetryState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pollTimers = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map());

  async function loadProjects() {
    const res = await fetch("/api/projects");
    setProjects(await res.json());
  }

  async function createProject() {
    const name = newProjectName.trim();
    if (!name) return;
    setProjectError("");
    // Instant client-side guard against duplicate names (case-insensitive).
    if (projects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      setProjectError("A project called that already exists");
      return;
    }
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const p = await res.json();
    if (!res.ok || p.error) { setProjectError(p.error || "Could not create project"); return; }
    setProjects(prev => [p, ...prev]);
    setActiveProjectId(p.id);
    setNewProjectName(""); setShowNewProject(false);
    setActiveId(null); setMessages([]);
    loadConversations(p.id);
  }

  async function deleteProject(id: number) {
    await fetch("/api/projects", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setProjects(prev => prev.filter(p => p.id !== id));
    if (activeProjectId === id) { setActiveProjectId(null); setActiveId(null); setMessages([]); loadConversations(null); }
  }

  async function loadConversations(projectId?: number | null) {
    const pid = projectId !== undefined ? projectId : activeProjectId;
    const url = pid != null ? `/api/conversations?projectId=${pid}` : "/api/conversations";
    const res = await fetch(url);
    setConversations(await res.json());
  }

  async function loadMessages(id: number) {
    const res = await fetch(`/api/conversations?id=${id}`);
    const msgs: Message[] = await res.json();
    setMessages(msgs);
    msgs.filter(m => m.status === "pending").forEach(m => schedulePoll(m.id));
  }

  useEffect(() => { loadProjects(); loadConversations(null); }, []);
  useEffect(() => {
    if (activeId) loadMessages(activeId);
    return () => { pollTimers.current.forEach(clearInterval); pollTimers.current.clear(); };
  }, [activeId]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const schedulePoll = useCallback((messageId: number) => {
    if (pollTimers.current.has(messageId)) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/poll?messageId=${messageId}`);
      const updated: Message & { resolved?: boolean } = await res.json();
      if (updated.resolved) {
        clearInterval(timer);
        pollTimers.current.delete(messageId);
        setMessages(prev => prev.map(m => m.id === messageId ? updated : m));
      }
    }, 4000);
    pollTimers.current.set(messageId, timer);
  }, []);

  async function newConversation() {
    const res = await fetch("/api/conversations", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: activeProjectId }),
    });
    const conv: Conversation = await res.json();
    setConversations(prev => [conv, ...prev]);
    setActiveId(conv.id);
    setMessages([]);
    setAttachedImages([]);
  }

  async function deleteConversation(id: number) {
    await fetch("/api/conversations", {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }),
    });
    setConversations(prev => prev.filter(c => c.id !== id));
    if (activeId === id) { setActiveId(null); setMessages([]); }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files || !activeId) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      form.append("conversationId", String(activeId));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const msg: Message = await res.json();
      setMessages(prev => [...prev, msg]);
      setAttachedImages(prev => [...prev, `/api/media/images/${msg.media_filename}`]);
    }
    setUploading(false);
    e.target.value = "";
  }

  function getProjectStyle() {
    return loadProjectMeta().visualStyle ?? "";
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || !activeId || submitting) return;
    setSubmitting(true);

    const endpoint = mode === "image" ? "/api/generate-image" : "/api/generate-video";
    const body: Record<string, unknown> = {
      conversationId: activeId,
      prompt: prompt.trim(),
      projectStyle: getProjectStyle(),
      projectId: activeProjectId,
    };
    if (mode === "image") {
      body.model = imageModel; body.aspectRatio = aspectRatio;
      if (shotStyle) body.shotStyle = shotStyle;
      if (attachedImages.length) body.imageUrls = attachedImages;
    } else {
      body.quality = videoQuality;
      if (cameraShot) body.cameraShot = cameraShot;
      if (videoLighting) body.videoLighting = videoLighting;
      if (attachedImages.length) body.imageUrls = attachedImages;
    }

    const sentPrompt = prompt.trim();
    setPrompt(""); setAttachedImages([]);

    const tempId = Date.now();
    setMessages(prev => [...prev, {
      id: tempId, conversation_id: activeId, role: "user", text: sentPrompt,
      media_type: null, media_filename: null, media_subtype: null,
      job_id: null, job_type: null, status: "done", created_at: new Date().toISOString(),
    }]);

    try {
      const res = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const { messageId } = await res.json();
      setMessages(prev => [...prev, {
        id: messageId, conversation_id: activeId, role: "assistant", text: null,
        media_type: mode, media_filename: null,
        media_subtype: mode === "image" ? imageModel : videoQuality,
        job_id: null, job_type: mode, status: "pending", created_at: new Date().toISOString(),
      }]);
      schedulePoll(messageId);
      loadConversations();
    } catch {
      setMessages(prev => prev.filter(m => m.id !== tempId));
    }
    setSubmitting(false);
  }

  // Create a production from a Script Writer breakdown and open the Produce panel
  async function handleProduceScript(shots: BreakdownShot[], productMode: boolean) {
    try {
      const res = await fetch("/api/productions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          title: `${productMode ? "Product ad" : "Production"} · ${new Date().toLocaleDateString()}`,
          shots,
        }),
      });
      const data = await res.json();
      if (data.production) {
        setActiveProductionId(data.production.id);
        setView("produce");
      }
    } catch { /* surfaced in the panel on next load */ }
  }

  // Image-first: attach image + switch to video mode with pre-filled prompt
  function handleGenerateVideo(imageUrl: string, prompt: string) {
    setMode("video");
    setAttachedImages(prev => prev.includes(imageUrl) ? prev : [...prev, imageUrl]);
    if (prompt) setPrompt(prompt);
    // Ensure we're in chat view
    setView("chat");
  }

  function handleRetryDone(messageId: number) {
    setRetrying(null);
    schedulePoll(messageId);
    // Add pending message
    if (activeId) {
      const pendingMsg: Message = {
        id: messageId, conversation_id: activeId, role: "assistant", text: null,
        media_type: retrying?.type ?? "image", media_filename: null,
        media_subtype: retrying?.type === "image" ? imageModel : videoQuality,
        job_id: null, job_type: retrying?.type ?? "image", status: "pending",
        created_at: new Date().toISOString(),
      };
      setMessages(prev => [...prev, pendingMsg]);
    }
  }

  // For each assistant message, find the preceding user text
  function getPrecedingUserText(msg: Message): string {
    const idx = messages.findIndex(m => m.id === msg.id);
    if (idx <= 0) return "";
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === "user" && messages[i].text) return messages[i].text!;
    }
    return "";
  }

  const lastVideoShot = useMemo(() => {
    const videos = messages.filter(m => m.role === "assistant" && m.job_type === "video" && m.status === "done");
    if (videos.length === 0) return null;
    const last = videos[videos.length - 1];
    const idx = messages.indexOf(last);
    const userMsg = idx > 0 ? messages.slice(0, idx).reverse().find(m => m.role === "user" && m.text) : null;
    return { prompt: userMsg?.text ?? "", cameraShot: last.media_subtype ?? "", lighting: "" };
  }, [messages]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside className="w-60 flex-shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <div className="text-gray-900 font-semibold text-sm mb-3 tracking-wide">KIE STUDIO</div>

          {/* Project selector */}
          <div className="mb-3 space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Project</p>
              <button onClick={() => setShowNewProject(v => !v)}
                className="text-[10px] text-gray-500 hover:text-gray-500 transition-colors">+ New</button>
            </div>
            {showNewProject && (
              <div className="space-y-1">
                <div className="flex gap-1">
                  <input value={newProjectName} onChange={e => { setNewProjectName(e.target.value); setProjectError(""); }}
                    onKeyDown={e => { if (e.key === "Enter") createProject(); if (e.key === "Escape") setShowNewProject(false); }}
                    placeholder="Project name…" autoFocus
                    className="flex-1 bg-white border border-gray-300 rounded-md px-2 py-1 text-xs text-black placeholder-gray-400 focus:outline-none min-w-0" />
                  <button onClick={createProject} className="px-2 py-1 bg-gray-900 text-white text-xs rounded-md hover:bg-gray-700 flex-shrink-0">✓</button>
                </div>
                {projectError && <p className="text-red-500 text-[10px]">{projectError}</p>}
              </div>
            )}
            <div className="space-y-0.5 max-h-28 overflow-y-auto">
              {projects.map(p => (
                <div key={p.id} className="group flex items-center gap-1">
                  {p.character_image
                    ? <img src={`/api/media/${p.character_image}`} alt="" className="w-5 h-5 rounded-full object-cover border border-gray-300 flex-shrink-0" />
                    : <div className="w-5 h-5 rounded-full bg-gray-100 border border-gray-200 flex-shrink-0" />
                  }
                  <button onClick={() => { setActiveProjectId(p.id); setActiveId(null); setMessages([]); loadConversations(p.id); }}
                    className={`flex-1 text-left px-1.5 py-1.5 rounded-md text-xs transition-colors truncate ${activeProjectId === p.id ? "bg-gray-100 text-gray-900" : "text-gray-500 hover:bg-gray-50 hover:text-gray-500"}`}>
                    {p.name}
                  </button>
                  <button onClick={() => deleteProject(p.id)}
                    className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 px-1 text-xs transition-all flex-shrink-0">✕</button>
                </div>
              ))}
            </div>
          </div>

          {/* Vertical nav — the production flow, top to bottom */}
          <div className="flex flex-col gap-1">
            {([["adpack", "Ad Pack"], ["produce", "Produce"], ["library", "Library"], ["templates", "Templates"], ["costs", "Costs"], ["settings", "Settings"]] as const).map(([v, label]) => (
              <button key={v} onClick={() => setView(v)}
                className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors ${view === v ? "bg-gray-900 text-white" : "text-gray-500 hover:bg-gray-100 hover:text-gray-900"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col overflow-hidden bg-white">
        {/* Flow step bar */}
        {view !== "settings" && view !== "costs" && view !== "templates" && activeProjectId != null && (
          <div className="px-4 py-2 border-b border-gray-200 flex items-center gap-2 text-[10px] flex-shrink-0">
            <span className="text-green-600 font-medium">① Project ✓</span>
            <span className="text-gray-300">›</span>
            <button onClick={() => setView("adpack")}
              className={`${view === "adpack" ? "text-gray-900 font-medium" : "text-gray-400 hover:text-gray-700"}`}>
              ② Create ads
            </button>
            <span className="text-gray-300">›</span>
            <button onClick={() => setView("produce")}
              className={`${view === "produce" ? "text-gray-900 font-medium" : "text-gray-400 hover:text-gray-700"}`}>
              ③ Produce
            </button>
            <span className="ml-auto text-gray-400">{projects.find(p => p.id === activeProjectId)?.name}</span>
          </div>
        )}
        {view === "settings" ? (
          <Settings />
        ) : view === "costs" ? (
          <CostsPanel projects={projects} />
        ) : view === "templates" ? (
          <TemplatesPanel projects={projects} onProjectsChange={loadProjects} onGoToProduce={(id, projectId) => { setActiveProjectId(projectId); setActiveProductionId(id); setView("produce"); }} />
        ) : activeProjectId == null ? (
          /* Project-first gate — nothing else unlocks until a project is chosen */
          <div className="flex-1 overflow-y-auto flex items-center justify-center p-6">
            <div className="w-full max-w-sm space-y-4">
              <div className="text-center space-y-1">
                <div className="text-3xl">◆</div>
                <p className="text-sm font-medium text-gray-900">Pick or create a project to start</p>
                <p className="text-xs text-gray-500">Everything — characters, ad packs, productions — lives inside a project.</p>
              </div>
              {projects.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500">Your projects</p>
                  {projects.map(p => (
                    <div key={p.id} className="group flex items-center gap-2 border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50 transition-colors">
                      {p.character_image
                        ? <img src={`/api/media/${p.character_image}`} alt="" className="w-6 h-6 rounded-full object-cover border border-gray-300 flex-shrink-0" />
                        : <div className="w-6 h-6 rounded-full bg-gray-100 border border-gray-200 flex-shrink-0" />}
                      <button onClick={() => { setActiveProjectId(p.id); loadConversations(p.id); }}
                        className="text-sm text-gray-800 flex-1 truncate text-left">{p.name}</button>
                      {confirmDeleteProject === p.id ? (
                        <span className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => { deleteProject(p.id); setConfirmDeleteProject(null); }}
                            className="text-[10px] text-red-500 hover:text-red-600 font-medium">Delete</button>
                          <button onClick={() => setConfirmDeleteProject(null)}
                            className="text-[10px] text-gray-400 hover:text-gray-600">Cancel</button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmDeleteProject(p.id)}
                          className="text-gray-300 hover:text-red-400 text-xs flex-shrink-0 transition-colors" title="Delete project">✕</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="space-y-1.5">
                <p className="text-[10px] uppercase tracking-widest text-gray-500">New project</p>
                <div className="flex gap-2">
                  <input value={newProjectName} onChange={e => { setNewProjectName(e.target.value); setProjectError(""); }}
                    onKeyDown={e => { if (e.key === "Enter") createProject(); }}
                    placeholder="Project name…"
                    className="flex-1 bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
                  <button onClick={createProject} disabled={!newProjectName.trim()}
                    className="px-4 bg-gray-900 text-white text-xs font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors">
                    Create
                  </button>
                </div>
                {projectError && <p className="text-red-500 text-[11px]">{projectError}</p>}
              </div>
            </div>
          </div>
        ) : view === "script" ? (
          <ScriptWriter
            onUseImagePrompt={() => {}}
            onProduceScript={handleProduceScript}
            projects={projects}
            activeProjectId={activeProjectId}
            onProjectSelect={id => { setActiveProjectId(id); setActiveId(null); setMessages([]); loadConversations(id); }}
            onProjectsChange={loadProjects}
          />
        ) : view === "adpack" ? (
          <AdPackPanel
            projectId={activeProjectId}
            onCreated={() => {}}
            onGoToProduce={(id) => { setActiveProductionId(id); setView("produce"); }}
          />
        ) : view === "produce" ? (
          <ProducePanel
            projectId={activeProjectId}
            selectedId={activeProductionId}
            onSelect={setActiveProductionId}
          />
        ) : view === "library" ? (
          <Library projectId={activeProjectId} projects={projects} onProjectsChange={loadProjects} />
        ) : !activeId ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 text-gray-500">
            <div className="text-4xl">◆</div>
            <p className="text-sm">Start a new conversation to generate images or videos</p>
          </div>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {messages.map(msg => (
                <MessageBubble
                  key={msg.id}
                  msg={msg}
                  onUseAsRef={url => setAttachedImages(prev => prev.includes(url) ? prev : [...prev, url])}
                  onGenerateVideo={handleGenerateVideo}
                  onRetry={setRetrying}
                  precedingUserText={getPrecedingUserText(msg)}
                />
              ))}
              <div ref={bottomRef} />
            </div>

            {/* Character quick-attach */}
            {(() => {
              const activeProject = projects.find(p => p.id === activeProjectId);
              const charImg = activeProject?.character_image;
              if (!charImg) return null;
              const charUrl = `/api/media/${charImg}`;
              const alreadyAttached = attachedImages.includes(charUrl);
              return (
                <div className="px-5 pt-2 flex items-center gap-2 border-t border-gray-200">
                  <img src={charUrl} alt="Character" className="w-8 h-8 object-cover rounded-md border border-gray-200 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-gray-500 leading-tight truncate">
                      <span className="text-gray-500 font-medium">Character</span> · {activeProject.name}
                    </p>
                  </div>
                  <button
                    onClick={() => { if (!alreadyAttached) setAttachedImages(prev => [charUrl, ...prev]); }}
                    disabled={alreadyAttached}
                    className={`flex-shrink-0 px-2.5 py-1 rounded-lg text-[10px] font-medium transition-colors ${alreadyAttached ? "text-gray-500 cursor-default" : "bg-gray-100 text-gray-500 hover:bg-gray-700"}`}>
                    {alreadyAttached ? "Added ✓" : "+ Add to prompt"}
                  </button>
                </div>
              );
            })()}

            {attachedImages.length > 0 && (
              <div className="px-5 py-2 border-t border-gray-200">
                <div className="flex gap-3 flex-wrap items-end">
                  {attachedImages.map((url, i) => {
                    const label = mode === "image"
                      ? (i === 0 ? "Subject / base" : i === 1 ? "Element to add" : `Ref ${i + 1}`)
                      : (i === 0 ? "First frame" : i === 1 ? "Last frame" : `Ref ${i + 1}`);
                    return (
                      <div key={i} className="flex flex-col items-center gap-1">
                        <div className="relative">
                          <img src={url} alt="" className="w-14 h-14 object-cover rounded-lg border border-gray-200" />
                          <button onClick={() => setAttachedImages(prev => prev.filter((_, j) => j !== i))}
                            className="absolute -top-1 -right-1 bg-black text-gray-900 rounded-full w-4 h-4 text-xs flex items-center justify-center leading-none">✕</button>
                        </div>
                        <span className="text-[9px] text-gray-500">{label}</span>
                      </div>
                    );
                  })}
                  {mode === "image" && attachedImages.length === 1 && (
                    <button onClick={() => fileRef.current?.click()}
                      className="w-14 h-14 rounded-lg border border-dashed border-gray-300 flex flex-col items-center justify-center gap-1 text-gray-500 hover:border-[#555] hover:text-gray-500 transition-colors mb-4">
                      <span className="text-lg leading-none">+</span>
                      <span className="text-[8px]">add element</span>
                    </button>
                  )}
                </div>
                {mode === "image" && attachedImages.length >= 2 && (
                  <p className="text-[10px] text-gray-500 mt-1.5">Nano Banana will composite the element into the subject — describe what to do in the prompt</p>
                )}
              </div>
            )}

            {/* Retry panel */}
            {retrying && activeId && (
              <div className="px-4 pb-2 border-t border-gray-200">
                <RetryPanel
                  state={retrying}
                  activeId={activeId}
                  mode={mode}
                  imageModel={imageModel}
                  aspectRatio={aspectRatio}
                  shotStyle={shotStyle}
                  videoQuality={videoQuality}
                  cameraShot={cameraShot}
                  videoLighting={videoLighting}
                  attachedImages={attachedImages}
                  onDone={handleRetryDone}
                  onCancel={() => setRetrying(null)}
                />
              </div>
            )}

            <div className="border-t border-gray-200 p-4 space-y-3">
              <div className="flex items-center gap-2 text-xs flex-wrap">
                <div className="flex rounded-lg border border-gray-200 overflow-hidden">
                  {(["image", "video"] as Mode[]).map(m => (
                    <button key={m} onClick={() => setMode(m)}
                      className={`px-3 py-1.5 transition-colors capitalize ${mode === m ? "bg-gray-900 text-white font-semibold" : "text-gray-500 hover:text-gray-500"}`}>
                      {m}
                    </button>
                  ))}
                </div>

                {mode === "image" && (<>
                  <select value={imageModel} onChange={e => setImageModel(e.target.value as ImageModel)}
                    className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1.5 text-xs">
                    <option value="google/nano-banana">Nano Banana</option>
                    <option value="google/nano-banana">Nano Banana Pro</option>
                    <option value="nano-banana-2">Nano Banana 2</option>
                  </select>
                  <select value={aspectRatio} onChange={e => setAspectRatio(e.target.value as AspectRatio)}
                    className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1.5 text-xs">
                    <option value="1:1">Square 1:1</option>
                    <option value="16:9">Landscape 16:9</option>
                    <option value="9:16">Portrait 9:16</option>
                    <option value="4:3">4:3</option>
                    <option value="3:4">3:4</option>
                  </select>
                  <select value={shotStyle} onChange={e => setShotStyle(e.target.value as ShotStyle)}
                    className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1.5 text-xs">
                    <option value="">Shot style</option>
                    <option value="Selfie">Selfie</option>
                    <option value="35mm film">35mm film</option>
                    <option value="Cinematic">Cinematic</option>
                    <option value="Macro">Macro</option>
                    <option value="Polaroid">Polaroid</option>
                    <option value="DSLR portrait">DSLR portrait</option>
                    <option value="Drone aerial">Drone aerial</option>
                    <option value="Fish-eye">Fish-eye</option>
                    <option value="Long exposure">Long exposure</option>
                    <option value="Black and white">Black and white</option>
                    <option value="Double exposure">Double exposure</option>
                    <option value="Tilt-shift">Tilt-shift</option>
                  </select>
                </>)}

                {mode === "video" && (<>
                  <select value={videoQuality} onChange={e => setVideoQuality(e.target.value as VideoQuality)}
                    className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1.5 text-xs">
                    <option value="fast">Veo 3 Fast (~$0.30)</option>
                    <option value="quality">Veo 3 Quality (~$2.00)</option>
                  </select>
                  <select value={cameraShot} onChange={e => setCameraShot(e.target.value as CameraShot)}
                    className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1.5 text-xs">
                    <option value="">Camera shot</option>
                    <option value="Wide shot">Wide shot</option>
                    <option value="Close-up shot">Close-up</option>
                    <option value="Extreme close-up">Extreme close-up</option>
                    <option value="Aerial shot">Aerial / drone</option>
                    <option value="Low angle shot">Low angle</option>
                    <option value="High angle shot">High angle</option>
                    <option value="Pan left">Pan left</option>
                    <option value="Pan right">Pan right</option>
                    <option value="Tilt up">Tilt up</option>
                    <option value="Tilt down">Tilt down</option>
                    <option value="Zoom in">Zoom in</option>
                    <option value="Zoom out">Zoom out</option>
                    <option value="Tracking shot">Tracking shot</option>
                    <option value="Dolly shot">Dolly shot</option>
                    <option value="Handheld shot">Handheld</option>
                    <option value="Static shot">Static</option>
                  </select>
                  <select value={videoLighting} onChange={e => setVideoLighting(e.target.value as VideoLighting)}
                    className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1.5 text-xs">
                    <option value="">Lighting</option>
                    <option value="Natural daylight">Natural daylight</option>
                    <option value="Golden hour">Golden hour</option>
                    <option value="Blue hour">Blue hour</option>
                    <option value="Overcast">Overcast</option>
                    <option value="Studio lighting">Studio lighting</option>
                    <option value="Neon lights">Neon lights</option>
                    <option value="Candlelight">Candlelight</option>
                    <option value="Backlit">Backlit</option>
                    <option value="High contrast">High contrast</option>
                    <option value="Soft diffused">Soft diffused</option>
                    <option value="Harsh shadows">Harsh shadows</option>
                    <option value="Practical lights only">Practical lights only</option>
                  </select>
                  <DirectorPanel
                    lastShot={lastVideoShot}
                    attachedImageUrl={attachedImages[0] ?? null}
                    onPromptGenerated={p => setPrompt(p)}
                  />
                </>)}

                <button onClick={() => fileRef.current?.click()} disabled={uploading}
                  className="px-3 py-1.5 border border-gray-200 text-gray-500 hover:text-gray-500 rounded-lg transition-colors">
                  {uploading ? "Uploading…" : "Attach"}
                </button>
                <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={handleUpload} />
              </div>

              <form onSubmit={handleSubmit} className="flex gap-3">
                <textarea value={prompt} onChange={e => setPrompt(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e as unknown as React.FormEvent); } }}
                  placeholder={mode === "image" ? "Describe the image…" : "Describe the video…"}
                  rows={2}
                  className="flex-1 bg-white border border-gray-300 rounded-xl px-4 py-3 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500 transition-colors"
                />
                <button type="submit" disabled={!prompt.trim() || submitting}
                  className="px-5 bg-gray-900 text-white font-semibold text-sm rounded-xl hover:bg-gray-700 disabled:opacity-20 disabled:cursor-not-allowed transition-all">
                  Generate
                </button>
              </form>
              <p className="text-xs text-gray-500">Enter to send · Shift+Enter for new line · "Generate video from this →" on any image starts the image-first pipeline</p>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
