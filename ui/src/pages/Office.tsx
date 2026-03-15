import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import type { Agent, Issue } from "@paperclipai/shared";

// ── Constants ──────────────────────────────────────────────────────────────────
const S = 3;    // pixel scale
const T = 16;   // tile size in source px
const TS = T * S; // 48px on canvas
const CW = 10;  // character width in source px
const CH = 18;  // character height in source px

// ── Types ──────────────────────────────────────────────────────────────────────
interface OfficeAgent {
  id: string;
  name: string;
  role: string;
  officeStatus: "running" | "blocked" | "idle";
  currentTask: string | null;
  currentIssueIdentifier: string | null;
  tx: number;
  ty: number;
  _hitX?: number;
  _hitY?: number;
  _hitW?: number;
  _hitH?: number;
}

// ── Role colour palettes ───────────────────────────────────────────────────────
const ROLE_PAL: Record<string, { skin: string; hair: string; shirt: string; pants: string; shoe: string }> = {
  ceo:        { skin:"#e8c87a", hair:"#2a1a00", shirt:"#3730a3", pants:"#1e1b4b", shoe:"#1a0a00" },
  cmo:        { skin:"#d4a870", hair:"#5a1a2a", shirt:"#db2777", pants:"#831843", shoe:"#1a0800" },
  pm:         { skin:"#c8a870", hair:"#3a2a1a", shirt:"#0d9488", pants:"#134e4a", shoe:"#0a1a1a" },
  engineer:   { skin:"#c87040", hair:"#1a1a2a", shirt:"#1d4ed8", pants:"#1e3a8a", shoe:"#0a0a18" },
  designer:   { skin:"#d4a090", hair:"#6b21a8", shirt:"#9333ea", pants:"#581c87", shoe:"#1a0a28" },
  qa:         { skin:"#d0b090", hair:"#3a2010", shirt:"#c2410c", pants:"#7c2d12", shoe:"#180800" },
  devops:     { skin:"#909090", hair:"#080808", shirt:"#0f172a", pants:"#0a0a0a", shoe:"#050505" },
  security:   { skin:"#607060", hair:"#1a1a1a", shirt:"#0c1c0c", pants:"#0a0a0a", shoe:"#060606" },
  researcher: { skin:"#b0c8d0", hair:"#4a3a2a", shirt:"#0e7490", pants:"#0c4a6e", shoe:"#080c12" },
  general:    { skin:"#c8c0b0", hair:"#5a4a3a", shirt:"#475569", pants:"#334155", shoe:"#0e1420" },
};

function pal(role: string) {
  return ROLE_PAL[role] ?? ROLE_PAL.general!;
}

// ── Zone + desk layout ────────────────────────────────────────────────────────
const ROOM_W = 28, ROOM_H = 16;

const ZONE_DEFS = [
  { id:"csuite",      tx:0,  ty:0,  tw:7,  th:4,  floor:"#1e1230", label:"C-Suite",        roles:["ceo","cmo"] },
  { id:"pm",          tx:7,  ty:0,  tw:7,  th:4,  floor:"#122018", label:"PM Wing",         roles:["pm"] },
  { id:"design",      tx:14, ty:0,  tw:14, th:4,  floor:"#12102a", label:"Design Wing",     roles:["designer"] },
  { id:"engineering", tx:0,  ty:4,  tw:20, th:7,  floor:"#0c1220", label:"Engineering",     roles:["engineer","researcher"] },
  { id:"qa",          tx:20, ty:4,  tw:8,  th:7,  floor:"#241010", label:"QA Lab",          roles:["qa"] },
  { id:"ops",         tx:0,  ty:11, tw:14, th:5,  floor:"#0a0a10", label:"Ops & Security",  roles:["devops","security"] },
  { id:"marketing",   tx:14, ty:11, tw:14, th:5,  floor:"#0e1a1a", label:"Marketing",       roles:["general"] },
];

const ZONE_DESKS: Record<string, [number, number][]> = {
  csuite:      [ [1,1], [4,1], [1,2], [4,2] ],
  pm:          [ [8,1], [11,1], [8,2], [11,2] ],
  design:      [ [15,1], [18,1], [21,1], [24,1], [15,2], [18,2], [21,2], [24,2] ],
  engineering: [ [1,5], [4,5], [7,5], [10,5], [13,5], [16,5],
                 [1,7], [4,7], [7,7], [10,7], [13,7], [16,7] ],
  qa:          [ [21,5], [24,5], [21,7], [24,7] ],
  ops:         [ [1,12], [4,12], [7,12], [10,12] ],
  marketing:   [ [15,12], [18,12], [21,12], [24,12] ],
};

