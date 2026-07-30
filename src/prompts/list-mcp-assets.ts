/**
 * MCP Prompt definition for listing server capabilities.
 *
 * The resource tables are generated from the static resource registry rather
 * than hand-written, so trimming the registry cannot leave this prompt
 * advertising a resource the server does not serve.
 */

import {
  STATIC_RESOURCES,
  RESOURCE_TEMPLATES,
} from "../resources/static-registry.js";

// Inline the interleaved thinking description to avoid circular import
const INTERLEAVED_THINKING_DESCRIPTION =
  "Use this server as a reasoning workspace to alternate between internal reasoning steps and external tool/action invocation";

export const LIST_MCP_ASSETS_PROMPT = {
  name: "list_mcp_assets",
  title: "list_mcp_assets",
  description:
    "Overview of all MCP capabilities, tools, resources, and quickstart guide",
  arguments: [],
};

/**
 * Generates the list_mcp_assets prompt content dynamically
 */
export function getListMcpAssetsContent(): string {
  const staticResourceRows = STATIC_RESOURCES.map(
    (r) => `| \`${r.uri}\` | ${r.description} |`
  ).join("\n");

  const templateRows = RESOURCE_TEMPLATES.map(
    (t) => `| \`${t.uriTemplate}\` | ${t.description} |`
  ).join("\n");

  return `# Claude Teams Hub MCP Server - Capabilities

## Overview

**Package:** \`@kastalien-research/claude-teams-hub\`

Claude Teams Hub is a multi-agent collaboration surface for Claude Agent Teams:
workspaces, problems, proposals, consensus, and channels, plus a transitional
thought/session ledger. Storage is filesystem-only — no database, no auth, no
telemetry.

---

## Public Tools

### 1. \`thoughtbox_search\` — Catalog Search

Discover operation modules, prompts, resources, and public tool surfaces by
querying the server catalog with JavaScript.

### 2. \`thoughtbox_execute\` — Code Mode Operation Runner

Run JavaScript against the \`tb\` SDK. One call can chain many operations;
only what you return or log comes back, so multi-step coordination costs a
single round-trip.

**\`tb\` namespaces:**

| Namespace | Purpose |
|-----------|---------|
| \`tb.hub\` | Workspaces, problems, proposals, consensus, channels, agent identity and attribution |
| \`tb.thought\` | Append, revise, and branch reasoning steps in the thought ledger |
| \`tb.session\` | Create, query, complete, and export reasoning sessions |
| \`tb.vars\` | Durable named variables within one MCP session (in-memory; lost when the session ends) |

---

## Prompts

| Prompt | Description |
|--------|-------------|
| \`list_mcp_assets\` | This prompt - overview of all capabilities |
| \`interleaved-thinking\` | ${INTERLEAVED_THINKING_DESCRIPTION} |
| \`parallel-verification\` | Parallel hypothesis exploration across reasoning branches |

---

## Resources

### Static Resources

| URI | Description |
|-----|-------------|
${staticResourceRows}

### Resource Templates

| URI Template | Description |
|--------------|-------------|
${templateRows}

---

## Quick Start

\`\`\`javascript
// Discover operations and public tool surfaces
thoughtbox_search({
  code: "async () => ({ modules: Object.keys(catalog.operations), publicTools: catalog.publicTools })"
})

// Start a reasoning session through Code Mode
thoughtbox_execute({
  code: "async () => tb.thought({ thought: 'Breaking down the problem into key decision areas...', thoughtType: 'reasoning', thoughtNumber: 1, totalThoughts: 10, nextThoughtNeeded: true, sessionTitle: 'Architecture Decision', sessionTags: ['architecture', 'planning'] })"
})

// Join the hub, then open a shared problem — one round-trip
thoughtbox_execute({
  code: \`async () => {
    await tb.hub.register({ name: 'Architect Agent', profile: 'ARCHITECT' });
    const ws = await tb.hub.createWorkspace({
      name: 'Queue backend',
      description: 'Choosing durable storage for the dispatch queue.'
    });
    return tb.hub.createProblem({
      workspaceId: ws.id,
      title: 'Pick a queue backend',
      description: 'Compare durability and operational cost.'
    });
  }\`
})
\`\`\`

---

## Summary Statistics

- **Public Tools:** 2 (thoughtbox_search, thoughtbox_execute)
- **Prompts:** 3
- **Static Resources:** ${STATIC_RESOURCES.length}
- **Resource Templates:** ${RESOURCE_TEMPLATES.length}

`;
}
