import { useCallback, useEffect, useRef, useState } from "react";

// ── Types (mirror server/db shapes) ───────────────────────────────────────────

type ProductionStatus = "draft" | "producing" | "review" | "assembling" | "done" | "failed";
type ShotStatus = "pending" | "keyframe" | "keyframe_done" | "video" | "video_done" | "failed" | "skipped";

interface Production {
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
  final_video_filename: string | null;
  error: string | null;
  created_at: string;
}

interface ProductionShot {
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
  video_filename: string | null;
  error: string | null;
  take_count: number;
  label_visible: number;
  is_still: number;
  ref_shot: number | null;
  use_character: number;
  bg_asset_id: number | null;
  scene_id: string | null;
  last_frame_url: string | null;
  audit_notes: string | null;
}

interface LibraryAsset {
  id: number;
  kind: "character" | "product" | "background";
  name: string;
  filename: string | null;
  url: string | null;
}

interface FullProduction {
  production: Production;
  shots: ProductionShot[];
  running: boolean;
}

interface Props {
  projectId: number | null;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

const STATUS_STYLE: Record<ShotStatus, { label: string; cls: string }> = {
  pending:       { label: "Pending",  cls: "bg-gray-100 text-gray-500" },
  keyframe:      { label: "Keyframe…", cls: "bg-amber-100 text-amber-600" },
  keyframe_done: { label: "Keyframe ✓", cls: "bg-blue-100 text-blue-600" },
  video:         { label: "Clip…",    cls: "bg-amber-100 text-amber-600" },
  video_done:    { label: "Done",     cls: "bg-green-100 text-green-600" },
  failed:        { label: "Failed",   cls: "bg-red-100 text-red-500" },
  skipped:       { label: "Skipped",  cls: "bg-gray-100 text-gray-400" },
};

const ACTIVE_STATUSES: ProductionStatus[] = ["producing", "assembling"];

// ── Per-shot retry control ─────────────────────────────────────────────────────

function RetryShot({ productionId, shot, dryRun, quality, imageModel, disabled, onDone }: {
  productionId: number;
  shot: ProductionShot;
  dryRun: boolean;
  quality: string;
  imageModel: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState("");
  const [scope, setScope] = useState<"both" | "keyframe" | "video">("both");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await fetch(`/api/productions/${productionId}/retry-shot`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shotId: shot.id,
          keyframeOnly: scope === "keyframe",
          videoOnly: scope === "video",
          notes,
          dryRun,
          quality,
          imageModel,
        }),
      });
      setOpen(false); setNotes("");
      onDone();
    } finally { setBusy(false); }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} disabled={disabled}
        className="text-[10px] text-gray-500 hover:text-gray-800 disabled:opacity-30 transition-colors">
        Retry
      </button>
    );
  }

  return (
    <div className="mt-2 p-2 rounded-lg border border-amber-300 bg-amber-50 space-y-2 w-full">
      <div className="flex gap-1">
        {(["both", "keyframe", "video"] as const).map(s => (
          <button key={s} onClick={() => setScope(s)}
            className={`px-2 py-0.5 rounded text-[10px] capitalize transition-colors ${scope === s ? "bg-gray-900 text-white" : "bg-white border border-gray-200 text-gray-500"}`}>
            {s === "both" ? "Keyframe + clip" : s === "keyframe" ? "Keyframe only" : "Clip only"}
          </button>
        ))}
      </div>
      <input value={notes} onChange={e => setNotes(e.target.value)}
        placeholder="Notes for the regen (optional)…"
        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-black placeholder-gray-400 focus:outline-none" />
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy}
          className="flex-1 bg-amber-500 text-black text-[10px] font-semibold rounded py-1 hover:bg-amber-400 disabled:opacity-40 transition-colors">
          {busy ? "Starting…" : "Regenerate shot"}
        </button>
        <button onClick={() => setOpen(false)} className="px-2 text-[10px] text-gray-500 hover:text-gray-800">Cancel</button>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export default function ProducePanel({ projectId, selectedId, onSelect }: Props) {
  const [list, setList] = useState<Production[]>([]);
  const [full, setFull] = useState<FullProduction | null>(null);
  const [dryRun, setDryRun] = useState(true);
  const [quality, setQuality] = useState("fast");
  const [imageModel, setImageModel] = useState("nano-banana-2");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [heroPrompt, setHeroPrompt] = useState("");
  const [charRef, setCharRef] = useState<{ name: string; image: string | null; url: string | null } | null>(null);
  const [hover, setHover] = useState<{ url: string; type: "image" | "video" } | null>(null);
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [saveKind, setSaveKind] = useState<null | "character" | "product">(null);
  const [saveName, setSaveName] = useState("");
  const [bgName, setBgName] = useState("");
  const [bgPrompt, setBgPrompt] = useState("");
  const [auditResults, setAuditResults] = useState<Array<{ shot_number: number; issue: string; suggestion: string }> | null>(null);
  const productImageRef = useRef<HTMLInputElement>(null);
  const musicRef = useRef<HTMLInputElement>(null);
  const styleRefInputRef = useRef<HTMLInputElement>(null);

  const loadList = useCallback(async () => {
    const url = projectId != null ? `/api/productions?projectId=${projectId}` : "/api/productions";
    const res = await fetch(url);
    setList(await res.json());
  }, [projectId]);

  const loadFull = useCallback(async () => {
    if (selectedId == null) { setFull(null); return; }
    const res = await fetch(`/api/productions/${selectedId}`);
    if (!res.ok) { setFull(null); return; }
    setFull(await res.json());
  }, [selectedId]);

  useEffect(() => { loadList(); }, [loadList]);
  useEffect(() => { loadFull(); }, [loadFull]);

  // Character reference status (the project's character image is used automatically as a keyframe reference).
  const loadCharRef = useCallback(() => {
    if (projectId == null) { setCharRef(null); return; }
    fetch("/api/projects").then(r => r.json()).then((ps: { id: number; name: string; character_image: string | null; character_image_url: string | null }[]) => {
      const p = ps.find(x => x.id === projectId);
      setCharRef(p ? { name: p.name, image: p.character_image, url: p.character_image_url } : null);
    }).catch(() => {});
  }, [projectId]);
  useEffect(() => { loadCharRef(); }, [loadCharRef]);

  const loadLibrary = useCallback(() => {
    fetch("/api/library-assets").then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);
  useEffect(() => { loadLibrary(); }, [loadLibrary]);

  // Poll while a production is selected (4s, matching the rest of the app).
  useEffect(() => {
    if (selectedId == null) return;
    const timer = setInterval(loadFull, 4000);
    return () => clearInterval(timer);
  }, [selectedId, loadFull]);

  async function post(path: string, body?: unknown) {
    setError("");
    const res = await fetch(path, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function produce(stage: "keyframes" | "videos" | "all") {
    if (!full) return;
    setBusy(stage);
    try { await post(`/api/productions/${full.production.id}/produce`, { dryRun, quality, imageModel, stage }); await loadFull(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function stop() {
    if (!full) return;
    setBusy("stop");
    try { await post(`/api/productions/${full.production.id}/stop`); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function assemble() {
    if (!full) return;
    setBusy("assemble");
    try { await post(`/api/productions/${full.production.id}/assemble`, {}); await loadFull(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function upload(kind: "product-image" | "music", file: File) {
    if (!full) return;
    setBusy(kind);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/productions/${full.production.id}/${kind}`, { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await loadFull();
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function reveal() {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/reveal`); }
    catch (e) { setError(String(e)); }
  }

  async function generateHero() {
    if (!full) return;
    setBusy("hero"); setError("");
    try {
      const data = await post(`/api/productions/${full.production.id}/hero`, { prompt: heroPrompt, dryRun });
      if (data.status === "done") { await loadFull(); setBusy(""); return; } // dry-run path
      const taskId = data.taskId;
      let attempts = 0;
      const pollHero = async () => {
        if (attempts++ > 60) { setError("Hero generation timed out"); setBusy(""); return; }
        const r = await fetch(`/api/productions/${full.production.id}/hero-poll?taskId=${taskId}`);
        const d = await r.json();
        if (d.error) { setError(d.error); setBusy(""); return; }
        if (d.status === "done") { setHeroPrompt(""); await loadFull(); setBusy(""); return; }
        if (d.status === "failed") { setError(d.error || "Hero generation failed"); setBusy(""); return; }
        setTimeout(pollHero, 3000);
      };
      pollHero();
    } catch (e) { setError(String(e)); setBusy(""); }
  }

  async function clearHero() {
    if (!full) return;
    setBusy("hero-clear");
    try { await post(`/api/productions/${full.production.id}/hero-clear`); await loadFull(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function saveDuration(shotId: number, duration: string) {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/shot-duration`, { shotId, duration }); await loadFull(); }
    catch (e) { setError(String(e)); }
  }

  async function toggleStill(shotId: number, isStill: boolean) {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/shot-still`, { shotId, isStill }); await loadFull(); }
    catch (e) { setError(String(e)); }
  }

  async function saveRefShot(shotId: number, refShot: number | null) {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/shot-ref`, { shotId, refShot }); await loadFull(); }
    catch (e) { setError(String(e)); }
  }

  async function saveStyle(style: string) {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/style`, { style }); await loadFull(); }
    catch (e) { setError(String(e)); }
  }

  async function setShotRefs(shotId: number, fields: { useCharacter?: boolean; useHero?: boolean; bgAssetId?: number | null }) {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/shot-refs`, { shotId, ...fields }); await loadFull(); }
    catch (e) { setError(String(e)); }
  }

  async function grabBackground(shot: ProductionShot) {
    if (!shot.video_filename) return;
    setBusy("grab");
    try {
      await post("/api/backgrounds/grab", { videoFilename: shot.video_filename, name: `Shot ${shot.shot_number} frame` });
      loadLibrary();
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function generateBackground(name: string, prompt: string) {
    setBusy("bg"); setError("");
    try {
      const data = await post("/api/library-assets/generate", { kind: "background", prompt });
      const taskId = data.taskId;
      let attempts = 0;
      const pollBg = async () => {
        if (attempts++ > 60) { setError("Background generation timed out"); setBusy(""); return; }
        const r = await fetch(`/api/library-assets/generate-poll?taskId=${taskId}&kind=background&name=${encodeURIComponent(name)}`);
        const d = await r.json();
        if (d.error) { setError(d.error); setBusy(""); return; }
        if (d.status === "done") { loadLibrary(); setBusy(""); return; }
        if (d.status === "failed") { setError(d.error || "Background generation failed"); setBusy(""); return; }
        setTimeout(pollBg, 3000);
      };
      pollBg();
    } catch (e) { setError(String(e)); setBusy(""); }
  }

  async function saveToLibrary(kind: "character" | "product", name: string, filename: string | null, url: string | null) {
    if (!url) { setError("Only kie-generated images can be saved (needs a fetchable URL)"); return; }
    try { await post("/api/library-assets", { kind, name, filename, url }); loadLibrary(); }
    catch (e) { setError(String(e)); }
  }

  async function applyLibraryCharacter(assetId: number) {
    if (projectId == null) { setError("Select a project first"); return; }
    try { await post("/api/library-assets/apply-character", { assetId, projectId }); loadCharRef(); }
    catch (e) { setError(String(e)); }
  }

  async function applyLibraryProduct(assetId: number) {
    if (!full) return;
    try { await post(`/api/productions/${full.production.id}/apply-library-product`, { assetId }); await loadFull(); }
    catch (e) { setError(String(e)); }
  }

  async function removeLibraryAsset(id: number) {
    try {
      await fetch("/api/library-assets", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      loadLibrary();
    } catch (e) { setError(String(e)); }
  }

  async function duplicate() {
    if (!full) return;
    setBusy("duplicate");
    try {
      const data = await post(`/api/productions/${full.production.id}/duplicate`);
      await loadList();
      if (data.production) onSelect(data.production.id);
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function auditProduction() {
    if (!full) return;
    setBusy("audit"); setError(""); setAuditResults(null);
    try {
      const data = await post(`/api/productions/${full.production.id}/audit`);
      setAuditResults(data.issues ?? []);
      await loadFull(); // reload so audit_notes appear on each shot
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function uploadStyleRef(file: File) {
    if (!full) return;
    setBusy("style-ref");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/productions/${full.production.id}/style-ref`, { method: "POST", body: form });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      await loadFull();
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function engineerPrompts() {
    if (!full) return;
    setBusy("engineer"); setError("");
    try {
      const data = await post(`/api/productions/${full.production.id}/engineer-prompts`);
      setError(`Batch engineer complete — ${data.updated} shot${data.updated === 1 ? "" : "s"} updated.`);
      await loadFull();
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  // ── List view ──
  if (selectedId == null || !full) {
    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-xs font-semibold text-gray-900 tracking-wide">PRODUCE</p>
            <p className="text-[10px] text-gray-500 mt-0.5">Batch productions — shot list in, finished MP4 out</p>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {list.length === 0 && (
            <p className="text-sm text-gray-500 text-center mt-12">
              No productions yet. Build a shot list in Script Writer, then “Produce this script”.
            </p>
          )}
          {list.map(p => (
            <button key={p.id} onClick={() => onSelect(p.id)}
              className="w-full flex items-center gap-3 border border-gray-200 rounded-xl px-3 py-2.5 hover:bg-gray-50 transition-colors text-left">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-800 truncate">{p.title}</p>
                <p className="text-[10px] text-gray-500">{new Date(p.created_at).toLocaleString()}</p>
              </div>
              <span className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                p.status === "done" ? "bg-green-100 text-green-600" :
                p.status === "failed" ? "bg-red-100 text-red-500" :
                ACTIVE_STATUSES.includes(p.status) ? "bg-amber-100 text-amber-600" :
                "bg-gray-100 text-gray-500"
              }`}>{p.status}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Detail view ──
  const { production, shots, running } = full;
  const done = shots.filter(s => s.status === "video_done").length;
  const kfDone = shots.filter(s => s.keyframe_filename).length;
  const failed = shots.filter(s => s.status === "failed").length;
  const active = running || ACTIVE_STATUSES.includes(production.status);
  const productMode = Boolean(production.product_image_filename);
  const needKeyframes = shots.some(s => !s.keyframe_filename && s.status !== "skipped");
  const readyForVideo = shots.some(s => s.keyframe_filename && s.status !== "video_done" && s.status !== "skipped");
  const totalSecs = shots.reduce((acc, s) => { const m = (s.duration_hint || "").match(/(\d+(?:\.\d+)?)/); return acc + (m ? Number(m[1]) : 0); }, 0);
  const libProducts = library.filter(a => a.kind === "product");
  const libCharacters = library.filter(a => a.kind === "character");
  const libBackgrounds = library.filter(a => a.kind === "background");
  const hasCharacter = Boolean(charRef?.image);
  // How many references a shot sends to kie (keep ≤2 to avoid dilution).
  function refCount(s: ProductionShot): number {
    return (s.label_visible && (production.hero_ref_url || production.product_image_filename) ? 1 : 0)
      + (s.use_character && hasCharacter ? 1 : 0)
      + (s.bg_asset_id ? 1 : 0)
      + (s.ref_shot ? 1 : 0);
  }

  async function confirmSave() {
    if (!saveKind || !saveName.trim()) return;
    if (saveKind === "product") await saveToLibrary("product", saveName, production.hero_ref_filename, production.hero_ref_url);
    else await saveToLibrary("character", saveName, charRef?.image ?? null, charRef?.url ?? null);
    setSaveKind(null); setSaveName("");
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={() => { onSelect(null); loadList(); }}
            className="text-xs text-gray-500 hover:text-gray-800 transition-colors flex-shrink-0">← All</button>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{production.title}</p>
            <p className="text-[10px] text-gray-500">
              {production.status} · {shots.length} shots · ≈{totalSecs}s final · {kfDone}/{shots.length} keyframes · {done}/{shots.length} clips{failed ? ` · ${failed} failed` : ""}{productMode ? " · product mode" : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <label className="flex items-center gap-1 text-[10px] text-gray-500">
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} disabled={active} />
            Dry run
          </label>
          <select value={imageModel} onChange={e => setImageModel(e.target.value)} disabled={active}
            title="Keyframe model — Nano Banana 2 holds the hero/character reference far better"
            className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1 text-[11px]">
            <option value="nano-banana-2">Nano Banana 2 (consistent)</option>
            <option value="google/nano-banana">Nano Banana v1 (cheap draft)</option>
          </select>
          <select value={quality} onChange={e => setQuality(e.target.value)} disabled={active}
            className="bg-white border border-gray-300 text-black rounded-lg px-2 py-1 text-[11px]">
            <option value="fast">Veo Fast</option>
            <option value="quality">Veo Quality</option>
          </select>
          {active
            ? <button onClick={stop} disabled={busy === "stop"}
                className="px-3 py-1.5 bg-red-500 text-white text-xs font-semibold rounded-lg hover:bg-red-400 disabled:opacity-40 transition-colors">
                {busy === "stop" ? "Stopping…" : "Stop"}
              </button>
            : <>
                <button onClick={() => produce("keyframes")} disabled={busy !== "" || !needKeyframes}
                  title="Generate all keyframes only — review them before spending on video"
                  className="px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors">
                  {busy === "keyframes" ? "Starting…" : "1 · Keyframes"}
                </button>
                <button onClick={() => produce("videos")} disabled={busy !== "" || !readyForVideo}
                  title="Animate the approved keyframes into clips"
                  className="px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors">
                  {busy === "videos" ? "Starting…" : "2 · Videos"}
                </button>
              </>
          }
          <button onClick={assemble} disabled={busy === "assemble" || active || done === 0}
            className="px-3 py-1.5 border border-gray-300 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors">
            {busy === "assemble" ? "Assembling…" : "Assemble"}
          </button>
          <button onClick={duplicate} disabled={busy === "duplicate" || active}
            title="Clone this shot list into a fresh production with all shots reset — e.g. to do a real run after a dry-run rehearsal"
            className="px-3 py-1.5 border border-gray-300 text-gray-700 text-xs font-semibold rounded-lg hover:bg-gray-50 disabled:opacity-40 transition-colors">
            {busy === "duplicate" ? "Copying…" : "Duplicate"}
          </button>
          {kfDone > 0 && (
            <button onClick={auditProduction} disabled={busy !== "" || active}
              title="Send all keyframes to Claude Vision for a cross-shot consistency check"
              className="px-3 py-1.5 border border-purple-200 text-purple-600 text-xs font-semibold rounded-lg hover:bg-purple-50 disabled:opacity-40 transition-colors">
              {busy === "audit" ? "Auditing…" : "Audit keyframes"}
            </button>
          )}
          {shots.length > 0 && !active && (
            <button onClick={engineerPrompts} disabled={busy !== ""}
              title="Re-engineer all pending shot prompts in one batch call for coherent wording across shots"
              className="px-3 py-1.5 border border-blue-200 text-blue-600 text-xs font-semibold rounded-lg hover:bg-blue-50 disabled:opacity-40 transition-colors">
              {busy === "engineer" ? "Engineering…" : "Batch engineer"}
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {(error || production.error) && (
          <p className="text-red-500 text-xs bg-red-50 border border-red-100 rounded-lg px-3 py-2">{error || production.error}</p>
        )}

        {/* Audit results summary */}
        {auditResults !== null && (
          <div className={`rounded-xl border px-3 py-2.5 space-y-1.5 ${auditResults.length === 0 ? "border-green-200 bg-green-50" : "border-purple-200 bg-purple-50"}`}>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-purple-600">Keyframe audit</p>
            {auditResults.length === 0 ? (
              <p className="text-xs text-green-600">All keyframes look consistent — no issues detected.</p>
            ) : auditResults.map((r, i) => (
              <div key={i} className="text-xs text-purple-800">
                <span className="font-medium">Shot {r.shot_number}: </span>{r.issue}
                <span className="text-purple-500"> → {r.suggestion}</span>
              </div>
            ))}
            <button onClick={() => setAuditResults(null)} className="text-[10px] text-purple-400 hover:text-purple-600">Dismiss</button>
          </div>
        )}

        {/* Consistency references — anchor the product + character across shots */}
        <div className="border border-gray-200 rounded-xl p-3 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Consistency references</p>
            <span className="text-[10px] text-gray-400">fed into every keyframe</span>
          </div>

          {/* Global rendering style */}
          <div>
            <label className="text-[10px] text-gray-500">Global style (applied to every shot)</label>
            <input key={`style-${production.id}`} defaultValue={production.style ?? ""} disabled={active}
              onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              onBlur={e => { if (e.target.value !== (production.style ?? "")) saveStyle(e.target.value); }}
              placeholder="e.g. claymation stop-motion, handmade clay figures, matte texture — keeps clay from flipping to photoreal"
              className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-[11px] text-black placeholder-gray-400 focus:outline-none focus:border-gray-500 mt-0.5" />
          </div>

          {/* Style reference image (Fix 7) */}
          <div className="flex items-center gap-3">
            {production.style_ref_url ? (
              <img src={production.style_ref_url} alt="Style reference" className="w-16 h-10 object-cover rounded border border-gray-200 flex-shrink-0" />
            ) : (
              <div className="w-16 h-10 rounded border border-dashed border-gray-200 flex items-center justify-center text-[9px] text-gray-400 flex-shrink-0">style ref</div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-gray-500">{production.style_ref_url ? "✓ Style reference active — uploaded to kie and fed into every keyframe." : "Upload a style reference image to set the visual tone across all shots."}</p>
              <button onClick={() => styleRefInputRef.current?.click()} disabled={active || busy === "style-ref"}
                className="text-[11px] text-blue-500 hover:text-blue-400 disabled:opacity-40 mt-0.5">
                {busy === "style-ref" ? "Uploading…" : production.style_ref_url ? "Replace" : "Upload style ref"}
              </button>
              <input ref={styleRefInputRef} type="file" accept="image/*" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadStyleRef(f); e.target.value = ""; }} />
            </div>
          </div>

          {/* Inline library-save naming */}
          {saveKind && (
            <div className="flex gap-2 items-center p-2 bg-gray-50 rounded-lg border border-gray-200">
              <span className="text-[10px] text-gray-500 flex-shrink-0">Save {saveKind} as</span>
              <input value={saveName} onChange={e => setSaveName(e.target.value)} autoFocus
                onKeyDown={e => { if (e.key === "Enter") confirmSave(); if (e.key === "Escape") setSaveKind(null); }}
                className="flex-1 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-black focus:outline-none" />
              <button onClick={confirmSave} disabled={!saveName.trim()}
                className="text-[11px] bg-gray-900 text-white rounded px-2 py-1 disabled:opacity-40">Save</button>
              <button onClick={() => setSaveKind(null)} className="text-[11px] text-gray-500">Cancel</button>
            </div>
          )}

          {/* Hero product reference */}
          <div className="flex gap-3">
            {production.hero_ref_filename ? (
              <img src={`/api/media/${production.hero_ref_filename}`} alt="Hero reference"
                className="w-28 h-20 object-contain rounded-lg border border-gray-200 bg-gray-50 flex-shrink-0" />
            ) : (
              <div className="w-28 h-20 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-[10px] text-gray-400 flex-shrink-0 text-center px-1">
                no hero yet
              </div>
            )}
            <div className="flex-1 min-w-0 space-y-1.5">
              {production.hero_ref_filename ? (
                <>
                  <p className="text-[11px] text-green-600">✓ Hero locked — the product will match this in every shot.</p>
                  <div className="flex gap-3 flex-wrap">
                    <button onClick={clearHero} disabled={active || busy.startsWith("hero")}
                      className="text-[11px] text-gray-500 hover:text-gray-800 disabled:opacity-40">Clear</button>
                    <button onClick={() => setHeroPrompt(heroPrompt || "")}
                      className="text-[11px] text-blue-500 hover:text-blue-400" title="Type a new prompt below and regenerate">Regenerate ↓</button>
                    <button onClick={() => { setSaveKind("product"); setSaveName(production.title); }} disabled={!production.hero_ref_url}
                      className="text-[11px] text-blue-500 hover:text-blue-400 disabled:opacity-40" title="Reuse this product across other ads">★ Save to library</button>
                  </div>
                </>
              ) : (
                <p className="text-[11px] text-gray-500">Generate a hero product still, or reuse one from your library — it anchors the product so it stays identical across shots.</p>
              )}
              {libProducts.length > 0 && (
                <select value="" disabled={active} onChange={e => { if (e.target.value) applyLibraryProduct(Number(e.target.value)); }}
                  className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1 text-[11px] text-black">
                  <option value="">Use product from library… ({libProducts.length})</option>
                  {libProducts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              )}
              <textarea value={heroPrompt} onChange={e => setHeroPrompt(e.target.value)}
                placeholder="Hero still prompt — e.g. matte-black VOLT can, yuzu-citrus, studio lighting, condensation, front label sharp and centred"
                rows={2}
                className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-[11px] text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
              <button onClick={generateHero} disabled={active || busy === "hero" || (!dryRun && !heroPrompt.trim())}
                className="text-[11px] bg-gray-900 text-white font-semibold rounded-lg px-3 py-1 hover:bg-gray-700 disabled:opacity-40 transition-colors">
                {busy === "hero" ? "Generating…" : production.hero_ref_filename ? "Regenerate hero" : "Generate hero still"}
              </button>
            </div>
          </div>

          {/* Character reference status */}
          <div className="pt-1 border-t border-gray-100 space-y-1.5">
            <div className="flex items-center gap-2">
              {charRef?.image ? (
                <>
                  <img src={`/api/media/${charRef.image}`} alt="" className="w-6 h-6 rounded-full object-cover border border-gray-200" />
                  <p className="text-[11px] text-green-600 flex-1">✓ Character reference active — the person stays consistent across shots.</p>
                  <button onClick={() => { setSaveKind("character"); setSaveName(charRef?.name || "Character"); }} disabled={!charRef?.url}
                    className="text-[11px] text-blue-500 hover:text-blue-400 disabled:opacity-40 flex-shrink-0" title="Reuse this character across other ads">★ Save to library</button>
                </>
              ) : (
                <p className="text-[11px] text-gray-400">
                  No character set — the on-camera person won't be locked. Pick one from your library below, or add one in Script Writer → Character.
                </p>
              )}
            </div>
            {libCharacters.length > 0 && (
              <select value="" onChange={e => { if (e.target.value) applyLibraryCharacter(Number(e.target.value)); }}
                className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1 text-[11px] text-black">
                <option value="">Use character from library… ({libCharacters.length})</option>
                {libCharacters.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </div>

          {/* Backgrounds — generate reusable set plates, then assign per shot below */}
          <div className="pt-1 border-t border-gray-100 space-y-1.5">
            <p className="text-[10px] text-gray-500">Backgrounds ({libBackgrounds.length}) — generate a set plate, then pick it per shot in the shot list</p>
            {libBackgrounds.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {libBackgrounds.map(b => (
                  <div key={b.id} className="relative group">
                    {b.filename && <img src={`/api/media/${b.filename}`} alt={b.name} title={b.name} className="w-16 h-10 object-cover rounded border border-gray-200" />}
                    <button onClick={() => removeLibraryAsset(b.id)} className="absolute -top-1 -right-1 bg-black text-white rounded-full w-3.5 h-3.5 text-[8px] leading-none opacity-0 group-hover:opacity-100">✕</button>
                    <p className="text-[8px] text-gray-400 truncate w-16">{b.name}</p>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-1">
              <input value={bgName} onChange={e => setBgName(e.target.value)} placeholder="name"
                className="w-24 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-black" />
              <input value={bgPrompt} onChange={e => setBgPrompt(e.target.value)} placeholder="Background prompt — e.g. rustic kitchen counter, warm window light, out of focus"
                className="flex-1 bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-black" />
              <button onClick={() => { if (bgName.trim() && bgPrompt.trim()) { generateBackground(bgName, bgPrompt); setBgName(""); setBgPrompt(""); } }}
                disabled={busy === "bg" || !bgName.trim() || !bgPrompt.trim()}
                className="text-[11px] bg-gray-900 text-white rounded px-2 py-1 disabled:opacity-40 flex-shrink-0">
                {busy === "bg" ? "…" : "Generate"}
              </button>
            </div>
          </div>
        </div>

        {/* Asset slots */}
        <div className="grid grid-cols-2 gap-3">
          {/* Product image */}
          <div className="border border-gray-200 rounded-xl p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Product image</p>
            {production.product_image_filename ? (
              <>
                <img src={`/api/media/${production.product_image_filename}`} alt="Product"
                  className="w-full h-24 object-contain rounded-lg border border-gray-200 bg-gray-50" />
                <p className={`text-[10px] ${production.product_image_url ? "text-green-600" : "text-amber-600"}`}>
                  {production.product_image_url ? "✓ Uploaded to kie — usable as the product reference" : "⚠ Uploaded locally but kie upload failed — re-upload to use as a reference"}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-gray-400">Upload a real client's product photo — it's sent to kie so it works as the product reference on product shots.</p>
            )}
            <button onClick={() => productImageRef.current?.click()} disabled={active || busy === "product-image"}
              className="text-[11px] text-blue-500 hover:text-blue-400 disabled:opacity-40">
              {busy === "product-image" ? "Uploading…" : production.product_image_filename ? "Replace" : "Upload product image"}
            </button>
            <input ref={productImageRef} type="file" accept="image/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload("product-image", f); e.target.value = ""; }} />
          </div>
          {/* Music */}
          <div className="border border-gray-200 rounded-xl p-3 space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Music</p>
            {production.music_filename ? (
              <p className="text-[11px] text-gray-600 break-all">{production.music_filename.split("/").pop()}</p>
            ) : (
              <p className="text-[11px] text-gray-400">None — mixed under clips at assembly.</p>
            )}
            <button onClick={() => musicRef.current?.click()} disabled={busy === "music"}
              className="text-[11px] text-blue-500 hover:text-blue-400 disabled:opacity-40">
              {busy === "music" ? "Uploading…" : production.music_filename ? "Replace" : "Upload music"}
            </button>
            <input ref={musicRef} type="file" accept="audio/*" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) upload("music", f); e.target.value = ""; }} />
          </div>
        </div>

        {/* Two-stage progress: keyframes first, then clips */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 w-16 flex-shrink-0">Keyframes</span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-blue-500 transition-all" style={{ width: `${shots.length ? (kfDone / shots.length) * 100 : 0}%` }} />
            </div>
            <span className="text-[10px] text-gray-400 w-10 text-right">{kfDone}/{shots.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-500 w-16 flex-shrink-0">Clips</span>
            <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-green-500 transition-all" style={{ width: `${shots.length ? (done / shots.length) * 100 : 0}%` }} />
            </div>
            <span className="text-[10px] text-gray-400 w-10 text-right">{done}/{shots.length}</span>
          </div>
          <p className="text-[10px] text-gray-400">
            Step 1: generate keyframes → hover a thumbnail to check it, retry any duds → Step 2: generate videos only from the stills you're happy with.
          </p>
        </div>

        {/* Shot table */}
        <div className="space-y-2">
          {shots.map(shot => {
            const st = STATUS_STYLE[shot.status];
            return (
              <div key={shot.id} className="border border-gray-200 rounded-xl p-3">
                <div className="flex items-start gap-3">
                  <span className="text-xs font-bold text-gray-500 w-5 flex-shrink-0 mt-0.5">{shot.shot_number}</span>

                  {/* Thumbnails: keyframe then clip (hover to enlarge) */}
                  <div className="flex gap-2 flex-shrink-0">
                    {shot.keyframe_filename ? (
                      <img src={`/api/media/${shot.keyframe_filename}`} alt="" loading="lazy"
                        onMouseEnter={() => setHover({ url: `/api/media/${shot.keyframe_filename}`, type: "image" })}
                        onMouseLeave={() => setHover(null)}
                        className="w-16 h-10 object-cover rounded border border-gray-200 cursor-zoom-in" />
                    ) : (
                      <div className="w-16 h-10 rounded border border-dashed border-gray-200 flex items-center justify-center text-[9px] text-gray-400">key</div>
                    )}
                    {shot.video_filename ? (
                      <video src={`/api/media/${shot.video_filename}`} muted
                        onMouseEnter={() => setHover({ url: `/api/media/${shot.video_filename}`, type: "video" })}
                        onMouseLeave={() => setHover(null)}
                        className="w-16 h-10 object-cover rounded border border-gray-200 cursor-zoom-in" />
                    ) : (
                      <div className="w-16 h-10 rounded border border-dashed border-gray-200 flex items-center justify-center text-[9px] text-gray-400">clip</div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      {shot.scene_id && (
                        <span className="px-1.5 py-0.5 rounded text-[9px] bg-indigo-50 text-indigo-500 border border-indigo-100 flex-shrink-0"
                          title="Scene group — shots sharing this ID chain for continuity">
                          {shot.scene_id}
                        </span>
                      )}
                      <p className="text-xs text-gray-600 truncate">{shot.description || shot.image_prompt}</p>
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1 flex-wrap">
                      <span>{shot.camera_shot || "—"}</span>
                      <span>·</span>
                      <input key={`dur-${shot.id}`} defaultValue={shot.duration_hint ?? ""} disabled={active}
                        onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                        onBlur={e => { if (e.target.value !== (shot.duration_hint ?? "")) saveDuration(shot.id, e.target.value); }}
                        title="Clip length in the final cut (e.g. 3s) — the video is trimmed to this at assembly"
                        className="w-9 bg-transparent border-b border-dashed border-gray-300 text-[10px] text-gray-500 text-center focus:outline-none focus:border-gray-500 disabled:opacity-50" />
                      {shot.take_count ? <span>· take {shot.take_count}</span> : null}
                      <span>·</span>
                      <button onClick={() => toggleStill(shot.id, !shot.is_still)} disabled={active}
                        title="Freeze: hold the keyframe for its duration instead of animating with Veo (no video credits)"
                        className={`px-1.5 py-0.5 rounded text-[9px] transition-colors disabled:opacity-40 ${shot.is_still ? "bg-blue-100 text-blue-600" : "bg-gray-100 text-gray-400 hover:text-gray-600"}`}>
                        {shot.is_still ? "❄ Still" : "Still?"}
                      </button>
                      {shot.shot_number > 1 && (
                        <select value={shot.ref_shot ?? ""} disabled={active}
                          onChange={e => saveRefShot(shot.id, e.target.value ? Number(e.target.value) : null)}
                          title="Carry an earlier shot's scene/props into this keyframe for continuity"
                          className={`rounded text-[9px] px-0.5 py-0.5 border ${shot.ref_shot ? "bg-purple-50 border-purple-200 text-purple-600" : "bg-transparent border-gray-200 text-gray-400"}`}>
                          <option value="">carry scene…</option>
                          {shots.filter(s => s.shot_number < shot.shot_number).map(s => (
                            <option key={s.id} value={s.shot_number}>↩ from shot {s.shot_number}</option>
                          ))}
                        </select>
                      )}
                    </p>

                    {/* Per-shot references — keep ≤2 to avoid dilution */}
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap text-[9px]">
                      <span className="text-gray-400">refs:</span>
                      <button onClick={() => setShotRefs(shot.id, { useCharacter: !shot.use_character })} disabled={active || !hasCharacter}
                        title={hasCharacter ? "Include the character reference on this shot" : "No character set on the project"}
                        className={`px-1.5 py-0.5 rounded transition-colors disabled:opacity-30 ${shot.use_character && hasCharacter ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                        Character{shot.use_character && hasCharacter ? " ✓" : ""}
                      </button>
                      <button onClick={() => setShotRefs(shot.id, { useHero: !shot.label_visible })} disabled={active || !(production.hero_ref_url || production.product_image_filename)}
                        title="Include the product/hero reference on this shot"
                        className={`px-1.5 py-0.5 rounded transition-colors disabled:opacity-30 ${shot.label_visible && (production.hero_ref_url || production.product_image_filename) ? "bg-green-100 text-green-600" : "bg-gray-100 text-gray-400"}`}>
                        Hero{shot.label_visible && (production.hero_ref_url || production.product_image_filename) ? " ✓" : ""}
                      </button>
                      {libBackgrounds.length > 0 && (
                        <select value={shot.bg_asset_id ?? ""} disabled={active}
                          onChange={e => setShotRefs(shot.id, { bgAssetId: e.target.value ? Number(e.target.value) : null })}
                          title="Reference a background plate on this shot"
                          className={`rounded px-0.5 py-0.5 border ${shot.bg_asset_id ? "bg-green-50 border-green-200 text-green-600" : "bg-transparent border-gray-200 text-gray-400"}`}>
                          <option value="">bg: none</option>
                          {libBackgrounds.map(b => <option key={b.id} value={b.id}>bg: {b.name}</option>)}
                        </select>
                      )}
                      {shot.video_filename && (
                        <button onClick={() => grabBackground(shot)} disabled={active || busy === "grab"}
                          title="Grab a frame from this clip → save as a reusable background (uploads to kie so it's usable as a reference)"
                          className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 hover:text-gray-800 disabled:opacity-40">
                          {busy === "grab" ? "…" : "⤓ grab bg"}
                        </button>
                      )}
                      {(() => { const c = refCount(shot); return (
                        <span className={`ml-auto px-1.5 py-0.5 rounded ${c >= 3 ? "bg-amber-100 text-amber-600" : "bg-gray-100 text-gray-400"}`}>
                          {c} ref{c === 1 ? "" : "s"}{c >= 3 ? " ⚠ dilution" : ""}
                        </span>
                      ); })()}
                    </div>

                    {shot.status === "failed" && shot.error && (
                      <p className="text-[10px] text-red-500 mt-0.5 truncate">{shot.error}</p>
                    )}
                    {shot.audit_notes && (
                      <p className="text-[10px] text-purple-600 mt-0.5 leading-snug">⚠ Audit: {shot.audit_notes}</p>
                    )}
                    <RetryShot productionId={production.id} shot={shot} dryRun={dryRun} quality={quality} imageModel={imageModel} disabled={active} onDone={loadFull} />
                  </div>

                  <span className={`px-2 py-0.5 rounded text-[10px] font-medium flex-shrink-0 ${st.cls}`}>{st.label}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Final video */}
        {production.final_video_filename && (
          <div className="space-y-2 pt-2 border-t border-gray-200">
            <p className="text-[10px] uppercase tracking-widest text-gray-500">Final cut</p>
            <video src={`/api/media/${production.final_video_filename}`} controls className="w-full rounded-xl border border-gray-200" />
            <div className="flex gap-3">
              <a href={`/api/media/${production.final_video_filename}`} download
                className="text-xs text-gray-600 hover:text-gray-900 transition-colors">Download</a>
              <button onClick={reveal} className="text-xs text-gray-600 hover:text-gray-900 transition-colors">Open folder</button>
            </div>
          </div>
        )}
      </div>

      {/* Hover-to-enlarge preview (fixed, escapes the scroll container) */}
      {hover && (
        <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 pointer-events-none">
          {hover.type === "image" ? (
            <img src={hover.url} alt="Preview" className="max-w-[42vw] max-h-[80vh] rounded-xl border-2 border-white shadow-2xl bg-black" />
          ) : (
            <video src={hover.url} autoPlay muted loop className="max-w-[42vw] max-h-[80vh] rounded-xl border-2 border-white shadow-2xl bg-black" />
          )}
        </div>
      )}
    </div>
  );
}
