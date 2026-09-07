/**
 * Pipeline Graph — SVG-based visual representation of agent handoff relationships.
 *
 * Shows agents as nodes and handoff relationships as directed edges.
 * Animated dots flow along edges when agents are actively working.
 * Bottlenecks (agents with long task queues) are highlighted in red.
 */

import type { Store } from "../store";
import type { AgentInfo } from "../../../shared/types";
import { generateCharPreviewDataURL } from "../game/chargen";

interface GraphEdge {
  from: string;
  to: string;
  label: string;
  active: boolean;
}

const NODE_RADIUS = 32;
const SVG_NS = "http://www.w3.org/2000/svg";

/** Compute a simple circular layout for nodes. */
function layoutNodes(agents: AgentInfo[], width: number, height: number): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const hireable = agents.filter((a) => !a.id.startsWith("office-manager") && !a.id.startsWith("hermes"));

  if (hireable.length === 0) return positions;

  if (hireable.length === 1) {
    positions.set(hireable[0].id, { x: width / 2, y: height / 2 });
    return positions;
  }

  // Circle layout
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;

  for (let i = 0; i < hireable.length; i++) {
    const angle = (i / hireable.length) * Math.PI * 2 - Math.PI / 2;
    positions.set(hireable[i].id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
  }

  return positions;
}

/** Build edges from schedules with handoffTo and from task card dependencies. */
function buildEdges(store: Store): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const agents = [...store.agents.values()];
  const agentIds = new Set(agents.map((a) => a.id));

  // From schedules: agentId → handoffTo
  for (const sched of store.schedules.values()) {
    if (!sched.enabled || !sched.handoffTo) continue;
    if (agentIds.has(sched.agentId) && agentIds.has(sched.handoffTo)) {
      edges.push({
        from: sched.agentId,
        to: sched.handoffTo,
        label: sched.name,
        active: true,
      });
    }
  }

  // From task cards: if card has assignedAgentId and dependsOnCardIds,
  // and the dependency card has a different assignedAgentId, draw an edge
  const cards = [...store.board.values()];
  const cardAgentMap = new Map<string, string | null>();
  for (const c of cards) cardAgentMap.set(c.id, c.assignedAgentId);

  for (const c of cards) {
    if (!c.assignedAgentId || !c.dependsOnCardIds) continue;
    for (const depId of c.dependsOnCardIds) {
      const depAgent = cardAgentMap.get(depId);
      if (depAgent && depAgent !== c.assignedAgentId && agentIds.has(depAgent) && agentIds.has(c.assignedAgentId)) {
        // Avoid duplicate edges
        const exists = edges.some((e) => e.from === depAgent && e.to === c.assignedAgentId);
        if (!exists) {
          edges.push({
            from: depAgent,
            to: c.assignedAgentId,
            label: "",
            active: false,
          });
        }
      }
    }
  }

  return edges;
}

