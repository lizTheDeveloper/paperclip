import { Router } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import type { Db } from "@paperclipai/db";
import { eq, projectWorkspaces, projects } from "@paperclipai/db";
import { assertCompanyAccess } from "./authz.js";
import { notFound, badRequest } from "../errors.js";

interface SpecMeta {
  path: string;
  title: string;
  status: string;
  date: string | null;
  author: string | null;
  parentIssue: string | null;
  project: string | null;
  scope: string | null;
  tags: string[];
  workspaceId: string;
  projectId: string;
}

interface SpecContent {
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

async function discoverSpecs(cwd: string): Promise<string[]> {
  const specsDir = path.join(cwd, "docs", "specs");
  try {
    const entries = await fs.readdir(specsDir);
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => path.join("docs", "specs", e));
  } catch {
    return [];
  }
}

function parseSpecFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const parsed = matter(raw);
  return { frontmatter: parsed.data, content: parsed.content };
}

function toSpecMeta(
  frontmatter: Record<string, unknown>,
  relPath: string,
  workspaceId: string,
  projectId: string,
): SpecMeta {
  return {
    path: relPath,
    title: (frontmatter.title as string) ?? path.basename(relPath, ".md"),
    status: (frontmatter.status as string) ?? "unknown",
    date: (frontmatter.date as string) ?? null,
    author: (frontmatter.author as string) ?? null,
    parentIssue: (frontmatter["parent-issue"] as string) ?? null,
    project: (frontmatter.project as string) ?? null,
    scope: (frontmatter.scope as string) ?? null,
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
    workspaceId,
    projectId,
  };
}

export function specsRoutes(db: Db) {
  const router = Router();

  // GET /api/companies/:companyId/specs — spec index
  router.get("/companies/:companyId/specs", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    // Get all workspaces for this company
    const workspaces = await db
      .select({
        id: projectWorkspaces.id,
        cwd: projectWorkspaces.cwd,
        projectId: projectWorkspaces.projectId,
      })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.companyId, companyId));

    const specs: SpecMeta[] = [];

    for (const ws of workspaces) {
      if (!ws.cwd) continue;
      const relPaths = await discoverSpecs(ws.cwd);
      for (const relPath of relPaths) {
        const absPath = path.join(ws.cwd, relPath);
        try {
          const raw = await fs.readFile(absPath, "utf-8");
          const { frontmatter } = parseSpecFrontmatter(raw);
          specs.push(toSpecMeta(frontmatter, relPath, ws.id, ws.projectId));
        } catch {
          // skip unreadable files
        }
      }
    }

    // Apply query filters
    const { projectId, status, q } = req.query;
    let filtered = specs;
    if (typeof projectId === "string" && projectId) {
      filtered = filtered.filter((s) => s.projectId === projectId);
    }
    if (typeof status === "string" && status) {
      filtered = filtered.filter((s) => s.status === status);
    }
    if (typeof q === "string" && q) {
      const lower = q.toLowerCase();
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(lower) ||
          (s.scope?.toLowerCase().includes(lower) ?? false),
      );
    }

    res.json(filtered);
  });

  // GET /api/companies/:companyId/specs/:workspaceId/*specPath — spec content
  router.get("/companies/:companyId/specs/:workspaceId/*specPath", async (req, res) => {
    const companyId = req.params.companyId as string;
    const workspaceId = req.params.workspaceId as string;
    assertCompanyAccess(req, companyId);

    const specPathParts = req.params.specPath as unknown as string[];
    const specPath = Array.isArray(specPathParts) ? specPathParts.join("/") : String(specPathParts);
    if (!specPath) {
      throw badRequest("Spec path is required");
    }

    // Prevent path traversal
    const normalized = path.normalize(specPath);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
      throw badRequest("Invalid spec path");
    }

    // Verify workspace belongs to this company
    const [workspace] = await db
      .select({ id: projectWorkspaces.id, cwd: projectWorkspaces.cwd })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, workspaceId));

    if (!workspace || !workspace.cwd) {
      throw notFound("Workspace not found");
    }

    const absPath = path.join(workspace.cwd, normalized);

    // Ensure resolved path stays within workspace cwd
    const resolved = path.resolve(absPath);
    if (!resolved.startsWith(path.resolve(workspace.cwd))) {
      throw badRequest("Invalid spec path");
    }

    try {
      const raw = await fs.readFile(resolved, "utf-8");
      const { frontmatter, content } = parseSpecFrontmatter(raw);
      const result: SpecContent = {
        path: normalized,
        frontmatter,
        content,
      };
      res.json(result);
    } catch {
      throw notFound("Spec file not found");
    }
  });

  return router;
}
