import { useState } from "react";

interface ProjectSettings {
  name: string;
  visualStyle: string;
  screenDirection: string;
  colourMood: string;
}

interface LastShot {
  prompt: string;
  cameraShot: string;
  lighting: string;
}

interface Props {
  lastShot: LastShot | null;
  attachedImageUrl: string | null;
  onPromptGenerated: (prompt: string) => void;
}

const SCREEN_DIRECTIONS = ["Left to right", "Right to left", "Towards camera", "Away from camera", "Not established"];
const COLOUR_MOODS = ["Warm dawn palette", "Cool blue hour", "Golden hour", "High contrast monochrome", "Desaturated muted", "Neon vivid", "Natural neutral", "Cinematic teal-orange"];

function loadSettings(): ProjectSettings {
  try {
    const stored = localStorage.getItem("kie-studio-project");
    if (stored) return JSON.parse(stored);
  } catch {}
  return { name: "", visualStyle: "", screenDirection: "Left to right", colourMood: "Warm dawn palette" };
}

function saveSettings(s: ProjectSettings) {
  localStorage.setItem("kie-studio-project", JSON.stringify(s));
}

export default function DirectorPanel({ lastShot, attachedImageUrl, onPromptGenerated }: Props) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ProjectSettings>(loadSettings);
  const [intent, setIntent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function updateSettings(patch: Partial<ProjectSettings>) {
    const next = { ...settings, ...patch };
    setSettings(next);
    saveSettings(next);
  }

  async function analyse() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectSettings: settings,
          lastShot,
          nextImageUrl: attachedImageUrl,
          userIntent: intent,
        }),
      });
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      onPromptGenerated(data.prompt);
      setOpen(false);
      setIntent("");
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
          open
            ? "bg-amber-500/20 border-amber-500/50 text-amber-400"
            : "border-gray-200 text-gray-500 hover:text-amber-400 hover:border-amber-500/30"
        }`}
        title="AI Director — maintains shot continuity"
      >
        Director
      </button>

      {/* Panel */}
      {open && (
        <div className="absolute bottom-full mb-2 left-0 w-96 bg-[#161616] border border-gray-200 rounded-2xl shadow-2xl z-50 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <div>
              <p className="text-xs font-semibold text-amber-400 tracking-wide">AI DIRECTOR</p>
              <p className="text-xs text-gray-500 mt-0.5">Maintains 180°, screen direction & continuity</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setSettingsOpen((s) => !s)}
                className="text-xs text-gray-500 hover:text-gray-500 transition-colors"
                title="Project settings"
              >
                {settingsOpen ? "Done" : "Project ↗"}
              </button>
              <button onClick={() => setOpen(false)} className="text-gray-500 hover:text-gray-500 text-xs">✕</button>
            </div>
          </div>

          {/* Project settings (collapsible) */}
          {settingsOpen && (
            <div className="px-4 py-3 border-b border-gray-200 space-y-2 bg-gray-50">
              <input
                value={settings.name}
                onChange={(e) => updateSettings({ name: e.target.value })}
                placeholder="Project name (e.g. KOVA shoe ad)"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-gray-500"
              />
              <input
                value={settings.visualStyle}
                onChange={(e) => updateSettings({ visualStyle: e.target.value })}
                placeholder="Visual style (e.g. Documentary, film grain)"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-gray-500"
              />
              <div className="flex gap-2">
                <select
                  value={settings.screenDirection}
                  onChange={(e) => updateSettings({ screenDirection: e.target.value })}
                  className="flex-1 bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black"
                >
                  {SCREEN_DIRECTIONS.map((d) => <option key={d}>{d}</option>)}
                </select>
                <select
                  value={settings.colourMood}
                  onChange={(e) => updateSettings({ colourMood: e.target.value })}
                  className="flex-1 bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black"
                >
                  {COLOUR_MOODS.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Context summary */}
          <div className="px-4 py-3 space-y-2">
            <div className="flex gap-3 text-xs">
              <div className="flex-1 rounded-lg bg-gray-50 border border-gray-200 p-2 space-y-0.5">
                <p className="text-gray-500 uppercase tracking-wide text-[10px]">Last shot</p>
                {lastShot ? (
                  <>
                    <p className="text-gray-500 line-clamp-2">{lastShot.prompt || "—"}</p>
                    {lastShot.cameraShot && <p className="text-gray-500">{lastShot.cameraShot}</p>}
                    {lastShot.lighting && <p className="text-gray-500">{lastShot.lighting}</p>}
                  </>
                ) : (
                  <p className="text-gray-500">Opening shot</p>
                )}
              </div>
              <div className="flex-1 rounded-lg bg-gray-50 border border-gray-200 p-2 space-y-0.5">
                <p className="text-gray-500 uppercase tracking-wide text-[10px]">Next shot ref</p>
                {attachedImageUrl ? (
                  <img src={attachedImageUrl} alt="" className="w-full rounded mt-1 border border-gray-200" />
                ) : (
                  <p className="text-gray-500">Attach an image first</p>
                )}
              </div>
            </div>

            {/* Intent */}
            <input
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              placeholder="Director's intent (optional) — e.g. reveal the shoe sole"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none focus:border-amber-400"
            />

            {error && <p className="text-red-400 text-xs">{error}</p>}

            <button
              onClick={analyse}
              disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-black text-xs font-semibold rounded-lg py-2 transition-colors"
            >
              {loading ? "Analysing continuity…" : "Generate shot prompt"}
            </button>

            <p className="text-[10px] text-gray-500 text-center">
              Prompt will be pre-filled in the box below — review before generating
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
