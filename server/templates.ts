import type { Express } from "express";
import * as db from "../lib/db";

export interface TemplateShotInput {
  description: string | null;
  image_prompt: string | null;
  video_prompt: string | null;
  camera_shot: string | null;
}

export interface TemplateDeps {
  // Rewrites ONE shot's product-specific text for a new product while preserving camera
  // direction/pacing/structure — implemented in index.ts (needs the Anthropic client).
  adaptShotForProduct: (shot: TemplateShotInput, productBrief: string) => Promise<{
    description: string;
    image_prompt: string;
    video_prompt: string;
  }>;
}

// Copies the structural/creative fields of a production's shots into a new production — used
// both for saving a template and for applying one. Deliberately does NOT carry hero/character/
// product-image references: those are specific to the ORIGINAL product, not the reusable craft.
function copyShotStructure(
  sourceShots: db.ProductionShot[],
  destProductionId: number,
  rewrite?: (shot: db.ProductionShot, index: number) => { description: string; image_prompt: string; video_prompt: string },
) {
  sourceShots.forEach((s, i) => {
    const text = rewrite ? rewrite(s, i) : { description: s.description, image_prompt: s.image_prompt, video_prompt: s.video_prompt };
    db.createProductionShot(destProductionId, {
      shot_number: s.shot_number,
      description: text.description,
      image_prompt: text.image_prompt,
      video_prompt: text.video_prompt,
      camera_shot: s.camera_shot,
      duration_hint: s.duration_hint,
      label_visible: s.label_visible !== 0,
      scene_id: s.scene_id,
      use_character: s.use_character !== 0,
    });
  });
}

export function registerTemplateRoutes(app: Express, deps: TemplateDeps) {
  // Save an existing production's shot structure as a reusable, product-agnostic template.
  app.post("/api/productions/:id/save-as-template", (req, res) => {
    const id = Number(req.params.id);
    const src = db.getProduction(id);
    if (!src) return res.status(404).json({ error: "Production not found" });
    const name = (req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "Missing name" });
    try {
      const template = db.createProduction(name, null, null);
      db.updateProduction(template.id, {
        is_template: 1,
        style: src.style,
        platform: src.platform,
        aspect_ratio: src.aspect_ratio,
        content_style: src.content_style,
      });
      copyShotStructure(db.getProductionShots(id), template.id);
      res.json({ template: db.getProduction(template.id) }); // re-fetch — template var above predates the update
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/templates", (_req, res) => {
    res.json(db.listTemplates());
  });

  app.get("/api/templates/:id", (req, res) => {
    const t = db.getProduction(Number(req.params.id));
    if (!t || !t.is_template) return res.status(404).json({ error: "Template not found" });
    res.json({ production: t, shots: db.getProductionShots(t.id) });
  });

  app.delete("/api/templates/:id", (req, res) => {
    const t = db.getProduction(Number(req.params.id));
    if (!t || !t.is_template) return res.status(404).json({ error: "Template not found" });
    db.deleteProduction(t.id);
    res.json({ ok: true });
  });

  // Apply a template to a new product: clones its shot structure into a real production, then
  // runs one AI rewrite pass per shot to swap in the new product while keeping every camera
  // direction, pacing beat, and structural decision unchanged.
  app.post("/api/templates/:id/apply", async (req, res) => {
    const templateId = Number(req.params.id);
    const template = db.getProduction(templateId);
    if (!template || !template.is_template) return res.status(404).json({ error: "Template not found" });
    const { projectId, productBrief, title } = req.body as { projectId?: number | null; productBrief?: string; title?: string };
    if (!productBrief?.trim()) return res.status(400).json({ error: "Missing productBrief" });
    try {
      const production = db.createProduction(title?.trim() || `${template.title} — new product`, projectId ?? null, null);
      db.updateProduction(production.id, {
        style: template.style,
        platform: template.platform,
        aspect_ratio: template.aspect_ratio,
        content_style: template.content_style,
      });
      const templateShots = db.getProductionShots(templateId);
      const adapted = await Promise.all(templateShots.map(s => deps.adaptShotForProduct(s, productBrief)));
      copyShotStructure(templateShots, production.id, (_s, i) => adapted[i]);
      res.json({ production: db.getProduction(production.id), shots: db.getProductionShots(production.id) }); // re-fetch — production var above predates the update
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
