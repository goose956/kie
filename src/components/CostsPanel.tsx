import { useEffect, useMemo, useState } from "react";

// kie's credit-to-USD peg, confirmed against real pricing sheets pasted from the dashboard
// (80cr=$0.40, 60cr=$0.30, 400cr=$2.00 — all divide out to $0.005/credit).
const USD_PER_CREDIT = 0.005;
const PAGE_SIZE = 15;

interface Production {
  id: number;
  project_id: number | null;
  title: string;
  status: string;
  credits_spent: number;
  cost_cleared: number;
  created_at: string;
}

interface ProjectLite { id: number; name: string; }

function fmtUsd(credits: number): string {
  return `$${(credits * USD_PER_CREDIT).toFixed(2)}`;
}

export default function CostsPanel({ projects }: { projects: ProjectLite[] }) {
  const [productions, setProductions] = useState<Production[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [showCleared, setShowCleared] = useState(false);

  const load = () =>
    fetch("/api/productions").then(r => r.json()).then(setProductions).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  async function setCleared(id: number, cleared: boolean) {
    await fetch(`/api/productions/${id}/clear-cost`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cleared }),
    });
    await load();
  }

  const projectName = (id: number | null) => projects.find(p => p.id === id)?.name ?? "(no project)";

  // Totals always cover EVERY production regardless of cleared status — clearing only hides a
  // row from the itemised list below, it never erases spend from the running total.
  const grandTotalCredits = productions.reduce((sum, p) => sum + (p.credits_spent || 0), 0);

  const byProject = new Map<string, { credits: number; count: number }>();
  productions.forEach(p => {
    const key = projectName(p.project_id);
    const entry = byProject.get(key) ?? { credits: 0, count: 0 };
    entry.credits += p.credits_spent || 0;
    entry.count += 1;
    byProject.set(key, entry);
  });
  const projectRows = [...byProject.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.credits - a.credits);

  // Itemised list: cleared rows hidden by default (toggle to review/restore), most expensive first.
  const visibleRows = useMemo(
    () => [...productions]
      .filter(p => showCleared || !p.cost_cleared)
      .sort((a, b) => (b.credits_spent || 0) - (a.credits_spent || 0)),
    [productions, showCleared],
  );
  const clearedCount = productions.filter(p => p.cost_cleared).length;
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = visibleRows.slice(clampedPage * PAGE_SIZE, clampedPage * PAGE_SIZE + PAGE_SIZE);

  if (loading) return <div className="flex-1 p-6 text-sm text-gray-400">Loading…</div>;

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-8">
      <div>
        <h2 className="text-sm font-semibold text-gray-900">Costs</h2>
        <p className="text-xs text-gray-500 mt-0.5">
          kie credits actually spent generating each production (snapshot of your account balance before/after every real keyframe and clip call). Dry runs and generation failures cost nothing and aren't tracked; USD is an estimate at ${USD_PER_CREDIT}/credit.
        </p>
      </div>

      <div className="flex items-baseline gap-2 border border-gray-200 rounded-xl px-4 py-3 bg-gray-50">
        <span className="text-[10px] uppercase tracking-widest text-gray-500">Total spent</span>
        <span className="text-lg font-semibold text-gray-900">{fmtUsd(grandTotalCredits)}</span>
        <span className="text-xs text-gray-400">({Math.round(grandTotalCredits)} credits across {productions.length} production{productions.length === 1 ? "" : "s"} — includes cleared rows)</span>
      </div>

      {/* Project comparison table */}
      <div className="space-y-2">
        <p className="text-[10px] uppercase tracking-widest text-gray-500">By project</p>
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium text-right">Productions</th>
                <th className="px-3 py-2 font-medium text-right">Credits</th>
                <th className="px-3 py-2 font-medium text-right">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {projectRows.map(row => (
                <tr key={row.name} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-700">{row.name}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{row.count}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{Math.round(row.credits)}</td>
                  <td className="px-3 py-2 text-right font-medium text-gray-900">{fmtUsd(row.credits)}</td>
                </tr>
              ))}
              {projectRows.length === 0 && (
                <tr><td colSpan={4} className="px-3 py-4 text-center text-gray-400">No productions yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Per-production breakdown — paginated, with a way to clear old entries out of the list */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-widest text-gray-500">By production</p>
          {clearedCount > 0 && (
            <button onClick={() => { setShowCleared(v => !v); setPage(0); }}
              className="text-[10px] text-gray-400 hover:text-gray-700 transition-colors">
              {showCleared ? "Hide" : "Show"} cleared ({clearedCount})
            </button>
          )}
        </div>
        <div className="border border-gray-200 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 text-gray-500 text-left">
                <th className="px-3 py-2 font-medium">Production</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Credits</th>
                <th className="px-3 py-2 font-medium text-right">Est. cost</th>
                <th className="px-3 py-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(p => (
                <tr key={p.id} className={`border-t border-gray-100 ${p.cost_cleared ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2 text-gray-700 truncate max-w-xs" title={p.title}>{p.title}</td>
                  <td className="px-3 py-2 text-gray-500">{projectName(p.project_id)}</td>
                  <td className="px-3 py-2 text-gray-400">{p.status}</td>
                  <td className="px-3 py-2 text-right text-gray-500">{Math.round(p.credits_spent || 0)}</td>
                  <td className="px-3 py-2 text-right font-medium text-gray-900">{fmtUsd(p.credits_spent || 0)}</td>
                  <td className="px-3 py-2 text-right">
                    {p.cost_cleared ? (
                      <button onClick={() => setCleared(p.id, false)} className="text-gray-400 hover:text-gray-700 transition-colors">↺ restore</button>
                    ) : (
                      <button onClick={() => setCleared(p.id, true)} title="Hide from this list (total is unaffected)"
                        className="text-gray-300 hover:text-red-500 transition-colors">✕ clear</button>
                    )}
                  </td>
                </tr>
              ))}
              {pageRows.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-400">
                  {productions.length === 0 ? "No productions yet" : "Nothing to show — all entries are cleared"}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="flex items-center justify-center gap-3 text-xs text-gray-500">
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={clampedPage === 0}
              className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">← Prev</button>
            <span>Page {clampedPage + 1} of {pageCount}</span>
            <button onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={clampedPage >= pageCount - 1}
              className="px-2 py-1 rounded border border-gray-200 disabled:opacity-30 hover:bg-gray-50 transition-colors">Next →</button>
          </div>
        )}
      </div>
    </div>
  );
}
