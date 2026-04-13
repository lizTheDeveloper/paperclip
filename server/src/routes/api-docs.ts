import { Router } from "express";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

export function apiDocsRoutes() {
  const router = Router();
  const docs = require("../api-docs.json") as Record<string, unknown>;

  // GET / — Discovery document (lightweight, top-level overview)
  router.get("/", (_req, res) => {
    const { endpoints, quickstart, name, version, auth, docs_url } = docs as {
      endpoints: Record<string, { url: string; description: string }>;
      quickstart: string;
      name: string;
      version: string;
      auth: string;
      docs_url: string;
    };
    res.json({
      name,
      version,
      auth,
      quickstart,
      docs_url,
      endpoints,
    });
  });

  // GET /docs — Full endpoint documentation (all groups)
  router.get("/docs", (_req, res) => {
    const { groups, status_values, priority_values } = docs as {
      groups: Record<string, unknown>;
      status_values: string[];
      priority_values: string[];
    };
    res.json({
      groups,
      status_values,
      priority_values,
    });
  });

  // GET /docs/:group — Documentation for a specific endpoint group
  router.get("/docs/:group", (req, res) => {
    const groups = (docs as { groups: Record<string, unknown> }).groups;
    const group = groups[req.params.group];
    if (!group) {
      res.status(404).json({
        error: `Unknown endpoint group: ${req.params.group}`,
        available: Object.keys(groups),
      });
      return;
    }
    res.json(group);
  });

  return router;
}
