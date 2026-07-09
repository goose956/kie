import { useEffect, useState } from "react";

interface Angle {
  production: { id: number; title: string };
  angle: { archetype_name?: string; target_belief?: string; concept?: string; hook?: string };
}

interface FalseBeliefs { internal?: string[]; external?: string[]; }
interface LibraryAsset { id: number; kind: "character" | "product"; name: string; }

interface Props {
  projectId: number | null;
  onCreated: () => void;      // refresh productions list
  onGoToProduce: (productionId: number) => void;
}

const TONES = ["", "Humorous", "Emotional", "Energetic", "Cinematic", "Gritty", "Aspirational", "Bold"];
const DURATIONS = ["15s", "20s", "30s", "45s", "60s"];

export default function AdPackPanel({ projectId, onCreated, onGoToProduce }: Props) {
  const [campaign, setCampaign] = useState("");
  const [brief, setBrief] = useState("");
  const [count, setCount] = useState(4);
  const [duration, setDuration] = useState("15s");
  const [tone, setTone] = useState("");
  const [platform, setPlatform] = useState("reels");
  const [contentStyle, setContentStyle] = useState<"polished" | "ugc">("polished");
  const [productMode, setProductMode] = useState(true);
  const [style, setStyle] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [angles, setAngles] = useState<Angle[]>([]);
  const [beliefs, setBeliefs] = useState<FalseBeliefs | null>(null);
  const [productionIds, setProductionIds] = useState<number[]>([]);
  const [cast, setCast] = useState<{ name: string; prompt: string; busy?: boolean; done?: boolean; filename?: string }[]>([]);
  const [sets, setSets] = useState<{ name: string; scene_id?: string; prompt: string; busy?: boolean; done?: boolean; filename?: string }[]>([]);
  const [hover, setHover] = useState<string | null>(null); // media filename shown enlarged on hover
  // Campaign-wide reference apply
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  const [heroAssetId, setHeroAssetId] = useState("");
  const [charAssetId, setCharAssetId] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyMsg, setApplyMsg] = useState("");

  useEffect(() => {
    fetch("/api/library-assets").then(r => r.json()).then(setLibrary).catch(() => {});
  }, [angles.length]);

  async function applyToCampaign() {
    if (angles.length === 0) return;
    setApplying(true); setApplyMsg("");
    try {
      const res = await fetch("/api/ad/apply-to-campaign", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productionIds: angles.map(a => a.production.id),
          projectId,
          heroAssetId: heroAssetId ? Number(heroAssetId) : undefined,
          characterAssetId: charAssetId ? Number(charAssetId) : undefined,
          style: style.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) { setApplyMsg(data.error); return; }
      setApplyMsg(`✓ Applied to all ${data.applied} angles`);
      onCreated();
    } catch (e) { setApplyMsg(String(e)); }
    finally { setApplying(false); }
  }

  async function generate() {
    if (!brief.trim()) return;
    setLoading(true); setError(""); setAngles([]); setBeliefs(null);
    try {
      const res = await fetch("/api/ad/test-pack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brief, campaign, count, projectId, productMode, style, duration, tone, platform, contentStyle }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setAngles(data.angles ?? []);
      setBeliefs(data.false_beliefs ?? null);
      setProductionIds(data.productionIds ?? []);
      setCast((data.cast ?? []).map((c: { name?: string; prompt?: string }) => ({ name: c.name || "Character", prompt: c.prompt || "" })));
      setSets((data.sets ?? []).map((s: { name?: string; scene_id?: string; prompt?: string }) => ({ name: s.name || "Set", scene_id: s.scene_id, prompt: s.prompt || "" })));
      onCreated();
    } catch (e) { setError(String(e)); }
    finally { setLoading(false); }
  }

  async function pollImageTask(url: string): Promise<{ status: string; asset?: { id: number; filename?: string }; filename?: string; error?: string }> {
    for (let a = 0; a < 60; a++) {
      await new Promise(r => setTimeout(r, 3000));
      const d = await (await fetch(url)).json();
      if (d.status === "done") return d;
      if (d.status === "failed" || d.error) return { status: "failed", error: d.error || "Generation failed" };
    }
    return { status: "failed", error: "Timed out" };
  }

  async function genCast(i: number) {
    const c = cast[i];
    if (!c?.prompt.trim() || projectId == null) { setError("Pick a project first"); return; }
    setCast(prev => prev.map((x, j) => j === i ? { ...x, busy: true } : x));
    try {
      const r = await fetch("/api/projects/generate-character", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt: c.prompt }),
      });
      const { taskId, error } = await r.json();
      if (error) throw new Error(error);
      const d = await pollImageTask(`/api/projects/poll-character?taskId=${taskId}&projectId=${projectId}`);
      if (d.error) throw new Error(d.error);
      setCast(prev => prev.map((x, j) => j === i ? { ...x, busy: false, done: true, filename: d.filename } : x));
      onCreated();
    } catch (e) { setError(String(e)); setCast(prev => prev.map((x, j) => j === i ? { ...x, busy: false } : x)); }
  }

  async function genSet(i: number) {
    const s = sets[i];
    if (!s?.prompt.trim()) return;
    setSets(prev => prev.map((x, j) => j === i ? { ...x, busy: true } : x));
    try {
      const r = await fetch("/api/library-assets/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "background", prompt: s.prompt }),
      });
      const { taskId, error } = await r.json();
      if (error) throw new Error(error);
      const d = await pollImageTask(`/api/library-assets/generate-poll?taskId=${taskId}&kind=background&name=${encodeURIComponent(s.name)}`);
      if (d.error || !d.asset) throw new Error(d.error || "No asset");
      await fetch("/api/ad/apply-set", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productionIds, sceneId: s.scene_id, bgAssetId: d.asset.id }),
      });
      setSets(prev => prev.map((x, j) => j === i ? { ...x, busy: false, done: true, filename: d.asset!.filename } : x));
      fetch("/api/library-assets").then(r => r.json()).then(setLibrary).catch(() => {});
    } catch (e) { setError(String(e)); setSets(prev => prev.map((x, j) => j === i ? { ...x, busy: false } : x)); }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 flex-shrink-0">
        <p className="text-xs font-semibold text-gray-900 tracking-wide">AD TEST PACK</p>
        <p className="text-[10px] text-gray-500 mt-0.5">
          Generate {count} distinct ad angles — each a different archetype destroying a different false belief. Each becomes a production ready to produce.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Form */}
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Campaign / brand</label>
              <input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="e.g. VOLT"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Angles to test</label>
              <select value={count} onChange={e => setCount(Number(e.target.value))}
                className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                {[2, 3, 4, 5, 6].map(n => <option key={n} value={n}>{n} angles</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Offer brief *</label>
            <textarea value={brief} onChange={e => setBrief(e.target.value)}
              placeholder="Describe the offer: product, who it's for, the transformation, proof points, and any objections you hear. The more real detail, the better the angles."
              rows={5}
              className="w-full bg-white border border-gray-300 rounded-xl px-3 py-2.5 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Platform (sets aspect ratio + pacing)</label>
              <select value={platform} onChange={e => setPlatform(e.target.value)}
                className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                <option value="tiktok">TikTok — 9:16 vertical, fast hook</option>
                <option value="reels">Instagram / FB Reels — 9:16 vertical</option>
                <option value="facebook">Facebook feed — 9:16 vertical</option>
                <option value="youtube">YouTube in-stream — 16:9, hook in 5s</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Style</label>
              <div className="flex rounded-lg border border-gray-300 overflow-hidden">
                {(["polished", "ugc"] as const).map(s => (
                  <button key={s} type="button" onClick={() => setContentStyle(s)}
                    className={`flex-1 py-1.5 text-xs font-medium transition-colors ${contentStyle === s ? "bg-gray-900 text-white" : "bg-white text-gray-500 hover:text-gray-900"}`}>
                    {s === "polished" ? "Polished" : "UGC"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <p className="text-[10px] text-gray-400 -mt-2">
            {contentStyle === "ugc"
              ? "UGC: handheld, direct-to-camera, casual phone-shot look — no cinematic camera moves."
              : "Polished: produced ad craft — deliberate shot sizes and camera moves."}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Length per angle</label>
              <select value={duration} onChange={e => setDuration(e.target.value)}
                className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                {DURATIONS.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Tone</label>
              <select value={tone} onChange={e => setTone(e.target.value)}
                className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                {TONES.map(t => <option key={t} value={t}>{t || "Any"}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-[10px] uppercase tracking-widest text-gray-500 block mb-1">Global style (optional)</label>
            <input value={style} onChange={e => setStyle(e.target.value)} placeholder="e.g. photoreal cinematic / claymation stop-motion — applied to every shot"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={productMode} onChange={e => setProductMode(e.target.checked)} />
            Product ad — hero the product, end each angle on a clean product/CTA shot
          </label>

          {error && <p className="text-red-500 text-xs">{error}</p>}
          <button onClick={generate} disabled={!brief.trim() || loading}
            className="w-full bg-gray-900 text-white text-xs font-semibold rounded-xl py-2.5 hover:bg-gray-700 disabled:opacity-40 transition-all">
            {loading ? "Generating angles… (this takes a moment)" : `Generate ${count}-angle test pack`}
          </button>
        </div>

        {/* Results */}
        {angles.length > 0 && (
          <div className="space-y-3 pt-2 border-t border-gray-200">
            <p className="text-xs text-green-600">✓ Created {angles.length} productions — open them in the Produce tab to run keyframes, then video.</p>

            {/* Cast & Sets — derived from the scripts, generated AFTER the script (not before) */}
            {(cast.length > 0 || sets.length > 0) && (
              <div className="border border-gray-200 rounded-xl p-3 space-y-3 bg-indigo-50/40">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-gray-500">Cast &amp; Sets — from your scripts</p>
                  <p className="text-[10px] text-gray-400">The AI read the scripts and drafted the people + places they need. Generate them and they lock across every angle.</p>
                </div>

                {error && <p className="text-red-500 text-[11px] bg-red-50 border border-red-100 rounded-lg px-2 py-1.5">{error}</p>}

                {cast.map((c, i) => (
                  <div key={`cast-${i}`} className="flex gap-2">
                    {c.done && c.filename ? (
                      <img src={`/api/media/${c.filename}`} alt={c.name}
                        onMouseEnter={() => setHover(c.filename!)} onMouseLeave={() => setHover(null)}
                        className="w-16 h-16 rounded-lg object-cover border border-gray-200 flex-shrink-0 cursor-zoom-in" />
                    ) : (
                      <div className="w-16 h-16 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-lg flex-shrink-0">🎭</div>
                    )}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-gray-700">{c.name}{c.done ? " ✓" : ""}</span>
                        <button onClick={() => genCast(i)} disabled={c.busy || c.done}
                          className="text-[11px] bg-gray-900 text-white rounded-lg px-2.5 py-1 hover:bg-gray-700 disabled:opacity-40 transition-colors">
                          {c.busy ? "Generating…" : c.done ? "Done" : "Generate character"}
                        </button>
                      </div>
                      <textarea value={c.prompt} onChange={e => setCast(prev => prev.map((x, j) => j === i ? { ...x, prompt: e.target.value } : x))}
                        rows={2} disabled={c.busy || c.done}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-black resize-none focus:outline-none focus:border-gray-500 disabled:opacity-60" />
                    </div>
                  </div>
                ))}

                {sets.map((s, i) => (
                  <div key={`set-${i}`} className="flex gap-2">
                    {s.done && s.filename ? (
                      <img src={`/api/media/${s.filename}`} alt={s.name}
                        onMouseEnter={() => setHover(s.filename!)} onMouseLeave={() => setHover(null)}
                        className="w-16 h-16 rounded-lg object-cover border border-gray-200 flex-shrink-0 cursor-zoom-in" />
                    ) : (
                      <div className="w-16 h-16 rounded-lg border border-dashed border-gray-200 flex items-center justify-center text-lg flex-shrink-0">🏞</div>
                    )}
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-gray-700">{s.name}{s.scene_id ? ` (${s.scene_id})` : ""}{s.done ? " ✓" : ""}</span>
                        <button onClick={() => genSet(i)} disabled={s.busy || s.done}
                          className="text-[11px] bg-gray-900 text-white rounded-lg px-2.5 py-1 hover:bg-gray-700 disabled:opacity-40 transition-colors">
                          {s.busy ? "Generating…" : s.done ? "Done" : "Generate set"}
                        </button>
                      </div>
                      <textarea value={s.prompt} onChange={e => setSets(prev => prev.map((x, j) => j === i ? { ...x, prompt: e.target.value } : x))}
                        rows={2} disabled={s.busy || s.done}
                        className="w-full bg-white border border-gray-300 rounded px-2 py-1 text-[11px] text-black resize-none focus:outline-none focus:border-gray-500 disabled:opacity-60" />
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-gray-400">Character sets on the project (shared by all angles); each set is assigned to its matching scene across all angles.</p>
              </div>
            )}

            {/* Campaign assets — apply shared references to every angle at once */}
            <div className="border border-gray-200 rounded-xl p-3 space-y-2 bg-gray-50">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Make it a coherent campaign</p>
              <p className="text-[10px] text-gray-400">Apply one product + character + style across all {angles.length} angles so the whole test looks like one brand.</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-gray-500 block mb-0.5">Product (hero)</label>
                  <select value={heroAssetId} onChange={e => setHeroAssetId(e.target.value)}
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1 text-[11px] text-black">
                    <option value="">— from library —</option>
                    {library.filter(a => a.kind === "product").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-gray-500 block mb-0.5">Character</label>
                  <select value={charAssetId} onChange={e => setCharAssetId(e.target.value)}
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1 text-[11px] text-black">
                    <option value="">— from library —</option>
                    {library.filter(a => a.kind === "character").map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              </div>
              {library.length === 0 && (
                <p className="text-[10px] text-amber-600">No saved assets yet — generate a hero/character in any angle's Produce panel and “★ Save to library”, then come back here to apply it to all angles. Style (from the form) is already applied to every angle.</p>
              )}
              <div className="flex items-center gap-2">
                <button onClick={applyToCampaign} disabled={applying || (!heroAssetId && !charAssetId && !style.trim())}
                  className="bg-gray-900 text-white text-[11px] font-semibold rounded-lg px-3 py-1.5 hover:bg-gray-700 disabled:opacity-40 transition-colors">
                  {applying ? "Applying…" : `Apply to all ${angles.length} angles`}
                </button>
                {applyMsg && <span className="text-[10px] text-gray-600">{applyMsg}</span>}
              </div>
            </div>

            {angles.map((a, i) => (
              <div key={a.production.id} className="border border-gray-200 rounded-xl p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-medium text-gray-900">
                    <span className="text-amber-600">Angle {i + 1}</span> · {a.angle.archetype_name}
                  </p>
                  <button onClick={() => onGoToProduce(a.production.id)}
                    className="text-[10px] px-2 py-1 bg-gray-100 text-gray-600 rounded-lg hover:bg-gray-200 transition-colors flex-shrink-0">
                    Open in Produce →
                  </button>
                </div>
                {a.angle.target_belief && <p className="text-[11px] text-gray-500">Destroys: <span className="text-gray-700 italic">"{a.angle.target_belief}"</span></p>}
                {a.angle.concept && <p className="text-[11px] text-gray-600">{a.angle.concept}</p>}
                {a.angle.hook && <p className="text-[11px] text-gray-500 bg-gray-50 rounded-lg p-2 border border-gray-100">Hook: {a.angle.hook}</p>}
              </div>
            ))}
          </div>
        )}

        {/* False beliefs */}
        {beliefs && (beliefs.internal?.length || beliefs.external?.length) ? (
          <details className="border border-gray-200 rounded-xl p-3">
            <summary className="text-[10px] uppercase tracking-widest text-gray-500 cursor-pointer">False beliefs mapped</summary>
            <div className="grid grid-cols-2 gap-3 mt-2 text-[11px] text-gray-600">
              <div>
                <p className="font-medium text-gray-700 mb-1">Internal</p>
                <ul className="space-y-0.5 list-disc list-inside">{(beliefs.internal ?? []).map((b, i) => <li key={i}>{b}</li>)}</ul>
              </div>
              <div>
                <p className="font-medium text-gray-700 mb-1">External</p>
                <ul className="space-y-0.5 list-disc list-inside">{(beliefs.external ?? []).map((b, i) => <li key={i}>{b}</li>)}</ul>
              </div>
            </div>
          </details>
        ) : null}
      </div>

      {/* Hover-to-enlarge preview (fixed, escapes the scroll container) */}
      {hover && (
        <div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 pointer-events-none">
          <img src={`/api/media/${hover}`} alt="Preview" className="max-w-[42vw] max-h-[80vh] rounded-xl border-2 border-white shadow-2xl bg-black" />
        </div>
      )}
    </div>
  );
}