/** Create the SVG pipeline graph and return it as an HTML element. */
export function createPipelineGraph(store: Store): HTMLDivElement {
  const container = document.createElement("div");
  container.className = "pipeline-graph-container";
  container.style.cssText = `
    width: 100%; position: relative; border-radius: 8px;
    background: var(--panel-soft); border: 1px solid var(--panel-edge);
    padding: 8px; box-sizing: border-box;
  `;

  const agents = [...store.agents.values()].filter(
    (a) => !a.id.startsWith("office-manager") && !a.id.startsWith("hermes"),
  );

  if (agents.length === 0) {
    container.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: center; min-height: 200px; color: var(--dim); font-size: 13px; text-align: center; padding: 20px;">
        Hire agents to see your pipeline graph.
      </div>
    `;
    return container;
  }

  // Padded viewBox so nodes/badges/labels at edges aren't clipped
  const PAD = 50;
  const width = 600;
  const height = 400;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${-PAD} ${-PAD} ${width + PAD * 2} ${height + PAD * 2}`);
  svg.style.cssText = "width: 100%; display: block; aspect-ratio: 3 / 2;";

  // Arrow marker definition
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.innerHTML = `
    <marker id="pipeline-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="rgba(88, 200, 102, 0.6)" />
    </marker>
    <marker id="pipeline-arrow-active" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#58c866" />
    </marker>
  `;
  svg.appendChild(defs);

  const positions = layoutNodes(agents, width, height);
  const edges = buildEdges(store);

  // No-edges empty state: show helpful message overlay
  if (edges.length === 0) {
    const emptyMsg = document.createElementNS(SVG_NS, "text");
    emptyMsg.setAttribute("x", String(width / 2));
    emptyMsg.setAttribute("y", String(height / 2));
    emptyMsg.setAttribute("text-anchor", "middle");
    emptyMsg.setAttribute("fill", "var(--dim)");
    emptyMsg.setAttribute("font-size", "13");
    emptyMsg.style.cssText = "user-select: none; pointer-events: none;";
    emptyMsg.textContent = "No handoffs yet — create a schedule with a handoff target";
    svg.appendChild(emptyMsg);

    const emptySub = document.createElementNS(SVG_NS, "text");
    emptySub.setAttribute("x", String(width / 2));
    emptySub.setAttribute("y", String(height / 2 + 20));
    emptySub.setAttribute("text-anchor", "middle");
    emptySub.setAttribute("fill", "var(--dim)");
    emptySub.setAttribute("font-size", "11");
    emptySub.setAttribute("opacity", "0.7");
    emptySub.style.cssText = "user-select: none; pointer-events: none;";
    emptySub.textContent = "or use a pipeline template below to see your flow";
    svg.appendChild(emptySub);
  }

  // Draw edges
  for (const edge of edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;

    // Calculate edge endpoints offset by node radius
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) continue;
    const nx = dx / dist;
    const ny = dy / dist;

    const x1 = from.x + nx * NODE_RADIUS;
    const y1 = from.y + ny * NODE_RADIUS;
    const x2 = to.x - nx * (NODE_RADIUS + 8);
    const y2 = to.y - ny * (NODE_RADIUS + 8);

    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("stroke", edge.active ? "#58c866" : "rgba(255,255,255,0.15)");
    line.setAttribute("stroke-width", "2");
    line.setAttribute("marker-end", edge.active ? "url(#pipeline-arrow-active)" : "url(#pipeline-arrow)");
    svg.appendChild(line);

    // Animated dot for active edges
    if (edge.active) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("r", "3");
      dot.setAttribute("fill", "#58c866");
      dot.setAttribute("cx", String(x1));
      dot.setAttribute("cy", String(y1));

      const animate = document.createElementNS(SVG_NS, "animateMotion");
      animate.setAttribute("dur", "2s");
      animate.setAttribute("repeatCount", "indefinite");
      animate.setAttribute("path", `M ${x1},${y1} L ${x2},${y2}`);
      dot.appendChild(animate);
      svg.appendChild(dot);
    }

    // Edge label
    if (edge.label) {
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const labelBg = document.createElementNS(SVG_NS, "rect");
      labelBg.setAttribute("x", String(midX - 30));
      labelBg.setAttribute("y", String(midY - 8));
      labelBg.setAttribute("width", "60");
      labelBg.setAttribute("height", "16");
      labelBg.setAttribute("rx", "4");
      labelBg.setAttribute("fill", "rgba(13, 15, 26, 0.8)");
      svg.appendChild(labelBg);

      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", String(midX));
      label.setAttribute("y", String(midY + 4));
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("fill", "#9aa0b0");
      label.setAttribute("font-size", "10");
      label.style.cssText = "user-select: none; pointer-events: none;";
      const shortLabel = edge.label.length > 12 ? edge.label.slice(0, 11) + "…" : edge.label;
      label.textContent = shortLabel;
      svg.appendChild(label);
    }
  }

  // Draw nodes
  for (const agent of agents) {
    const pos = positions.get(agent.id);
    if (!pos) continue;

    const isWorking = agent.status === "working" || agent.status === "thinking";
    const isIdle = agent.status === "idle";
    const statusColor = isWorking ? "#58c866" : isIdle ? "#6b7280" : "#3a8cd4";
    const color = agent.accent || statusColor;

    // Glow for working agents
    if (isWorking) {
      const glow = document.createElementNS(SVG_NS, "circle");
      glow.setAttribute("cx", String(pos.x));
      glow.setAttribute("cy", String(pos.y));
      glow.setAttribute("r", String(NODE_RADIUS + 6));
      glow.setAttribute("fill", "none");
      glow.setAttribute("stroke", color);
      glow.setAttribute("stroke-width", "1");
      glow.setAttribute("opacity", "0.3");
      const pulseAnim = document.createElementNS(SVG_NS, "animate");
      pulseAnim.setAttribute("attributeName", "r");
      pulseAnim.setAttribute("values", `${NODE_RADIUS + 4};${NODE_RADIUS + 10};${NODE_RADIUS + 4}`);
      pulseAnim.setAttribute("dur", "2s");
      pulseAnim.setAttribute("repeatCount", "indefinite");
      glow.appendChild(pulseAnim);
      svg.appendChild(glow);
    }

    // Node circle
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", String(pos.x));
    circle.setAttribute("cy", String(pos.y));
    circle.setAttribute("r", String(NODE_RADIUS));
    circle.setAttribute("fill", "rgba(20, 22, 30, 0.9)");
    circle.setAttribute("stroke", color);
    circle.setAttribute("stroke-width", "2");
    circle.style.cssText = "cursor: pointer;";
    circle.addEventListener("click", () => store.select(agent.id));

    // Hover tooltip via SVG <title>
    const tooltip = document.createElementNS(SVG_NS, "title");
    const statusLabel = isWorking ? "Working" : isIdle ? "Idle" : "Busy";
    const taskInfo = agent.task ? `Task: ${agent.task.slice(0, 60)}` : "No active task";
    tooltip.textContent = `${agent.name} — ${statusLabel}\n${taskInfo}\nTasks done: ${agent.tasksDone}`;
    circle.appendChild(tooltip);
    svg.appendChild(circle);

    // Agent avatar image (or initial fallback)
    let avatarUrl: string | null = null;
    if (agent.appearance) {
      avatarUrl = generateCharPreviewDataURL(agent.appearance, 2);
    } else if (agent.sprite != null) {
      avatarUrl = `assets/characters/char-${agent.sprite}.png`;
    }

    if (avatarUrl) {
      const clipId = `clip-${agent.id.replace(/[^a-zA-Z0-9]/g, "")}`;
      const clip = document.createElementNS(SVG_NS, "clipPath");
      clip.setAttribute("id", clipId);
      const clipCircle = document.createElementNS(SVG_NS, "circle");
      clipCircle.setAttribute("cx", String(pos.x));
      clipCircle.setAttribute("cy", String(pos.y));
      clipCircle.setAttribute("r", String(NODE_RADIUS - 2));
      clip.appendChild(clipCircle);
      defs.appendChild(clip);

      const img = document.createElementNS(SVG_NS, "image");
      img.setAttribute("href", avatarUrl);
      img.setAttribute("x", String(pos.x - NODE_RADIUS));
      img.setAttribute("y", String(pos.y - NODE_RADIUS));
      img.setAttribute("width", String(NODE_RADIUS * 2));
      img.setAttribute("height", String(NODE_RADIUS * 2));
      img.setAttribute("clip-path", `url(#${clipId})`);
      img.setAttribute("preserveAspectRatio", "xMidYMid meet");
      img.style.cssText = "pointer-events: none;";
      svg.appendChild(img);
    } else {
      const initial = document.createElementNS(SVG_NS, "text");
      initial.setAttribute("x", String(pos.x));
      initial.setAttribute("y", String(pos.y + 5));
      initial.setAttribute("text-anchor", "middle");
      initial.setAttribute("fill", "#e8eaf0");
      initial.setAttribute("font-size", "16");
      initial.setAttribute("font-weight", "bold");
      initial.style.cssText = "user-select: none; pointer-events: none;";
      initial.textContent = agent.name.charAt(0).toUpperCase();
      svg.appendChild(initial);
    }

    // Agent name below
    const name = document.createElementNS(SVG_NS, "text");
    name.setAttribute("x", String(pos.x));
    name.setAttribute("y", String(pos.y + NODE_RADIUS + 16));
    name.setAttribute("text-anchor", "middle");
    name.setAttribute("fill", "#c4c8d4");
    name.setAttribute("font-size", "11");
    name.style.cssText = "user-select: none; pointer-events: none;";
    const shortName = agent.name.length > 14 ? agent.name.slice(0, 13) + "…" : agent.name;
    name.textContent = shortName;
    svg.appendChild(name);

    // Task count badge
    if (agent.tasksDone > 0) {
      const badgeX = pos.x + NODE_RADIUS - 8;
      const badgeY = pos.y - NODE_RADIUS + 4;
      const badge = document.createElementNS(SVG_NS, "circle");
      badge.setAttribute("cx", String(badgeX));
      badge.setAttribute("cy", String(badgeY));
      badge.setAttribute("r", "10");
      badge.setAttribute("fill", "#58c866");
      svg.appendChild(badge);

      const badgeText = document.createElementNS(SVG_NS, "text");
      badgeText.setAttribute("x", String(badgeX));
      badgeText.setAttribute("y", String(badgeY + 4));
      badgeText.setAttribute("text-anchor", "middle");
      badgeText.setAttribute("fill", "#0d0f1a");
      badgeText.setAttribute("font-size", "10");
      badgeText.setAttribute("font-weight", "bold");
      badgeText.style.cssText = "user-select: none; pointer-events: none;";
      badgeText.textContent = String(agent.tasksDone);
      svg.appendChild(badgeText);
    }
  }

  container.appendChild(svg);

  // Compact legend below graph
  const legend = document.createElement("div");
  legend.style.cssText = "display: flex; flex-wrap: wrap; gap: 12px; padding: 6px 4px 2px; font-size: 10px; color: var(--dim);";
  legend.innerHTML = `
    <span style="display: inline-flex; align-items: center; gap: 4px;">
      <span style="display: inline-block; width: 16px; height: 2px; background: #58c866;"></span> Active handoff
    </span>
    <span style="display: inline-flex; align-items: center; gap: 4px;">
      <span style="display: inline-block; width: 16px; height: 2px; background: rgba(255,255,255,0.15);"></span> Task dependency
    </span>
    <span style="display: inline-flex; align-items: center; gap: 4px;">
      <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; border: 1px solid #58c866;"></span> Working now
    </span>
    <span style="display: inline-flex; align-items: center; gap: 4px;">
      <span style="display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #58c866;"></span> Tasks completed
    </span>
  `;
  container.appendChild(legend);

  return container;
}
