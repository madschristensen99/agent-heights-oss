/**
 * Shared pipeline templates — imported by both server and client.
 */

import type { PipelineTemplate } from "./types.js";

export const PIPELINE_TEMPLATES: PipelineTemplate[] = [
  {
    id: "daily-standup-report",
    name: "Daily Standup Report",
    description: "Collects status from all agents, summarizes, and posts a daily report to the feed.",
    category: "Reporting",
    icon: "📋",
    roles: ["collector", "summarizer"],
    steps: [
      {
        role: "collector",
        name: "Gather Status",
        task: "Check the task board and all agent logs. Collect a brief status update from each agent: what they completed, what they're working on, and any blockers. Format as a structured list.",
        cronExpression: "0 9 * * *",
      },
      {
        role: "summarizer",
        name: "Summarize & Post",
        task: "Take the collected status updates and write a concise daily standup summary. Highlight completed work, in-progress items, and blockers. Post the summary to the office feed.",
        cronExpression: "0 9 * * *",
      },
    ],
  },
  {
    id: "research-write-review",
    name: "Research → Write → Review",
    description: "Researcher gathers info, writer drafts content, reviewer checks quality. Chain-triggered.",
    category: "Content",
    icon: "✍️",
    roles: ["researcher", "writer", "reviewer"],
    steps: [
      {
        role: "researcher",
        name: "Research",
        task: "Research the topic and gather key findings, sources, and data points. Compile a research brief with all relevant information organized by subtopic.",
        cronExpression: "0 9 * * 1",
      },
      {
        role: "writer",
        name: "Draft",
        task: "Using the research brief, write a complete first draft of the content. Focus on clarity, structure, and covering all key points from the research.",
        cronExpression: "0 9 * * 1",
      },
      {
        role: "reviewer",
        name: "Review & Polish",
        task: "Review the draft for accuracy, clarity, and completeness. Suggest edits, fix issues, and produce a final polished version. Post the final version to shared files.",
        cronExpression: "0 9 * * 1",
      },
    ],
  },
  {
    id: "bug-triage-fix-verify",
    name: "Bug Triage → Fix → Verify",
    description: "Triages incoming bugs, assigns to the right agent, fixes, and verifies the solution.",
    category: "Engineering",
    icon: "🐛",
    roles: ["triager", "fixer", "verifier"],
    steps: [
      {
        role: "triager",
        name: "Triage",
        task: "Review the task board for bug-related cards. Prioritize them by severity and impact. For each bug, write a clear reproduction steps summary and assign it to the fixer agent.",
        cronExpression: "*/30 * * * *",
      },
      {
        role: "fixer",
        name: "Fix",
        task: "Take the triaged bug report and implement a fix. Write clean, minimal code changes. Document what was changed and why in the task card.",
        cronExpression: "*/30 * * * *",
      },
      {
        role: "verifier",
        name: "Verify",
        task: "Verify the fix by reviewing the code changes and testing the reproduction steps. Mark the bug as resolved or send it back for rework with specific feedback.",
        cronExpression: "*/30 * * * *",
      },
    ],
  },
  {
    id: "inbox-monitor-respond",
    name: "Inbox Monitor → Respond",
    description: "Monitors incoming messages, drafts responses, and sends replies. Runs every 15 minutes.",
    category: "Communication",
    icon: "📬",
    roles: ["monitor", "responder"],
    steps: [
      {
        role: "monitor",
        name: "Check Inbox",
        task: "Read all unread messages from connected platforms. Categorize them by urgency (high/medium/low) and summarize the key points that need responses.",
        cronExpression: "*/15 * * * *",
      },
      {
        role: "responder",
        name: "Respond",
        task: "Using the categorized inbox summary, draft and send appropriate responses to each message. For high-urgency items, respond immediately. For others, batch responses efficiently.",
        cronExpression: "*/15 * * * *",
      },
    ],
  },
  {
    id: "data-collect-analyze-report",
    name: "Collect → Analyze → Report",
    description: "Collects data from connected tools, analyzes trends, and generates a weekly report.",
    category: "Analytics",
    icon: "📊",
    roles: ["collector", "analyst", "reporter"],
    steps: [
      {
        role: "collector",
        name: "Collect Data",
        task: "Gather data from all connected MCP servers and tools. Pull metrics, logs, and any available analytics. Organize the raw data into a structured format for analysis.",
        cronExpression: "0 9 * * 1",
      },
      {
        role: "analyst",
        name: "Analyze",
        task: "Analyze the collected data for trends, anomalies, and key insights. Identify top performers, bottlenecks, and areas for improvement. Create visual summaries where possible.",
        cronExpression: "0 9 * * 1",
      },
      {
        role: "reporter",
        name: "Generate Report",
        task: "Using the analysis, create a polished weekly report with key findings, recommendations, and action items. Post the report to shared files and summarize in the office feed.",
        cronExpression: "0 9 * * 1",
      },
    ],
  },
  {
    id: "deploy-monitor-alert",
    name: "Deploy → Monitor → Alert",
    description: "Deploys changes, monitors for issues, and alerts the team if problems arise.",
    category: "DevOps",
    icon: "🚀",
    roles: ["deployer", "monitor"],
    steps: [
      {
        role: "deployer",
        name: "Deploy",
        task: "Review pending changes and deploy them following the deployment checklist. Verify the deployment succeeded and document what was deployed.",
        cronExpression: "0 */6 * * *",
      },
      {
        role: "monitor",
        name: "Monitor & Alert",
        task: "After deployment, monitor system health for 15 minutes. Check error rates, response times, and key metrics. If issues are detected, alert the team immediately with details.",
        cronExpression: "0 */6 * * *",
      },
    ],
  },
];

/** Get a template by ID. */
export function getTemplateById(id: string): PipelineTemplate | undefined {
  return PIPELINE_TEMPLATES.find((t) => t.id === id);
}