function agentZone(agent: { name: string; role: string }): string {
  const n = (agent.name || "").toLowerCase();
  if (n.includes("community manager") || n.includes("content marketer")) return "marketing";
  if (n.includes("security")) return "ops";
  if (n.includes("marketing qa")) return "qa";
  for (const z of ZONE_DEFS) if (z.roles.includes(agent.role)) return z.id;
  return "engineering";
}

function assignDesks(agentList: Omit<OfficeAgent, "tx" | "ty">[]): OfficeAgent[] {
  const slotQueues: Record<string, [number, number][]> = {};
  for (const z of ZONE_DEFS) slotQueues[z.id] = [...(ZONE_DESKS[z.id] ?? [])];

  const placed: OfficeAgent[] = [];
  for (const agent of agentList) {
    const zid = agentZone(agent);
    const q = slotQueues[zid] ?? slotQueues["engineering"]!;
    if (q.length === 0) {
      slotQueues["engineering"]!.push([(placed.length % 6) * 3 + 1, 4 + Math.floor(placed.length / 6) * 2 + 5]);
    }
    const slot = q.shift() ?? [1, 4];
    placed.push({ ...agent, tx: slot[0]!, ty: slot[1]! });
  }
  return placed;
}

// ── Drawing helpers ────────────────────────────────────────────────────────────
function drawChar(ctx: CanvasRenderingContext2D, ox: number, oy: number, role: string, frame: number, status: string) {
  const c = pal(role);
  const X = ox * S, Y = oy * S;
  function p(rx: number, ry: number, col: string) {
    ctx.fillStyle = col;
    ctx.fillRect(X + rx * S, Y + ry * S, S, S);
  }
  for (let x = 2; x <= 7; x++) p(x, 0, c.hair);
  for (let x = 1; x <= 8; x++) p(x, 1, c.hair);
  for (let y = 1; y <= 5; y++)
    for (let x = 1; x <= 8; x++) {
      if (y === 1 && (x < 2 || x > 7)) continue;
      if (y === 5 && (x < 2 || x > 7)) continue;
      p(x, y, c.skin);
    }
  p(3, 3, status === "running" ? "#2244ee" : "#1a1a1a");
  p(6, 3, status === "running" ? "#2244ee" : "#1a1a1a");
  if (status === "running") { p(4, 5, "#ee4444"); p(5, 5, "#ee4444"); }
  else if (status === "blocked") { p(3, 5, "#884444"); p(4, 5, "#884444"); p(5, 5, "#884444"); }
  else { p(4, 5, "#c08070"); }
  p(4, 6, c.skin); p(5, 6, c.skin);
  for (let y = 6; y <= 11; y++)
    for (let x = 2; x <= 7; x++) {
      if (y === 6 && (x < 4 || x > 5)) continue;
      p(x, y, c.shirt);
    }
  const swing = frame === 1 ? 1 : 0;
  for (let y = 7; y <= 10; y++) {
    p(0 + swing, y, c.shirt); p(1 + swing, y, c.shirt);
    p(8 - swing, y, c.shirt); p(9 - swing, y, c.shirt);
  }
  p(0 + swing, 11, c.skin); p(9 - swing, 11, c.skin);
  const lL = frame === 1 ? -1 : 0;
  const lR = frame === 1 ? 0 : -1;
  for (let y = 11; y <= 15; y++) {
    p(2, y + lL, c.pants); p(3, y + lL, c.pants);
    p(6, y + lR, c.pants); p(7, y + lR, c.pants);
  }
  p(2, 16 + lL, c.shoe); p(3, 16 + lL, c.shoe); p(4, 16 + lL, c.shoe);
  p(5, 16 + lR, c.shoe); p(6, 16 + lR, c.shoe); p(7, 16 + lR, c.shoe);
  if (status === "running") {
    ctx.fillStyle = "rgba(0,230,118,0.9)";
    ctx.fillRect(X + 4 * S, Y - 4 * S, 2 * S, 2 * S);
  }
  if (status === "blocked") {
    ctx.fillStyle = "rgba(255,82,82,0.9)";
    ctx.fillRect(X + 3 * S, Y - 4 * S, 4 * S, 2 * S);
  }
}

