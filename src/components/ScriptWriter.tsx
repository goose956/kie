import { useState } from "react";

interface Idea {
  hook: string;
  flow: string[];
  payoff: string;
}

interface Shot {
  shot_number: number;
  duration: string;
  description: string;
  image_prompt: string;
  video_prompt?: string;
  camera_shot: string;
  lighting: string;
  director_note: string;
  label_visible?: boolean;
  scene_id?: string;
}

interface OutlineShot {
  shot_number: number;
  screen_direction: string;
  shot_size: string;
  continuity_note: string | null;
  warning: string | null;
}

interface Outline {
  synopsis: string;
  rhythm: string;
  shots: OutlineShot[];
}

interface BRoll {
  after_shot: number;
  type: "cutaway" | "detail" | "reaction" | "environmental";
  description: string;
  image_prompt: string;
  duration: string;
  purpose: string;
}

type Phase = "project" | "character" | "input" | "ideas" | "breakdown";

interface Project { id: number; name: string; character_image: string | null; character_image_url: string | null; created_at: string; }

const TONES = ["", "Cinematic", "Humorous", "Emotional", "Gritty", "Aspirational", "Playful", "Minimalist", "Energetic"];
const DURATIONS = ["", "15s", "30s", "60s", "90s", "2 min"];

const SHOT_SIZE_ABBR: Record<string, string> = {
  "extreme-wide": "EWS",
  "wide": "WS",
  "medium-wide": "MWS",
  "medium": "MS",
  "medium-close": "MCU",
  "close-up": "CU",
  "extreme-close-up": "ECU",
};

const DIR_ARROW: Record<string, string> = {
  "left-to-right": "→",
  "right-to-left": "←",
  "towards-camera": "↗",
  "away-from-camera": "↙",
  "neutral": "·",
};

function loadProjectMeta() {
  try { return JSON.parse(localStorage.getItem("kie-studio-project") ?? "{}"); } catch { return {}; }
}

// ── Outline filmstrip ─────────────────────────────────────────────────────────

