import { useEffect, useState } from "react";

interface Template {
  id: number;
  title: string;
  style: string | null;
  platform: string | null;
  aspect_ratio: string;
  content_style: string | null;
  created_at: string;
}

interface TemplateShot {
  id: number;
  shot_number: number;
  description: string | null;
  camera_shot: string | null;
  duration_hint: string | null;
}

interface ProjectLite { id: number; name: string; }

export default function TemplatesPanel({ projects, onProjectsChange, onGoToProduce }: {
  projects: ProjectLite[];
  onProjectsChange: () => void;
  onGoToProduce: (productionId: number, projectId: number) => void;
}) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [shots, setShots] = useState<TemplateShot[]>([]);
  const [shotsLoading, setShotsLoading] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const [applyProjectId, setApplyProjectId] = useState<number | "">("");
  const [applyBrief, setApplyBrief] = useState("");
  const [applyTitle, setApplyTitle] = useState("");
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");

  // Creating a project inline — keeps the flow "project first" even mid-apply, instead of
  // letting a template get applied with no home to live in.
  const [creatingProject, setCreatingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectError, setProjectError] = useState("");

  async function createProjectInline() {
    const name = newProjectName.trim();
    if (!name) return;
    setProjectError("");
    if (projects.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      setProjectError("A project called that already exists");
      return;
    }
    try {
      const res = await fetch("/api/projects", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const project = await res.json();
      if (project.error) throw new Error(project.error);
      onProjectsChange();
      setApplyProjectId(project.id);
      setCreatingProject(false); setNewProjectName("");
    } catch (e) { setProjectError(String(e)); }
  }

  const loadTemplates = () =>
    fetch("/api/templates").then(r => r.json()).then(setTemplates).finally(() => setLoading(false));

  useEffect(() => { loadTemplates(); }, []);

  async function toggleExpand(t: Template) {
    if (expandedId === t.id) { setExpandedId(null); return; }
    setExpandedId(t.id);
    setApplyBrief(""); setApplyTitle(""); setApplyProjectId(""); setError("");
    setShotsLoading(true);
    try {
      const res = await fetch(`/api/templates/${t.id}`);
      const data = await res.json();
      setShots(data.shots ?? []);
    } catch (e) { setError(String(e)); }
    finally { setShotsLoading(false); }
  }

  async function deleteTemplate(id: number) {
    try {
      await fetch(`/api/templates/${id}`, { method: "DELETE" });
      setDeleteConfirmId(null);
      if (expandedId === id) setExpandedId(null);
      await loadTemplates();
    } catch (e) { setError(String(e)); }
  }

  async function applyTemplate(templateId: number) {
    if (!applyBrief.trim() || applyProjectId === "") return;
    setApplying(true); setError("");
    try {
      const res = await fetch(`/api/templates/${templateId}/apply`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: applyProjectId,
          productBrief: applyBrief.trim(),
          title: applyTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      onGoToProduce(data.production.id, applyProjectId);
    } catch (e) { setError(String(e)); }
    finally { setApplying(false); }
  }

  if (loading) return <div className="flex-1 p-6 text-sm text-gray-400">Loading…</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Templates</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          Reusable shot structures — camera direction, pacing, shot count. Save one from a production that worked well (Produce → "💾 Save as template"), then apply it to a new product: the structure stays the same, only the product-specific details get rewritten for it.
        </p>
      </div>

      {error && <p className="text-xs text-red-500 border border-red-200 bg-red-50 rounded-lg px-3 py-2">{error}</p>}

      {templates.length === 0 && (
        <p className="text-sm text-gray-500 text-center mt-12">
          No templates yet. Open a production in Produce and use "💾 Save as template" to create one.
        </p>
      )}

      <div className="space-y-2">
        {templates.map(t => (
          <div key={t.id} className="border border-gray-200 rounded-xl overflow-hidden">
            <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-gray-50 transition-colors">
              <button onClick={() => toggleExpand(t)} className="flex-1 min-w-0 text-left">
                <p className="text-sm text-gray-800 truncate">{t.title}</p>
                <p className="text-[10px] text-gray-500">
                  {t.platform || "any platform"} · {t.aspect_ratio} · {t.content_style || "polished"}{t.style ? ` · ${t.style}` : ""}
                </p>
              </button>
              {deleteConfirmId === t.id ? (
                <span className="flex items-center gap-1 flex-shrink-0">
                  <button onClick={() => deleteTemplate(t.id)} className="text-[10px] text-white bg-red-500 hover:bg-red-400 rounded px-1.5 py-0.5">Delete?</button>
                  <button onClick={() => setDeleteConfirmId(null)} className="text-[10px] text-gray-400 hover:text-gray-600">cancel</button>
                </span>
              ) : (
                <button onClick={() => setDeleteConfirmId(t.id)} title="Delete template" className="text-[10px] text-gray-300 hover:text-red-500 flex-shrink-0">✕</button>
              )}
            </div>

            {expandedId === t.id && (
              <div className="border-t border-gray-100 p-3 space-y-3 bg-gray-50">
                {shotsLoading ? (
                  <p className="text-xs text-gray-400">Loading shots…</p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-widest text-gray-500">{shots.length} shot{shots.length === 1 ? "" : "s"}</p>
                    {shots.map(s => (
                      <p key={s.id} className="text-[11px] text-gray-600 truncate">
                        <span className="text-gray-400">{s.shot_number}.</span> {s.description || "(no description)"}
                        {s.camera_shot ? <span className="text-gray-400"> — {s.camera_shot}</span> : null}
                        {s.duration_hint ? <span className="text-gray-400"> · {s.duration_hint}</span> : null}
                      </p>
                    ))}
                  </div>
                )}

                <div className="border-t border-gray-200 pt-3 space-y-2">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500">Apply to a new product</p>

                  {/* Project comes first — every production lives inside a project, so an apply
                      can't proceed without one. Zero projects → the create form opens automatically. */}
                  {creatingProject || projects.length === 0 ? (
                    <div className="border border-gray-200 rounded-lg p-2 space-y-1.5 bg-white">
                      <p className="text-[10px] text-gray-500">
                        {projects.length === 0 ? "You'll need a project before applying a template — create one:" : "New project name:"}
                      </p>
                      <div className="flex gap-2">
                        <input value={newProjectName} onChange={e => { setNewProjectName(e.target.value); setProjectError(""); }}
                          onKeyDown={e => { if (e.key === "Enter") createProjectInline(); }}
                          placeholder="Project name…" autoFocus
                          className="flex-1 bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none" />
                        <button onClick={createProjectInline} disabled={!newProjectName.trim()}
                          className="px-3 bg-gray-900 text-white text-xs font-semibold rounded-lg hover:bg-gray-700 disabled:opacity-40">Create</button>
                        {projects.length > 0 && (
                          <button onClick={() => { setCreatingProject(false); setProjectError(""); }} className="text-xs text-gray-500 hover:text-gray-800">Cancel</button>
                        )}
                      </div>
                      {projectError && <p className="text-[10px] text-red-500">{projectError}</p>}
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <select value={applyProjectId} onChange={e => setApplyProjectId(e.target.value ? Number(e.target.value) : "")}
                        className="flex-1 bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black">
                        <option value="">Pick a project…</option>
                        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <button onClick={() => setCreatingProject(true)}
                        className="text-xs text-blue-500 hover:text-blue-400 whitespace-nowrap">+ New project</button>
                    </div>
                  )}

                  <input value={applyTitle} onChange={e => setApplyTitle(e.target.value)}
                    placeholder="Production title (optional — defaults to the template name)"
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black placeholder-gray-400 focus:outline-none" />
                  <textarea value={applyBrief} onChange={e => setApplyBrief(e.target.value)} rows={3}
                    placeholder="Describe the new product — e.g. a matte-black insulated water bottle, 750ml, keeps drinks cold 24h, brand name AURA in a bold white wordmark…"
                    className="w-full bg-white border border-gray-300 rounded-lg px-2 py-1.5 text-xs text-black placeholder-gray-400 resize-none focus:outline-none" />
                  <button onClick={() => applyTemplate(t.id)} disabled={applying || !applyBrief.trim() || applyProjectId === ""}
                    className="bg-gray-900 text-white text-xs font-semibold rounded-lg px-3 py-1.5 hover:bg-gray-700 disabled:opacity-40 transition-colors">
                    {applying ? "Adapting shots…" : "Apply template →"}
                  </button>
                  <p className="text-[10px] text-gray-400">Rewrites each shot's product-specific text for the new product with AI, keeping every camera direction and pacing beat unchanged — then drops you into Produce with the new production ready to go (add a hero/character reference next).</p>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