function buildSprites(): Record<string, Record<string, HTMLCanvasElement>> {
  const sprites: Record<string, Record<string, HTMLCanvasElement>> = {};
  for (const role of Object.keys(ROLE_PAL)) {
    sprites[role] = {};
    for (const frame of [0, 1]) {
      for (const status of ["idle", "running", "blocked"]) {
        const key = `${frame}_${status}`;
        const oc = document.createElement("canvas");
        oc.width = CW * S;
        oc.height = (CH + 4) * S;
        const octx = oc.getContext("2d")!;
        drawChar(octx, 0, 4, role, frame, status);
        sprites[role]![key] = oc;
      }
    }
  }
  return sprites;
}

function dayNightAlpha(): number {
  const h = new Date().getHours() + new Date().getMinutes() / 60;
  if (h >= 9 && h < 18) return 0;
  if (h >= 18 && h < 20) return ((h - 18) / 2) * 0.5;
  if (h >= 7 && h < 9) return ((9 - h) / 2) * 0.5;
  return 0.5;
}

function displayName(name: string): string {
  return (name || "agent")
    .replace(/\s*[-–]\s*(CEO|CMO|PM|SWE|QA|DevOps|DevOp|Director|Manager|Engineer|Artist|Marketer|Consultant|Specialist|Lead|Critic|Geneticist|Folklorist|Persistence|Community).*$/i, "")
    .trim()
    .slice(0, 12);
}

function shortTask(task: string): string {
  return task.length > 36 ? task.slice(0, 34) + "…" : task;
}

// ── Data mapping ──────────────────────────────────────────────────────────────
function mapAgents(agents: Agent[], inProgressIssues: Issue[]): Omit<OfficeAgent, "tx" | "ty">[] {
  const issueByAgent = new Map<string, Issue>();
  for (const issue of inProgressIssues) {
    if (issue.assigneeAgentId && !issueByAgent.has(issue.assigneeAgentId)) {
      issueByAgent.set(issue.assigneeAgentId, issue);
    }
  }
  return agents
    .filter(a => a.status !== "terminated" && a.status !== "paused")
    .map(a => {
      const issue = issueByAgent.get(a.id);
      let officeStatus: "running" | "blocked" | "idle" = "idle";
      if (issue?.status === "blocked") officeStatus = "blocked";
      else if (issue?.status === "in_progress" || a.status === "running") officeStatus = "running";
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        officeStatus,
        currentTask: issue?.title ?? null,
        currentIssueIdentifier: issue?.identifier ?? null,
      };
    });
}