function OutlineStrip({ outline, shots, generatedShots }: {
  outline: Outline;
  shots: Shot[];
  generatedShots: Set<number>;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const sel = selected !== null ? outline.shots.find(s => s.shot_number === selected) : null;
  const selShot = selected !== null ? shots.find(s => s.shot_number === selected) : null;

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden bg-gray-50">
      {/* Synopsis bar */}
      <div className="px-3 py-2 border-b border-gray-200 flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-0.5">Director's outline</p>
          <p className="text-xs text-gray-500">{outline.synopsis}</p>
        </div>
        <p className="text-[10px] text-gray-500 flex-shrink-0 text-right max-w-32">{outline.rhythm}</p>
      </div>

      {/* Filmstrip */}
      <div className="flex overflow-x-auto gap-px bg-gray-100 p-px">
        {outline.shots.map((os) => {
          const shot = shots.find(s => s.shot_number === os.shot_number);
          const isDone = generatedShots.has(os.shot_number);
          const isSelected = selected === os.shot_number;
          return (
            <div
              key={os.shot_number}
              onClick={() => setSelected(isSelected ? null : os.shot_number)}
              className={`flex-shrink-0 w-24 cursor-pointer transition-all ${
                isSelected ? "bg-gray-100" : "bg-gray-50 hover:bg-gray-50"
              }`}
            >
              {/* Thumbnail area */}
              <div className={`h-14 flex flex-col items-center justify-center gap-1 border-b ${
                os.warning ? "border-amber-400" : "border-gray-200"
              } ${isDone ? "bg-green-100" : ""}`}>
                <span className="text-sm font-bold text-gray-500">{SHOT_SIZE_ABBR[os.shot_size] ?? "?"}</span>
                <span className="text-base leading-none">{DIR_ARROW[os.screen_direction] ?? "·"}</span>
                {isDone && <span className="text-[8px] text-green-500 tracking-wide">DONE</span>}
              </div>
              {/* Shot number + duration */}
              <div className="px-1.5 py-1.5 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold text-gray-500">{os.shot_number}</span>
                  <span className="text-[9px] text-gray-500">{shot?.duration ?? ""}</span>
                </div>
                <p className="text-[9px] text-gray-500 leading-tight line-clamp-2">{shot?.description ?? ""}</p>
              </div>
              {/* Warning pip */}
              {os.warning && (
                <div className="px-1.5 pb-1.5">
                  <span className="text-[8px] text-amber-500">⚠ continuity</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Detail panel for selected shot */}
      {sel && selShot && (
        <div className="border-t border-gray-200 px-3 py-3 space-y-2">
          <div className="flex items-start gap-3">
            <div className="flex-1 space-y-1">
              <p className="text-xs text-gray-900 font-medium">Shot {sel.shot_number} — {selShot.camera_shot}</p>
              <p className="text-xs text-gray-500">{selShot.description}</p>
            </div>
            <div className="text-right space-y-1 flex-shrink-0">
              <p className="text-xs text-gray-500">{DIR_ARROW[sel.screen_direction]} {sel.screen_direction.replace(/-/g, " ")}</p>
              <p className="text-xs text-gray-500">{sel.shot_size.replace(/-/g, " ")}</p>
            </div>
          </div>
          {sel.continuity_note && (
            <p className="text-xs text-blue-400/80"><span className="text-gray-500">Note: </span>{sel.continuity_note}</p>
          )}
          {sel.warning && (
            <p className="text-xs text-amber-400"><span className="text-gray-500">⚠ Risk: </span>{sel.warning}</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Idea card ─────────────────────────────────────────────────────────────────

function IdeaCard({ idea, index, onSelect }: { idea: Idea; index: number; onSelect: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-4 py-3 cursor-pointer hover:bg-gray-100 transition-colors" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            <span className="text-xs font-bold text-amber-500 mt-0.5 flex-shrink-0">{["A","B","C"][index]}</span>
            <p className="text-sm text-gray-800 leading-snug">{idea.hook}</p>
          </div>
          <span className="text-gray-500 text-xs flex-shrink-0">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-200">
          <div className="pt-3">
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">Flow</p>
            <ol className="space-y-1">
              {idea.flow.map((beat, i) => (
                <li key={i} className="flex gap-2 text-xs text-gray-500">
                  <span className="text-gray-500 flex-shrink-0">{i + 1}.</span>
                  <span>{beat}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5">Payoff</p>
            <p className="text-xs text-amber-400/80 italic">{idea.payoff}</p>
          </div>
          <button onClick={onSelect} className="w-full bg-gray-900 text-white text-xs font-semibold rounded-lg py-2 hover:bg-gray-700 transition-colors">
            Use this concept → build shot list
          </button>
        </div>
      )}
    </div>
  );
}

// ── Shot row ──────────────────────────────────────────────────────────────────

function ShotRow({ shot, allShots, onUsePrompt, onMarkDone }: {
  shot: Shot;
  allShots: Shot[];
  onUsePrompt: (prompt: string, camera: string, lighting: string) => void;
  onMarkDone: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [refined, setRefined] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [copied, setCopied] = useState(false);

  const prevShot = allShots.find(s => s.shot_number === shot.shot_number - 1) ?? null;
  const nextShot = allShots.find(s => s.shot_number === shot.shot_number + 1) ?? null;
  const meta = loadProjectMeta();

  async function directorReview() {
    setReviewing(true);
    setReviewError("");
    try {
      const res = await fetch("/api/director/review-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shot,
          previousShot: prevShot,
          nextShot,
          originalPrompt: shot.image_prompt,
          projectSettings: meta,
        }),
      });
      const data = await res.json();
      if (data.error) { setReviewError(data.error); return; }
      setRefined(data.refined);
    } catch (e) {
      setReviewError(String(e));
    } finally {
      setReviewing(false);
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const activePrompt = refined ?? shot.image_prompt;

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-100 transition-colors" onClick={() => setExpanded(e => !e)}>
        <span className="text-xs font-bold text-gray-500 w-5 flex-shrink-0">{shot.shot_number}</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-500 truncate">{shot.description}</p>
          <p className="text-[10px] text-gray-500 mt-0.5">{shot.camera_shot} · {shot.duration}</p>
        </div>
        {refined && <span className="text-[9px] text-amber-500 flex-shrink-0">Director reviewed</span>}
        <span className="text-gray-500 text-xs flex-shrink-0">{expanded ? "▲" : "▼"}</span>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-gray-200 pt-3">

          {/* Original prompt */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">
              {refined ? "Original prompt" : "Image prompt"}
            </p>
            <p className={`text-xs leading-relaxed bg-gray-50 rounded-lg p-3 border border-gray-200 ${refined ? "text-gray-500 line-through" : "text-gray-500"}`}>
              {shot.image_prompt}
            </p>
          </div>

          {/* Refined prompt */}
          {refined && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-amber-500/70 mb-1">Director-reviewed prompt</p>
              <p className="text-xs text-gray-800 leading-relaxed bg-green-50 rounded-lg p-3 border border-amber-300">
                {refined}
              </p>
            </div>
          )}

          {reviewError && <p className="text-red-400 text-xs">{reviewError}</p>}

          {shot.director_note && (
            <p className="text-xs text-gray-500"><span className="text-gray-500">Director: </span>{shot.director_note}</p>
          )}

          {/* Actions */}
          <div className="space-y-2">
            {/* Director review button */}
            {!refined && (
              <button
                onClick={directorReview}
                disabled={reviewing}
                className="w-full py-1.5 border border-amber-400 text-amber-500 hover:bg-amber-500/10 text-xs font-medium rounded-lg transition-colors disabled:opacity-40"
              >
                {reviewing ? "Director reviewing…" : "Director: review for continuity first"}
              </button>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => { onUsePrompt(activePrompt, shot.camera_shot, shot.lighting); onMarkDone(); }}
                className="flex-1 bg-gray-900 text-white text-xs font-semibold rounded-lg py-1.5 hover:bg-gray-700 transition-colors"
              >
                Generate image →
              </button>
              <button
                onClick={() => copy(activePrompt)}
                className="px-3 py-1.5 border border-gray-200 text-gray-500 hover:text-gray-500 text-xs rounded-lg transition-colors"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface Props {
  onUseImagePrompt: (prompt: string, camera: string, lighting: string) => void;
  onProduceScript: (shots: Shot[], productMode: boolean) => void;
  projects: Project[];
  activeProjectId: number | null;
  onProjectSelect: (id: number | null) => void;
  onProjectsChange: () => void;
}

export default function ScriptWriter({ onUseImagePrompt, onProduceScript, projects, activeProjectId, onProjectSelect, onProjectsChange }: Props) {
  const [phase, setPhase] = useState<Phase>("project");
  const meta = loadProjectMeta();
  const [concept, setConcept] = useState("");
  const [brand, setBrand] = useState(meta.name ?? "");
  const [tone, setTone] = useState("");
  const [duration, setDuration] = useState("");
  const [audience, setAudience] = useState("");
  const [productMode, setProductMode] = useState(false);

  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [ideasError, setIdeasError] = useState("");

  const [selectedIdea, setSelectedIdea] = useState<Idea | null>(null);
  const [shots, setShots] = useState<Shot[]>([]);
  const [loadingShots, setLoadingShots] = useState(false);
  const [shotsError, setShotsError] = useState("");

  const [outline, setOutline] = useState<Outline | null>(null);
  const [loadingOutline, setLoadingOutline] = useState(false);

  const [broll, setBroll] = useState<BRoll[]>([]);
  const [loadingBroll, setLoadingBroll] = useState(false);
  const [brollError, setBrollError] = useState("");
  const [brollExpanded, setBrollExpanded] = useState<number | null>(null);

  const [generatedShots, setGeneratedShots] = useState<Set<number>>(new Set());

  // Project phase
  const [newProjectName, setNewProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);

  // Character phase
  const [charPrompt, setCharPrompt] = useState("");
  const [charModel, setCharModel] = useState<"google/nano-banana" | "nano-banana-2">("nano-banana-2");
  const [charAspectRatio, setCharAspectRatio] = useState("1:1");
  const [charResolution, setCharResolution] = useState<"1K" | "2K" | "4K">("1K");
  const [charGenerating, setCharGenerating] = useState(false);
  const [charError, setCharError] = useState("");
  const [charPreview, setCharPreview] = useState<string | null>(null); // relative filename
  const [charPreviewUrl, setCharPreviewUrl] = useState<string | null>(null); // CDN URL for re-editing
  const [charEditing, setCharEditing] = useState(false); // showing edit panel on existing image
  const [charCleared, setCharCleared] = useState(false); // user hit "Generate new" — ignore DB value

  async function createProject() {
    if (!newProjectName.trim()) return;
    setCreatingProject(true);
    const res = await fetch("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newProjectName.trim() }),
    });
    const p: Project = await res.json();
    onProjectsChange();
    onProjectSelect(p.id);
    setNewProjectName("");
    setCreatingProject(false);
    setPhase("character");
  }

  async function deleteProject(id: number) {
    await fetch("/api/projects", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    onProjectsChange();
    if (activeProjectId === id) onProjectSelect(null);
  }

  async function generateCharacter(editImageUrl?: string) {
    if (!charPrompt.trim() || !activeProjectId) return;
    setCharGenerating(true); setCharError("");
    if (!editImageUrl) { setCharPreview(null); setCharPreviewUrl(null); }
    try {
      const res = await fetch("/api/projects/generate-character", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: activeProjectId,
          prompt: charPrompt,
          model: charModel,
          aspectRatio: charAspectRatio,
          resolution: charResolution,
          imageUrl: editImageUrl ?? null,
        }),
      });
      const { taskId, error } = await res.json();
      if (error) { setCharError(error); return; }

      // Poll until done — max 60 attempts (~2 min)
      let attempts = 0;
      const poll = async (): Promise<void> => {
        if (attempts++ > 60) { setCharError("Timed out — kie.ai took too long. Try again."); return; }
        const r = await fetch(`/api/projects/poll-character?taskId=${taskId}&projectId=${activeProjectId}`);
        if (!r.ok) { setCharError(`Poll error (${r.status})`); return; }
        const d = await r.json();
        if (d.error) { setCharError(d.error); return; }
        if (d.status === "done") {
          setCharPreview(d.filename);
          setCharPreviewUrl(d.imageUrl ?? null);
          setCharEditing(false);
          setCharCleared(false);
          onProjectsChange();
        } else if (d.status === "failed") setCharError(d.error ?? "Generation failed — try again.");
        else { await new Promise(res => setTimeout(res, 2000)); return poll(); }
      };
      await poll();
    } catch (e) { setCharError(String(e)); }
    finally { setCharGenerating(false); }
  }

  async function generateIdeas() {
    if (!concept.trim()) return;
    setLoadingIdeas(true);
    setIdeasError("");
    try {
      const res = await fetch("/api/script/ideas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ concept, brand, tone, duration, audience }),
      });
      const data = await res.json();
      if (data.error) { setIdeasError(data.error); return; }
      setIdeas(data.ideas);
      setPhase("ideas");
    } catch (e) { setIdeasError(String(e)); }
    finally { setLoadingIdeas(false); }
  }

  async function selectIdea(idea: Idea) {
    setSelectedIdea(idea);
    setShots([]);
    setOutline(null);
    setGeneratedShots(new Set());
    setLoadingShots(true);
    setShotsError("");
    setPhase("breakdown");
    const m = loadProjectMeta();

    try {
      const res = await fetch("/api/script/breakdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, brand, tone, duration, visualStyle: m.visualStyle ?? "", screenDirection: m.screenDirection ?? "", mode: productMode ? "product" : undefined }),
      });
      const data = await res.json();
      if (data.error) { setShotsError(data.error); return; }
      setShots(data.shots);

      // Auto-generate outline once shots are ready
      setLoadingOutline(true);
      try {
        const oRes = await fetch("/api/script/outline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shots: data.shots, projectSettings: m }),
        });
        const oData = await oRes.json();
        if (!oData.error) setOutline(oData);
      } catch {} finally { setLoadingOutline(false); }

    } catch (e) { setShotsError(String(e)); }
    finally { setLoadingShots(false); }
  }

  async function generateBroll() {
    setLoadingBroll(true); setBrollError("");
    try {
      const res = await fetch("/api/script/broll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots, brand, tone }),
      });
      const data = await res.json();
      if (data.error) { setBrollError(data.error); return; }
      setBroll(data.broll);
    } catch (e) { setBrollError(String(e)); }
    finally { setLoadingBroll(false); }
  }

  function exportShotList() {
    const lines = [
      `SHOT LIST EXPORT`,
      selectedIdea ? `Concept: ${selectedIdea.hook}` : "",
      `Brand: ${brand || "—"} | Tone: ${tone || "—"} | Duration: ${duration || "—"}`,
      "",
      "── MAIN SHOTS ──────────────────────────────────────────",
      ...shots.map(s => [
        `Shot ${s.shot_number} | ${s.camera_shot} | ${s.duration}`,
        `Description: ${s.description}`,
        `Image prompt: ${s.image_prompt}`,
        `Lighting: ${s.lighting}`,
        `Director note: ${s.director_note}`,
        "",
      ].join("\n")),
      ...(broll.length ? [
        "── B-ROLL ──────────────────────────────────────────────",
        ...broll.map(b => [
          `After shot ${b.after_shot} | ${b.type} | ${b.duration}`,
          `Description: ${b.description}`,
          `Image prompt: ${b.image_prompt}`,
          `Purpose: ${b.purpose}`,
          "",
        ].join("\n")),
      ] : []),
    ].join("\n");

    const blob = new Blob([lines], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `shot-list-${Date.now()}.txt`;
    a.click();
  }

  function reset() { setPhase("project"); setIdeas([]); setShots([]); setSelectedIdea(null); setOutline(null); setBroll([]); setGeneratedShots(new Set()); setCharPreview(null); setCharError(""); }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 flex-shrink-0">
        <div>
          <p className="text-xs font-semibold text-gray-900 tracking-wide">SCRIPT WRITER</p>
          <p className="text-[10px] text-gray-500 mt-0.5">
            {phase === "project" && "Select or create a project"}
            {phase === "character" && "Establish main character"}
            {phase === "input" && "Generate video concepts"}
            {phase === "ideas" && "Select a concept"}
            {phase === "breakdown" && (loadingShots ? "Building shot list…" : `Shot list · ${shots.length} shots`)}
          </p>
        </div>
        {/* Breadcrumb steps */}
        <div className="flex items-center gap-1.5 text-[10px]">
          {(["project","character","input","ideas","breakdown"] as Phase[]).map((p, i) => {
            const labels: Record<Phase, string> = { project: "Project", character: "Character", input: "Script", ideas: "Ideas", breakdown: "Shots" };
            const passed = ["project","character","input","ideas","breakdown"].indexOf(phase) > i;
            const active = phase === p;
            return (
              <span key={p} className={`${active ? "text-gray-900 font-medium" : passed ? "text-gray-500" : "text-gray-800"}`}>
                {labels[p]}{i < 4 ? <span className="ml-1.5 text-gray-800">·</span> : ""}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">

        {/* ── Project ── */}
        {phase === "project" && (
          <div className="p-4 space-y-4">
            {/* Existing projects */}
            {projects.length > 0 && (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-widest text-gray-500">Your projects</p>
                {projects.map(p => (
                  <div key={p.id} className="flex items-center gap-3 border border-gray-200 rounded-xl px-3 py-2.5 hover:bg-gray-50 transition-colors group">
                    {p.character_image
                      ? <img src={`/api/media/${p.character_image}`} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-300 flex-shrink-0" />
                      : <div className="w-8 h-8 rounded-full bg-gray-100 border border-gray-200 flex-shrink-0 flex items-center justify-center text-gray-500 text-xs">?</div>
                    }
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-800 truncate">{p.name}</p>
                      <p className="text-[10px] text-gray-500">{p.character_image ? "Character set" : "No character yet"}</p>
                    </div>
                    <div className="flex gap-2 items-center">
                      <button onClick={() => { onProjectSelect(p.id); setPhase("character"); setCharPreview(null); }}
                        className="px-3 py-1 bg-gray-900 text-white text-xs font-medium rounded-lg hover:bg-gray-700 transition-colors flex-shrink-0">
                        Select →
                      </button>
                      <button onClick={() => deleteProject(p.id)}
                        className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 text-xs transition-all px-1">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Create new project */}
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">New project</p>
              <input value={newProjectName} onChange={e => setNewProjectName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createProject(); }}
                placeholder="Project name…"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
              <button onClick={createProject} disabled={!newProjectName.trim() || creatingProject}
                className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                {creatingProject ? "Creating…" : "Create project →"}
              </button>
            </div>
          </div>
        )}

        {/* ── Character ── */}
        {phase === "character" && (() => {
          const activeProject = projects.find(p => p.id === activeProjectId);
          const existingChar = charCleared ? (charPreview ?? null) : (charPreview ?? activeProject?.character_image ?? null);
          const existingUrl = charCleared ? (charPreviewUrl ?? null) : (charPreviewUrl ?? activeProject?.character_image_url ?? null);

          // Controls strip shared by generate + edit panels
          const Controls = () => (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Model</label>
                <select value={charModel} onChange={e => setCharModel(e.target.value as typeof charModel)}
                  className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black focus:outline-none focus:border-gray-500">
                  <option value="nano-banana-2">Nano Banana 2 (better)</option>
                  <option value="google/nano-banana">Nano Banana v1</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Aspect ratio</label>
                <select value={charAspectRatio} onChange={e => setCharAspectRatio(e.target.value)}
                  className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black focus:outline-none focus:border-gray-500">
                  {["1:1","16:9","9:16","4:3","3:4"].map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              {charModel === "nano-banana-2" && (
                <div>
                  <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Resolution</label>
                  <select value={charResolution} onChange={e => setCharResolution(e.target.value as typeof charResolution)}
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black focus:outline-none focus:border-gray-500">
                    <option value="1K">1K (fast)</option>
                    <option value="2K">2K</option>
                    <option value="4K">4K (slow)</option>
                  </select>
                </div>
              )}
            </div>
          );

          return (
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-900 font-medium">{activeProject?.name}</p>
                <button onClick={() => setPhase("project")} className="text-xs text-gray-500 hover:text-gray-500 transition-colors">← Projects</button>
              </div>

              {/* Existing character — show image + actions */}
              {existingChar && !charEditing && (
                <div className="space-y-3">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500">Character image</p>
                  <img src={`/api/media/${existingChar}`} alt="Character" className="w-full max-h-64 object-contain rounded-xl border border-gray-200 bg-gray-50" />
                  <button onClick={() => setPhase("input")}
                    className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 transition-all">
                    Use this character → write script
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    {existingUrl && (
                      <button onClick={() => { setCharEditing(true); }}
                        className="py-2 border border-gray-200 rounded-xl text-xs text-gray-700 hover:bg-gray-50 transition-colors">
                        Edit this image
                      </button>
                    )}
                    <button onClick={() => { setCharPreview(null); setCharPreviewUrl(null); setCharEditing(false); setCharPrompt(""); setCharCleared(true); }}
                      className="py-2 border border-gray-200 rounded-xl text-xs text-gray-500 hover:bg-gray-50 transition-colors">
                      Generate new
                    </button>
                    <button onClick={async () => {
                      await fetch("/api/projects/remove-character", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: activeProjectId }) });
                      setCharPreview(null); setCharPreviewUrl(null); setCharEditing(false); setCharPrompt(""); setCharCleared(true);
                      onProjectsChange();
                    }} className="py-2 border border-red-100 rounded-xl text-xs text-red-400 hover:bg-red-50 transition-colors col-span-2">
                      Remove image
                    </button>
                  </div>
                </div>
              )}

              {/* Edit panel — uses existing image as reference */}
              {existingChar && charEditing && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500">Edit character</p>
                    <button onClick={() => setCharEditing(false)} className="text-xs text-gray-500 hover:text-gray-500">← Back</button>
                  </div>
                  <img src={`/api/media/${existingChar}`} alt="Character" className="w-full max-h-40 object-contain rounded-xl border border-gray-200 bg-gray-50 opacity-60" />
                  <div>
                    <p className="text-[10px] text-gray-500 mb-1">Describe the changes you want, or refine the whole prompt</p>
                    <textarea value={charPrompt} onChange={e => setCharPrompt(e.target.value)}
                      placeholder="e.g. same character but change jacket to navy blue, remove sunglasses, add a smile"
                      rows={4}
                      className="w-full bg-white border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
                  </div>
                  <Controls />
                  {charError && <p className="text-red-400 text-xs">{charError}</p>}
                  {charGenerating && (
                    <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                      <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
                      Generating edited character…
                    </div>
                  )}
                  <button onClick={() => generateCharacter(existingUrl!)} disabled={!charPrompt.trim() || charGenerating}
                    className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                    Apply edits
                  </button>
                </div>
              )}

              {/* Generate new character */}
              {!existingChar && (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Describe your character</p>
                    <p className="text-[10px] text-gray-500 mb-2">Be specific — age, build, clothing, distinguishing features. This image anchors every shot.</p>
                    <textarea value={charPrompt} onChange={e => setCharPrompt(e.target.value)}
                      placeholder="e.g. Athletic white male, early 30s, dark stubble, wearing a grey technical jacket and red running shoes, full body, neutral pose, clean studio background"
                      rows={4}
                      className="w-full bg-white border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
                  </div>
                  <Controls />
                  {charError && <p className="text-red-400 text-xs">{charError}</p>}
                  {charGenerating && (
                    <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                      <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
                      Generating character…
                    </div>
                  )}
                  <button onClick={() => generateCharacter()} disabled={!charPrompt.trim() || charGenerating}
                    className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
                    Generate character image
                  </button>
                  <button onClick={() => setPhase("input")}
                    className="w-full text-xs text-gray-500 hover:text-gray-500 transition-colors py-1">
                    Skip — write script without character
                  </button>
                </div>
              )}
            </div>
          );
        })()}

        {/* ── Input ── */}
        {phase === "input" && (
          <div className="p-4 space-y-3">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Concept *</label>
              <textarea
                value={concept}
                onChange={(e) => setConcept(e.target.value)}
                placeholder="Describe the rough idea — e.g. a shoe ad showing a runner finding their stride at dawn in an empty city"
                rows={4}
                className="w-full bg-white border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500 transition-colors"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Brand / product</label>
                <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. KOVA"
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Target audience</label>
                <input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="e.g. urban runners 25–35"
                  className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Tone</label>
                <select value={tone} onChange={(e) => setTone(e.target.value)}
                  className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                  {TONES.map(t => <option key={t} value={t}>{t || "Any"}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Duration</label>
                <select value={duration} onChange={(e) => setDuration(e.target.value)}
                  className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                  {DURATIONS.map(d => <option key={d} value={d}>{d || "Any"}</option>)}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
              <input type="checkbox" checked={productMode} onChange={e => setProductMode(e.target.checked)} />
              Product ad mode — hero the product, drink-ad craft, end on a clean product shot
            </label>
            {ideasError && <p className="text-red-400 text-xs">{ideasError}</p>}
            <button onClick={generateIdeas} disabled={!concept.trim() || loadingIdeas}
              className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              {loadingIdeas ? "Generating concepts…" : "Generate concepts"}
            </button>
          </div>
        )}

        {/* ── Ideas ── */}
        {phase === "ideas" && (
          <div className="p-4 space-y-3">
            <p className="text-xs text-gray-500">Expand each concept, then select one to build the shot list.</p>
            {ideas.map((idea, i) => (
              <IdeaCard key={i} idea={idea} index={i} onSelect={() => selectIdea(idea)} />
            ))}
          </div>
        )}

        {/* ── Breakdown ── */}
        {phase === "breakdown" && (
          <div className="p-4 space-y-3">
            {/* Idea summary */}
            {selectedIdea && (
              <div className="rounded-xl bg-gray-50 border border-gray-200 p-3 space-y-1">
                <p className="text-xs text-gray-900 font-medium">{selectedIdea.hook}</p>
                <p className="text-xs text-amber-400/70 italic">{selectedIdea.payoff}</p>
              </div>
            )}

            {/* Loading states */}
            {loadingShots && (
              <div className="flex items-center gap-2 text-xs text-gray-500 py-2">
                <div className="w-4 h-4 border-2 border-gray-600 border-t-gray-300 rounded-full animate-spin" />
                Building shot list…
              </div>
            )}

            {/* Director's outline filmstrip */}
            {!loadingShots && shots.length > 0 && (
              loadingOutline ? (
                <div className="flex items-center gap-2 text-xs text-gray-500 py-1">
                  <div className="w-3 h-3 border border-gray-700 border-t-gray-400 rounded-full animate-spin" />
                  Director reviewing sequence…
                </div>
              ) : outline ? (
                <OutlineStrip outline={outline} shots={shots} generatedShots={generatedShots} />
              ) : null
            )}

            {shotsError && <p className="text-red-400 text-xs">{shotsError}</p>}

            {/* Shot list */}
            {shots.map(shot => (
              <ShotRow
                key={shot.shot_number}
                shot={shot}
                allShots={shots}
                onUsePrompt={onUseImagePrompt}
                onMarkDone={() => setGeneratedShots(prev => new Set([...prev, shot.shot_number]))}
              />
            ))}

            {/* B-roll section */}
            {shots.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-gray-200">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500">B-Roll suggestions</p>
                  {broll.length === 0 && (
                    <button onClick={generateBroll} disabled={loadingBroll}
                      className="text-xs text-gray-500 hover:text-gray-800 transition-colors disabled:opacity-40">
                      {loadingBroll ? "Generating…" : "Generate B-roll →"}
                    </button>
                  )}
                </div>
                {brollError && <p className="text-red-400 text-xs">{brollError}</p>}
                {broll.map((b, i) => (
                  <div key={i} className="border border-gray-200 rounded-xl overflow-hidden">
                    <div className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-100 transition-colors"
                      onClick={() => setBrollExpanded(brollExpanded === i ? null : i)}>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 uppercase tracking-wide flex-shrink-0">{b.type}</span>
                      <p className="flex-1 text-xs text-gray-500 truncate">{b.description}</p>
                      <span className="text-[10px] text-gray-500 flex-shrink-0">after {b.after_shot} · {b.duration}</span>
                      <span className="text-gray-500 text-xs">{brollExpanded === i ? "▲" : "▼"}</span>
                    </div>
                    {brollExpanded === i && (
                      <div className="px-4 pb-3 pt-1 border-t border-gray-200 space-y-2">
                        <p className="text-xs text-gray-500"><span className="text-gray-500">Purpose: </span>{b.purpose}</p>
                        <div className="bg-gray-50 rounded-lg p-3 border border-gray-200">
                          <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Image prompt</p>
                          <p className="text-xs text-gray-500 leading-relaxed">{b.image_prompt}</p>
                        </div>
                        <button onClick={() => { onUseImagePrompt(b.image_prompt, "", ""); }}
                          className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
                          Generate image →
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Produce + Export */}
            {shots.length > 0 && (
              <div className="pt-2 border-t border-gray-200 space-y-2">
                <button onClick={() => onProduceScript(shots, productMode)}
                  className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 transition-all">
                  Produce this script → batch keyframe + video
                </button>
                <div className="flex justify-center">
                  <button onClick={exportShotList}
                    className="text-xs text-gray-500 hover:text-gray-500 transition-colors px-4 py-1.5 border border-gray-200 rounded-lg">
                    Export shot list (.txt)
                  </button>
                </div>
              </div>
            )}

            {shots.length > 0 && (
              <p className="text-[10px] text-gray-500 text-center pb-2">
                Use "Director: review for continuity first" before generating — then "Generate image →"
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
