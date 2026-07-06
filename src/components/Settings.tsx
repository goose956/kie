import { useEffect, useState } from "react";

interface Character { id: number; name: string; description: string; }
interface Location { id: number; name: string; description: string; palette?: string; time_of_day?: string; key_props?: string; }

export default function Settings() {
  const [kieKey, setKieKey] = useState("");
  const [anthropicKey, setAnthropicKey] = useState("");
  const [promptEngineer, setPromptEngineer] = useState(true);
  const [keySaved, setKeySaved] = useState(false);
  const [keyError, setKeyError] = useState("");

  const [characters, setCharacters] = useState<Character[]>([]);
  const [charName, setCharName] = useState("");
  const [charDesc, setCharDesc] = useState("");
  const [charError, setCharError] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDesc, setEditDesc] = useState("");

  const [locations, setLocations] = useState<Location[]>([]);
  const [locName, setLocName] = useState("");
  const [locDesc, setLocDesc] = useState("");
  const [locPalette, setLocPalette] = useState("");
  const [locTimeOfDay, setLocTimeOfDay] = useState("");
  const [locKeyProps, setLocKeyProps] = useState("");
  const [locError, setLocError] = useState("");

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(d => {
      if (d.KIE_API_KEY && d.KIE_API_KEY !== "set") setKieKey(d.KIE_API_KEY);
      if (d.ANTHROPIC_API_KEY && d.ANTHROPIC_API_KEY !== "set") setAnthropicKey(d.ANTHROPIC_API_KEY);
      setPromptEngineer(d.promptEngineer !== false);
    });
    fetch("/api/characters").then(r => r.json()).then(setCharacters);
    fetch("/api/locations").then(r => r.json()).then(setLocations);
  }, []);

  async function saveKeys() {
    setKeyError(""); setKeySaved(false);
    const body: Record<string, unknown> = { promptEngineer };
    if (kieKey) body.KIE_API_KEY = kieKey;
    if (anthropicKey) body.ANTHROPIC_API_KEY = anthropicKey;
    try {
      const postRes = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!postRes.ok) {
        const text = await postRes.text();
        setKeyError(`Save failed (${postRes.status}): ${text.replace(/<[^>]+>/g, "").trim().slice(0, 200)}`);
        return;
      }
      const updated = await fetch("/api/settings").then(r => r.json());
      if (updated.KIE_API_KEY && updated.KIE_API_KEY !== "set") setKieKey(updated.KIE_API_KEY);
      if (updated.ANTHROPIC_API_KEY && updated.ANTHROPIC_API_KEY !== "set") setAnthropicKey(updated.ANTHROPIC_API_KEY);
      setKeySaved(true); setTimeout(() => setKeySaved(false), 3000);
    } catch (e) { setKeyError(String(e)); }
  }

  async function toggleEngineer(val: boolean) {
    setPromptEngineer(val);
    await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ promptEngineer: val }) });
  }

  async function addCharacter() {
    setCharError("");
    if (!charName.trim() || !charDesc.trim()) { setCharError("Both name and description are required."); return; }
    const res = await fetch("/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: charName.trim(), description: charDesc.trim() }) });
    const char = await res.json();
    if (char.error) { setCharError(char.error); return; }
    setCharacters(prev => [...prev, char]);
    setCharName(""); setCharDesc("");
  }

  async function deleteCharacter(id: number) {
    await fetch("/api/characters", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setCharacters(prev => prev.filter(c => c.id !== id));
  }

  async function saveEdit(id: number) {
    const char = characters.find(c => c.id === id);
    if (!char) return;
    await fetch("/api/characters", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    const res = await fetch("/api/characters", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: char.name, description: editDesc }) });
    const updated = await res.json();
    setCharacters(prev => prev.map(c => c.id === id ? { ...updated } : c));
    setEditingId(null); setEditDesc("");
  }

  async function addLocation() {
    setLocError("");
    if (!locName.trim() || !locDesc.trim()) { setLocError("Name and description are required."); return; }
    const res = await fetch("/api/locations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: locName.trim(), description: locDesc.trim(), palette: locPalette.trim(), time_of_day: locTimeOfDay.trim(), key_props: locKeyProps.trim() }) });
    const loc = await res.json();
    if (loc.error) { setLocError(loc.error); return; }
    setLocations(prev => [...prev, loc]);
    setLocName(""); setLocDesc(""); setLocPalette(""); setLocTimeOfDay(""); setLocKeyProps("");
  }

  async function deleteLocation(id: number) {
    await fetch("/api/locations", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setLocations(prev => prev.filter(l => l.id !== id));
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-8">
      <div className="max-w-lg w-full mx-auto space-y-8">

        {/* ── API Keys ── */}
        <section className="space-y-4">
          <div>
            <p className="text-gray-900 font-semibold text-sm tracking-wide">API Keys</p>
            <p className="text-xs text-gray-500 mt-1">Saved to <code className="text-gray-500">settings.json</code> — changes apply immediately.</p>
          </div>

          {[
            { label: "Kie.ai API Key", hint: "Image (Nano Banana) and video (Veo 3) generation", value: kieKey, set: setKieKey },
            { label: "Anthropic API Key", hint: "AI Director, Script Writer, and Prompt Engineer", value: anthropicKey, set: setAnthropicKey },
          ].map(({ label, hint, value, set }) => (
            <div key={label}>
              <label className="text-xs font-medium text-gray-500 block mb-1">{label}</label>
              <input type="text" value={value} onChange={e => set(e.target.value)}
                placeholder="Paste key here…"
                className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500 font-mono" />
              <p className="text-[10px] text-gray-500 mt-1">{hint}</p>
            </div>
          ))}

          {keyError && <p className="text-red-400 text-xs">{keyError}</p>}
          <button onClick={saveKeys} disabled={!kieKey && !anthropicKey}
            className="w-full bg-gray-900 text-white text-sm font-semibold rounded-xl py-2.5 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
            {keySaved ? "Saved ✓" : "Save keys"}
          </button>
        </section>

        <div className="border-t border-gray-200" />

        {/* ── Prompt Engineer ── */}
        <section className="space-y-3">
          <div>
            <p className="text-gray-900 font-semibold text-sm tracking-wide">Prompt Engineer</p>
            <p className="text-xs text-gray-500 mt-1">Before every generation, Claude rewrites your prompt for cinematic quality — better lighting, subject clarity, motion language for Veo 3. Uses <code className="text-gray-500">claude-haiku</code> for speed.</p>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-gray-200 px-4 py-3">
            <div>
              <p className="text-sm text-gray-800">Auto-engineer prompts</p>
              <p className="text-xs text-gray-500 mt-0.5">{promptEngineer ? "On — all prompts rewritten before generation" : "Off — prompts sent as-is"}</p>
            </div>
            <button onClick={() => toggleEngineer(!promptEngineer)}
              className={`w-12 h-6 rounded-full transition-colors relative flex-shrink-0 ${promptEngineer ? "bg-gray-900" : "bg-gray-200"}`}>
              <span className={`absolute top-1 w-4 h-4 rounded-full transition-all ${promptEngineer ? "left-7 bg-black" : "left-1 bg-gray-500"}`} />
            </button>
          </div>
        </section>

        <div className="border-t border-gray-200" />

        {/* ── Character Bible ── */}
        <section className="space-y-3">
          <div>
            <p className="text-gray-900 font-semibold text-sm tracking-wide">Character Bible</p>
            <p className="text-xs text-gray-500 mt-1">Describe recurring subjects — people, products, locations. These descriptions are automatically injected into every prompt to keep subjects consistent across shots.</p>
          </div>

          {/* Existing characters */}
          {characters.length > 0 && (
            <div className="space-y-2">
              {characters.map(char => (
                <div key={char.id} className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50">
                    <span className="text-sm font-medium text-gray-900">{char.name}</span>
                    <div className="flex gap-3">
                      <button onClick={() => { setEditingId(char.id); setEditDesc(char.description); }}
                        className="text-xs text-gray-500 hover:text-gray-500 transition-colors">Edit</button>
                      <button onClick={() => deleteCharacter(char.id)}
                        className="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                    </div>
                  </div>
                  {editingId === char.id ? (
                    <div className="px-4 pb-3 pt-2 space-y-2 border-t border-gray-200">
                      <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} rows={3}
                        className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
                      <div className="flex gap-2">
                        <button onClick={() => saveEdit(char.id)} className="px-3 py-1.5 bg-gray-900 text-white text-xs font-semibold rounded-lg hover:bg-gray-700">Save</button>
                        <button onClick={() => setEditingId(null)} className="px-3 py-1.5 border border-gray-200 text-gray-500 text-xs rounded-lg hover:text-gray-500">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <div className="px-4 pb-3 pt-1 border-t border-gray-200">
                      <p className="text-xs text-gray-500 leading-relaxed">{char.description}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Add new character */}
          <div className="border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-xs font-medium text-gray-500">Add subject</p>
            <input value={charName} onChange={e => setCharName(e.target.value)}
              placeholder="Name — e.g. Runner, Product, Location"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
            <textarea value={charDesc} onChange={e => setCharDesc(e.target.value)} rows={3}
              placeholder="Description — be specific. e.g. 'Athletic white male, early 30s, dark stubble, wearing red KOVA trainers and a grey technical jacket'"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
            {charError && <p className="text-red-400 text-xs">{charError}</p>}
            <button onClick={addCharacter} disabled={!charName.trim() || !charDesc.trim()}
              className="w-full bg-gray-900 text-white text-xs font-semibold rounded-lg py-2 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              Add to bible
            </button>
          </div>

          {characters.length === 0 && (
            <p className="text-xs text-gray-500 text-center">No subjects yet — add one above</p>
          )}
        </section>

        <div className="border-t border-gray-200" />

        {/* ── Location Bible ── */}
        <section className="space-y-3">
          <div>
            <p className="text-gray-900 font-semibold text-sm tracking-wide">Location Bible</p>
            <p className="text-xs text-gray-500 mt-1">Describe recurring sets and environments. The name must match the <code className="text-gray-500">scene_id</code> in your script breakdown — Claude will inject this description into every prompt for shots in that location.</p>
          </div>

          {locations.length > 0 && (
            <div className="space-y-2">
              {locations.map(loc => (
                <div key={loc.id} className="border border-gray-200 rounded-xl overflow-hidden">
                  <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50">
                    <span className="text-sm font-medium text-gray-900">{loc.name}</span>
                    <button onClick={() => deleteLocation(loc.id)} className="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                  </div>
                  <div className="px-4 pb-3 pt-1 border-t border-gray-200 space-y-0.5">
                    <p className="text-xs text-gray-500 leading-relaxed">{loc.description}</p>
                    {loc.palette && <p className="text-[10px] text-gray-400">Palette: {loc.palette}</p>}
                    {loc.time_of_day && <p className="text-[10px] text-gray-400">Time: {loc.time_of_day}</p>}
                    {loc.key_props && <p className="text-[10px] text-gray-400">Props: {loc.key_props}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="border border-gray-200 rounded-xl p-4 space-y-3">
            <p className="text-xs font-medium text-gray-500">Add location</p>
            <input value={locName} onChange={e => setLocName(e.target.value)}
              placeholder="Name — must match the scene_id (e.g. kitchen, city-street)"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
            <textarea value={locDesc} onChange={e => setLocDesc(e.target.value)} rows={2}
              placeholder="Description — set dressing, architecture, mood. e.g. 'Bright modern kitchen, marble island, pendant lights, morning light through a large east window'"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 resize-none focus:outline-none focus:border-gray-500" />
            <input value={locPalette} onChange={e => setLocPalette(e.target.value)}
              placeholder="Colour palette (optional) — e.g. warm whites, sage green, natural wood"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
            <input value={locTimeOfDay} onChange={e => setLocTimeOfDay(e.target.value)}
              placeholder="Time of day (optional) — e.g. golden hour, overcast midday, night"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
            <input value={locKeyProps} onChange={e => setLocKeyProps(e.target.value)}
              placeholder="Key props (optional) — e.g. espresso machine, potted herbs, open cookbook"
              className="w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-black placeholder-gray-400 focus:outline-none focus:border-gray-500" />
            {locError && <p className="text-red-400 text-xs">{locError}</p>}
            <button onClick={addLocation} disabled={!locName.trim() || !locDesc.trim()}
              className="w-full bg-gray-900 text-white text-xs font-semibold rounded-lg py-2 hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all">
              Add to bible
            </button>
          </div>

          {locations.length === 0 && (
            <p className="text-xs text-gray-500 text-center">No locations yet — add one above</p>
          )}
        </section>
      </div>
    </div>
  );
}