// ── Main Component ────────────────────────────────────────────────────────────
export function Office() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const animRef = useRef<number>(0);
  const spritesRef = useRef<Record<string, Record<string, HTMLCanvasElement>> | null>(null);
  const agentsRef = useRef<OfficeAgent[]>([]);
  const walkTickRef = useRef(0);
  const walkToggleRef = useRef(0);
  const particlesRef = useRef<{ x: number; y: number; vx: number; vy: number; life: number; maxLife: number; col: string; r: number }[]>([]);
  const boardGlowRef = useRef(0);
  const boardGlowDirRef = useRef(1);
  const coffeeTimerRef = useRef(0);
  const wanderRef = useRef<Record<string, { dx: number; dy: number; steps: number; stepsDone: number; px: number; py: number }>>({});
  const sceneOffRef = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<OfficeAgent | null>(null);
  const hoveredIdRef = useRef<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Office" }]);
  }, [setBreadcrumbs]);

  // Data queries
  const { data: agentList } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const { data: inProgressIssues } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "in_progress_blocked"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: "in_progress,blocked" }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  // Update agents ref when data changes
  useEffect(() => {
    if (!agentList) return;
    const issues = inProgressIssues ?? [];
    const mapped = mapAgents(agentList, issues);
    agentsRef.current = assignDesks(mapped);
  }, [agentList, inProgressIssues]);

  // Canvas resize
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.imageSmoothingEnabled = false;
    const roomPixW = ROOM_W * TS;
    const roomPixH = ROOM_H * TS;
    sceneOffRef.current = {
      x: Math.max(0, Math.floor((canvas.width - roomPixW) / 2)),
      y: Math.max(0, Math.floor((canvas.height - roomPixH) / 2)),
      w: canvas.width,
      h: canvas.height,
    };
  }, []);

  useEffect(() => {
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [resize]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    resize();
    spritesRef.current = buildSprites();

    function zoneAt(tx: number, ty: number) {
      for (const z of ZONE_DEFS)
        if (tx >= z.tx && tx < z.tx + z.tw && ty >= z.ty && ty < z.ty + z.th) return z;
      return null;
    }

    function spawnParticle(x: number, y: number, vx: number, vy: number, life: number, col: string, r: number) {
      if (particlesRef.current.length < 300)
        particlesRef.current.push({ x, y, vx, vy, life, maxLife: life, col, r });
    }

    function drawRoom(ctx: CanvasRenderingContext2D) {
      const { x: offX, y: offY, w: cW, h: cH } = sceneOffRef.current;
      ctx.fillStyle = "#0a0a14";
      ctx.fillRect(0, 0, cW, cH);
      for (let ty = 0; ty < ROOM_H; ty++) {
        for (let tx = 0; tx < ROOM_W; tx++) {
          const z = zoneAt(tx, ty);
          const base = z ? z.floor : "#0a0a14";
          const cx = offX + tx * TS, cy = offY + ty * TS;
          ctx.fillStyle = base;
          ctx.fillRect(cx, cy, TS, TS);
          ctx.fillStyle = "rgba(255,255,255,0.03)";
          ctx.fillRect(cx, cy, TS, 1);
          ctx.fillRect(cx, cy, 1, TS);
        }
      }
      ctx.font = `${S * 2}px 'Press Start 2P', monospace`;
      for (const z of ZONE_DEFS) {
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillText(z.label, offX + z.tx * TS + S * 2, offY + z.ty * TS + S * 4);
      }
    }

    function drawDesk(ctx: CanvasRenderingContext2D, tx: number, ty: number) {
      const { x: offX, y: offY } = sceneOffRef.current;
      const cx = offX + tx * TS, cy = offY + ty * TS;
      ctx.fillStyle = "#5c3a1e";
      ctx.fillRect(cx + 2, cy + TS / 2, TS - 4, TS / 2 - 2);
      ctx.fillStyle = "#7a5030";
      ctx.fillRect(cx + 4, cy + TS / 2 + 2, TS - 8, TS / 2 - 6);
      ctx.fillStyle = "#0a0a18";
      ctx.fillRect(cx + TS / 4, cy + TS / 4, TS / 2, TS / 3);
      ctx.fillStyle = "#1a2a8a";
      ctx.fillRect(cx + TS / 4 + 2, cy + TS / 4 + 2, TS / 2 - 4, TS / 3 - 4);
      ctx.fillStyle = "#2a2a2a";
      ctx.fillRect(cx + TS / 2 - 2, cy + TS / 4 + TS / 3, 4, 6);
      ctx.fillRect(cx + TS / 3, cy + TS / 4 + TS / 3 + 4, TS / 3, 3);
    }

    function drawAllDesks(ctx: CanvasRenderingContext2D) {
      for (const slots of Object.values(ZONE_DESKS))
        for (const [tx, ty] of slots) drawDesk(ctx, tx, ty);
    }

    function drawBoardDoor(ctx: CanvasRenderingContext2D) {
      const { x: offX, y: offY } = sceneOffRef.current;
      boardGlowRef.current += boardGlowDirRef.current * 0.015;
      if (boardGlowRef.current > 1) boardGlowDirRef.current = -1;
      if (boardGlowRef.current < 0) boardGlowDirRef.current = 1;
      const g = boardGlowRef.current;
      const bx = offX + 12 * TS + TS / 4, by = offY;
      const dw = TS * 1.5, dh = TS * 1.6;
      const grad = ctx.createRadialGradient(bx + dw / 2, by + dh / 2, 2, bx + dw / 2, by + dh / 2, TS * 2);
      grad.addColorStop(0, `rgba(124,58,237,${0.25 + g * 0.3})`);
      grad.addColorStop(1, "rgba(124,58,237,0)");
      ctx.fillStyle = grad;
      ctx.fillRect(bx - TS, by - TS / 2, dw + TS * 2, dh + TS);
      ctx.fillStyle = "#1a0a2e";
      ctx.fillRect(bx - 2, by, dw + 4, dh + 2);
      ctx.fillStyle = `rgba(80,20,160,${0.6 + g * 0.35})`;
      ctx.fillRect(bx, by + 2, dw, dh - 2);
      ctx.fillStyle = `rgba(140,80,240,${0.3 + g * 0.25})`;
      ctx.fillRect(bx + 4, by + 6, dw - 8, (dh - 10) / 2);
      ctx.fillRect(bx + 4, by + 8 + (dh - 10) / 2, dw - 8, (dh - 12) / 2);
      ctx.fillStyle = `rgba(220,180,255,${0.8 + g * 0.2})`;
      ctx.fillRect(bx + dw - 8, by + dh / 2 - 2, 5, 4);
      ctx.font = `${S - 1}px 'Press Start 2P', monospace`;
      ctx.fillStyle = `rgba(210,190,255,${0.75 + g * 0.25})`;
      ctx.textAlign = "center";
      ctx.fillText("BOARD", bx + dw / 2, by + dh + S * 2);
      ctx.textAlign = "left";
      if (Math.random() < 0.15 * g) {
        spawnParticle(bx + Math.random() * dw, by + Math.random() * dh,
          (Math.random() - 0.5) * 0.8, -0.5 - Math.random() * 0.5,
          20 + Math.floor(Math.random() * 20), "#c084fc", 2);
      }
    }

    function drawEnvFurniture(ctx: CanvasRenderingContext2D, wt: number) {
      const { x: offX, y: offY } = sceneOffRef.current;

      // Coffee machine
      coffeeTimerRef.current++;
      const cofx = offX + 9 * TS, cofy = offY + 10 * TS;
      ctx.fillStyle = "#2a2a3a"; ctx.fillRect(cofx + 10, cofy + 6, TS - 20, TS - 10);
      ctx.fillStyle = "#c04020"; ctx.fillRect(cofx + 12, cofy + 8, TS - 24, 8);
      ctx.fillStyle = "#606060"; ctx.fillRect(cofx + TS / 2 - 4, cofy + TS - 10, 8, 6);
      ctx.fillStyle = "#404040"; ctx.fillRect(cofx + TS / 2 - 8, cofy + TS - 6, 16, 4);
      if (coffeeTimerRef.current % 10 === 0) {
        spawnParticle(cofx + TS / 2 + (Math.random() - 0.5) * 6, cofy + 4,
          (Math.random() - 0.5) * 0.3, -0.6 - Math.random() * 0.4,
          35 + Math.floor(Math.random() * 20), "#c0c8e0", 2);
      }

      // Plants
      [[0, 10], [12, 10], [19, 10]].forEach(([ptx, pty]) => {
        const px = offX + ptx * TS, py = offY + pty * TS;
        ctx.fillStyle = "#3a1a08"; ctx.fillRect(px + TS / 2 - 5, py + TS - 12, 10, 10);
        ctx.fillStyle = "#2a6010";
        ctx.fillRect(px + TS / 2 - 8, py + TS - 24, 6, 14);
        ctx.fillRect(px + TS / 2 - 2, py + TS - 28, 6, 18);
        ctx.fillRect(px + TS / 2 + 3, py + TS - 24, 5, 14);
      });

      // Server rack blink (engineering)
      for (let c2 = 0; c2 < 2; c2++) {
        const srx = offX + (18 + c2) * TS, sry = offY + 4 * TS;
        ctx.fillStyle = "#111120"; ctx.fillRect(srx + 2, sry + 2, TS - 4, TS - 4);
        for (let u = 0; u < 3; u++) {
          ctx.fillStyle = u % 2 === 0 ? "#0d1d0d" : "#12121c";
          ctx.fillRect(srx + 4, sry + 4 + u * 12, TS - 8, 10);
          const ledOn = (wt + c2 * 9 + u * 17) % 50 < 35;
          ctx.fillStyle = ledOn ? "#00ff50" : "#003015";
          ctx.fillRect(srx + TS - 9, sry + 6 + u * 12, 3, 3);
        }
      }

      // Terminal cursor blink (ops)
      const trx = offX + 9 * TS, trY = offY + 12 * TS;
      ctx.fillStyle = "#080808"; ctx.fillRect(trx + 2, trY + 4, TS * 2 - 4, TS - 8);
      ctx.fillStyle = "#00ff40";
      ctx.fillRect(trx + 6, trY + 10, 12, 2);
      ctx.fillRect(trx + 6, trY + 16, 20, 2);
      ctx.fillRect(trx + 6, trY + 22, 16, 2);
      if (wt % 60 < 35) ctx.fillRect(trx + 24, trY + 22, 4, 8);

      // Whiteboard (pm)
      const wx = offX + 8 * TS, wy = offY + 4;
      ctx.fillStyle = "#2a2a4a"; ctx.fillRect(wx, wy, TS * 2 + 4, TS - 8);
      ctx.fillStyle = "#e8e8f4"; ctx.fillRect(wx + 2, wy + 2, TS * 2, TS - 14);
      ctx.fillStyle = "#3a6ae8"; ctx.fillRect(wx + 8, wy + 8, 24, 2);
      ctx.fillStyle = "#e84040"; ctx.fillRect(wx + 8, wy + 14, 16, 2);
      ctx.fillStyle = "#40a840"; ctx.fillRect(wx + 8, wy + 20, 28, 2);

      // Dust motes
      if (Math.random() < 0.08) {
        spawnParticle(
          offX + Math.random() * ROOM_W * TS,
          offY + Math.random() * ROOM_H * TS,
          (Math.random() - 0.5) * 0.25, -0.15 - Math.random() * 0.15,
          100, "#8888b0", 1
        );
      }
    }

    function drawParticles(ctx: CanvasRenderingContext2D) {
      for (const p of particlesRef.current) {
        ctx.globalAlpha = (p.life / p.maxLife) * 0.75;
        ctx.fillStyle = p.col;
        ctx.fillRect(Math.round(p.x), Math.round(p.y), p.r, p.r);
      }
      ctx.globalAlpha = 1;
    }

    function drawAgents(ctx: CanvasRenderingContext2D) {
      const { x: offX, y: offY } = sceneOffRef.current;
      const sprites = spritesRef.current;
      if (!sprites) return;
      const sorted = [...agentsRef.current].sort((a, b) => a.ty - b.ty);

      for (const agent of sorted) {
        const isRunning = agent.officeStatus === "running";
        const isBlocked = agent.officeStatus === "blocked";
        const frame = isRunning ? walkToggleRef.current : 0;
        const statusKey = isRunning ? "running" : isBlocked ? "blocked" : "idle";

        // Wander
        let wander = wanderRef.current[agent.id];
        if (!wander) {
          wander = { dx: 0, dy: 0, steps: 0, stepsDone: 0, px: 0, py: 0 };
          wanderRef.current[agent.id] = wander;
        }
        if (isRunning) {
          if (wander.stepsDone >= wander.steps) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 1 + Math.random() * 1.5;
            wander.dx = Math.cos(angle) * dist * TS;
            wander.dy = Math.sin(angle) * dist * TS;
            wander.steps = 60 + Math.floor(Math.random() * 80);
            wander.stepsDone = 0;
          }
          wander.stepsDone++;
          wander.px += (wander.dx - wander.px) * 0.02;
          wander.py += (wander.dy - wander.py) * 0.02;
        } else {
          wander.px *= 0.9;
          wander.py *= 0.9;
        }

        const cx = offX + agent.tx * TS + Math.round(wander.px);
        const cy = offY + agent.ty * TS + Math.round(wander.py);
        const sprKey = `${frame}_${statusKey}`;
        const spriteCanvas = sprites[agent.role]?.[sprKey] ?? sprites["general"]?.["0_idle"];

        const plDrawW = CW * S, plDrawH = (CH + 4) * S;
        const plOffY = -12;

        // Store hit bounds
        agent._hitX = cx - 4;
        agent._hitY = cy + plOffY;
        agent._hitW = plDrawW + 8;
        agent._hitH = plDrawH + 8;

        // Hover glow
        if (hoveredIdRef.current === agent.id) {
          ctx.fillStyle = "rgba(124,58,237,0.3)";
          ctx.fillRect(agent._hitX, agent._hitY, agent._hitW, agent._hitH);
        }

        // Status aura
        if (isRunning || isBlocked) {
          ctx.globalAlpha = 0.18;
          ctx.fillStyle = isRunning ? "#00e676" : "#ff5252";
          ctx.fillRect(cx - 4, cy + plOffY - 2, plDrawW + 8, plDrawH + 4);
          ctx.globalAlpha = 1;
        }

        if (spriteCanvas) ctx.drawImage(spriteCanvas, cx - 2, cy - 12);

        // Status dot
        if (isRunning) {
          ctx.fillStyle = "rgba(0,230,118,0.9)";
          ctx.fillRect(cx + CW * S / 2 - 4, cy + plOffY - 8, 8, 6);
        } else if (isBlocked) {
          ctx.fillStyle = "rgba(255,82,82,0.9)";
          ctx.fillRect(cx + CW * S / 2 - 8, cy + plOffY - 8, 16, 6);
        }

        // Name tag
        const nameBaseY = cy + plOffY + plDrawH;
        ctx.font = `${S}px 'JetBrains Mono', monospace`;
        ctx.textAlign = "center";
        const sName = displayName(agent.name);
        const nameW = ctx.measureText(sName).width;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillRect(cx + CW * S / 2 - nameW / 2 - 2, nameBaseY + 2, nameW + 4, S + 2);
        ctx.fillStyle = isRunning ? "#00e676" : isBlocked ? "#ff5252" : "#90a4ae";
        ctx.fillText(sName, cx + CW * S / 2, nameBaseY + S + 2);
        ctx.textAlign = "left";

        // Speech bubble
        if (isRunning && agent.currentTask) {
          const bubble = shortTask(agent.currentTask);
          ctx.font = `${S - 1}px 'JetBrains Mono', monospace`;
          const bw = ctx.measureText(bubble).width + 8;
          const bh = S + 4;
          const bx2 = cx + CW * S / 2 - bw / 2;
          const by2 = cy + plOffY - bh - 8;
          ctx.fillStyle = "#1e1e3a";
          ctx.strokeStyle = "#3a3a6a";
          ctx.lineWidth = 1;
          if (ctx.roundRect) {
            ctx.beginPath(); ctx.roundRect(bx2, by2, bw, bh, 2); ctx.fill(); ctx.stroke();
          } else {
            ctx.fillRect(bx2, by2, bw, bh);
          }
          ctx.fillStyle = "#1e1e3a";
          ctx.beginPath();
          ctx.moveTo(cx + CW * S / 2 - 3, by2 + bh);
          ctx.lineTo(cx + CW * S / 2, by2 + bh + 4);
          ctx.lineTo(cx + CW * S / 2 + 3, by2 + bh);
          ctx.fill();
          ctx.fillStyle = "#c4c4e0";
          ctx.fillText(bubble, bx2 + 4, by2 + S + 1);
        }
      }
    }

    function frame() {
      if (!canvas) { animRef.current = requestAnimationFrame(frame); return; }
      const ctx2 = canvas.getContext("2d");
      if (!ctx2) { animRef.current = requestAnimationFrame(frame); return; }
      ctx2.imageSmoothingEnabled = false;

      walkTickRef.current++;
      if (walkTickRef.current % 14 === 0) walkToggleRef.current ^= 1;

      // Update particles
      const parts = particlesRef.current;
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]!;
        p.x += p.vx; p.y += p.vy; p.life--;
        if (p.life <= 0) parts.splice(i, 1);
      }

      drawRoom(ctx2);
      drawAllDesks(ctx2);
      drawEnvFurniture(ctx2, walkTickRef.current);
      drawBoardDoor(ctx2);
      drawAgents(ctx2);
      drawParticles(ctx2);

      // Day/night overlay
      const alpha = dayNightAlpha();
      if (alpha > 0.01) {
        const { x: offX, y: offY } = sceneOffRef.current;
        ctx2.fillStyle = `rgba(0,0,18,${alpha})`;
        ctx2.fillRect(offX, offY, ROOM_W * TS, ROOM_H * TS);
      }

      animRef.current = requestAnimationFrame(frame);
    }

    animRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(animRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mouse handlers
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    let found: string | null = null;
    for (const agent of agentsRef.current) {
      if (agent._hitX === undefined) continue;
      if (mx >= agent._hitX && mx <= agent._hitX + (agent._hitW ?? 0) &&
          my >= agent._hitY! && my <= agent._hitY! + (agent._hitH ?? 0)) {
        found = agent.id;
        break;
      }
    }
    hoveredIdRef.current = found;
    setHoveredId(found);
    canvas.style.cursor = found ? "pointer" : "default";
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    for (const agent of agentsRef.current) {
      if (agent._hitX === undefined) continue;
      if (mx >= agent._hitX && mx <= agent._hitX + (agent._hitW ?? 0) &&
          my >= agent._hitY! && my <= agent._hitY! + (agent._hitH ?? 0)) {
        setSelectedAgent({ ...agent });
        return;
      }
    }
    setSelectedAgent(null);
  }, []);

  const runningCount = agentsRef.current.filter(a => a.officeStatus === "running").length;
  const totalCount = agentsRef.current.length;

  return (
    <div className="flex flex-col h-full" style={{ background: "#0d0d1a", color: "#e8e8f0", fontFamily: "'JetBrains Mono', monospace" }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0.6rem 1.5rem", background: "rgba(13,13,26,0.97)",
        borderBottom: "1px solid #1e1e3a", flexShrink: 0
      }}>
        <div style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "0.6rem", color: "#a78bfa", letterSpacing: "0.05em" }}>
          PAPERCLIP <span style={{ color: "#00e676" }}>// OFFICE</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "1.2rem" }}>
          <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>
            {totalCount > 0 ? `${runningCount} / ${totalCount} running` : "loading…"}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: "0.6rem", color: "#00e676" }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%", background: "#00e676",
              animation: "blink 1.4s ease-in-out infinite"
            }} />
            LIVE
          </div>
        </div>
      </div>

      {/* Canvas scene */}
      <div ref={wrapRef} style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        <canvas
          ref={canvasRef}
          style={{ display: "block", imageRendering: "pixelated" }}
          onMouseMove={handleMouseMove}
          onClick={handleClick}
        />

        {/* Detail panel */}
        <aside style={{
          position: "absolute", top: 0, right: selectedAgent ? 0 : -320,
          width: 300, height: "100%", background: "rgba(10,10,24,0.97)",
          borderLeft: "1px solid #2a2a5a", padding: "1.5rem 1rem",
          transition: "right 0.2s ease", zIndex: 20,
          display: "flex", flexDirection: "column", gap: "0.8rem",
          backdropFilter: "blur(8px)", overflowY: "auto"
        }}>
          <button
            onClick={() => setSelectedAgent(null)}
            style={{ position: "absolute", top: "0.7rem", right: "0.7rem", background: "none", border: "none", color: "#6b7280", fontSize: "0.9rem", cursor: "pointer", lineHeight: 1 }}
          >
            ✕
          </button>
          {selectedAgent && (
            <>
              {/* Sprite preview canvas */}
              <DetailSprite role={selectedAgent.role} status={selectedAgent.officeStatus} sprites={spritesRef.current} />
              <div style={{ fontFamily: "'Press Start 2P', monospace", fontSize: "0.6rem", color: "#a78bfa", lineHeight: 1.6 }}>
                {selectedAgent.name}
              </div>
              <div style={{ fontSize: "0.65rem", color: "#6b7280" }}>{selectedAgent.role}</div>
              <div style={{
                fontSize: "0.65rem", padding: "0.3rem 0.6rem", borderRadius: 3, display: "inline-block",
                background: selectedAgent.officeStatus === "running" ? "rgba(0,230,118,0.15)" : selectedAgent.officeStatus === "blocked" ? "rgba(255,82,82,0.15)" : "rgba(69,90,100,0.2)",
                color: selectedAgent.officeStatus === "running" ? "#00e676" : selectedAgent.officeStatus === "blocked" ? "#ff5252" : "#90a4ae"
              }}>
                {selectedAgent.officeStatus}
              </div>
              <div style={{ fontSize: "0.5rem", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.1em", marginTop: "0.6rem" }}>Current Task</div>
              <div style={{
                fontSize: "0.65rem", lineHeight: 1.6,
                color: selectedAgent.currentTask ? "#e8e8f0" : "#6b7280",
                background: "#1a1a2e", borderRadius: 3, padding: "0.6rem",
                borderLeft: "2px solid #a78bfa",
                fontStyle: selectedAgent.currentTask ? "normal" : "italic"
              }}>
                {selectedAgent.currentTask ?? "No active task"}
              </div>
              {selectedAgent.currentIssueIdentifier && (
                <Link
                  to={`/${selectedAgent.currentIssueIdentifier.split("-")[0]}/issues/${selectedAgent.currentIssueIdentifier}`}
                  style={{ fontSize: "0.55rem", color: "#a78bfa", textDecoration: "none", marginTop: "0.3rem" }}
                >
                  → {selectedAgent.currentIssueIdentifier}
                </Link>
              )}
            </>
          )}
        </aside>
      </div>

      {/* Footer legend */}
      <div style={{
        display: "flex", alignItems: "center", gap: "1.2rem",
        padding: "0.4rem 1.5rem", borderTop: "1px solid #1e1e3a",
        fontSize: "0.55rem", color: "#6b7280", flexShrink: 0, flexWrap: "wrap"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#00e676", boxShadow: "0 0 4px #00e676" }} />
          Running
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#455a64" }} />
          Idle
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
          <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff5252" }} />
          Blocked
        </div>
        <span style={{ marginLeft: "auto", fontSize: "0.5rem", color: "#374151" }}>
          click any agent for details · refreshes every 30s
        </span>
      </div>

      <style>{`
        @keyframes blink { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.4;transform:scale(.8)} }
      `}</style>
    </div>
  );
}

// ── Detail sprite preview ─────────────────────────────────────────────────────
function DetailSprite({
  role,
  status,
  sprites,
}: {
  role: string;
  status: "running" | "blocked" | "idle";
  sprites: Record<string, Record<string, HTMLCanvasElement>> | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !sprites) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 90, 90);
    const key = `0_${status}`;
    const spr = sprites[role]?.[key] ?? sprites["general"]?.["0_idle"];
    if (spr) {
      const sx = Math.floor((90 - CW * S * 1.5) / 2);
      const sy = Math.floor((90 - (CH + 4) * S * 1.5) / 2) + 8;
      ctx.drawImage(spr, 0, 0, spr.width, spr.height, sx, sy, spr.width * 1.5, spr.height * 1.5);
    }
  }, [role, status, sprites]);
  return <canvas ref={canvasRef} width={90} height={90} style={{ display: "block", margin: "0 auto 0.4rem", imageRendering: "pixelated" }} />;
}
