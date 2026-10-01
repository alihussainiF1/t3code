import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  McpConnectorConfig,
  type McpConnectorHttpAuth,
  type McpConnectorKeyValue,
} from "./mcpConnector.ts";

/**
 * The connector catalog: ready-made MCP servers the user adds with one
 * click. Built-in entries are curated below; registry entries come from the
 * official MCP Registry through the server and are community-published.
 */

/** Where a value the user types goes in the connector. */
export const McpCatalogFieldTarget = Schema.Union([
  /** The bearer token of an HTTP connector. */
  Schema.Struct({ type: Schema.Literal("bearer") }),
  /** A stdio environment variable. */
  Schema.Struct({ type: Schema.Literal("env"), name: TrimmedNonEmptyString }),
  /** An HTTP header; `format` wraps the value, e.g. "Bearer {value}". */
  Schema.Struct({
    type: Schema.Literal("header"),
    name: TrimmedNonEmptyString,
    format: Schema.optionalKey(Schema.String),
  }),
  /** Appended to the stdio command's arguments, after `name` when set (e.g. "--port"). */
  Schema.Struct({ type: Schema.Literal("arg"), name: Schema.optionalKey(TrimmedNonEmptyString) }),
]);
export type McpCatalogFieldTarget = typeof McpCatalogFieldTarget.Type;

export const McpCatalogField = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: Schema.optionalKey(Schema.String),
  placeholder: Schema.optionalKey(Schema.String),
  secret: Schema.Boolean,
  required: Schema.Boolean,
  /** Prefilled value the user may keep. */
  defaultValue: Schema.optionalKey(Schema.String),
  target: McpCatalogFieldTarget,
});
export type McpCatalogField = typeof McpCatalogField.Type;

export const McpCatalogEntry = Schema.Struct({
  /** `builtin:<slug>` or `registry:<server name>`. */
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.String,
  source: Schema.Literals(["built-in", "registry"]),
  /** Domain whose icon represents the entry; the server fetches it. */
  iconDomain: Schema.optionalKey(Schema.String),
  /** Page with the server's own documentation. */
  docsUrl: Schema.optionalKey(Schema.String),
  /** Where to create the token a token-based entry asks for. */
  tokenUrl: Schema.optionalKey(Schema.String),
  /** Launcher a local entry needs on the environment's PATH. */
  runtime: Schema.optionalKey(Schema.Literals(["npx", "uvx", "docker"])),
  /** The connector to create; fields fill in its blanks. */
  connector: McpConnectorConfig,
  fields: Schema.Array(McpCatalogField).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type McpCatalogEntry = typeof McpCatalogEntry.Type;

export const McpRegistrySearchInput = Schema.Struct({
  query: Schema.String,
  cursor: Schema.optionalKey(Schema.String),
});
export type McpRegistrySearchInput = typeof McpRegistrySearchInput.Type;

export const McpRegistrySearchResult = Schema.Struct({
  entries: Schema.Array(McpCatalogEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type McpRegistrySearchResult = typeof McpRegistrySearchResult.Type;

/**
 * The connector an entry creates once the user filled its fields. Blank
 * optional fields are left out. Returns the label of the first required
 * field that is still blank instead when one is.
 */
export function applyMcpCatalogFields(
  entry: McpCatalogEntry,
  values: Readonly<Record<string, string>>,
):
  | { readonly ok: true; readonly config: McpConnectorConfig }
  | { readonly ok: false; readonly missing: string } {
  const headers: McpConnectorKeyValue[] = [];
  const env: McpConnectorKeyValue[] = [];
  const args: string[] = [];
  let token: string | undefined;
  for (const field of entry.fields) {
    const value = (values[field.id] ?? field.defaultValue ?? "").trim();
    if (value.length === 0) {
      if (field.required) return { ok: false, missing: field.label };
      continue;
    }
    const target = field.target;
    if (target.type === "bearer") token = value;
    else if (target.type === "header") {
      headers.push({
        name: target.name,
        value: target.format ? target.format.replaceAll("{value}", value) : value,
        secret: field.secret,
      });
    } else if (target.type === "env") env.push({ name: target.name, value, secret: field.secret });
    else args.push(...(target.name ? [target.name, value] : [value]));
  }
  const transport = entry.connector.transport;
  return {
    ok: true,
    config: {
      ...entry.connector,
      transport:
        transport.type === "http"
          ? {
              ...transport,
              headers: [...transport.headers, ...headers],
              auth: token === undefined ? transport.auth : { type: "bearer", token },
            }
          : {
              ...transport,
              args: [...transport.args, ...args],
              env: [...transport.env, ...env],
            },
    },
  };
}

// ── Built-in catalog ────────────────────────────────────────────────────

/**
 * Date every built-in endpoint was last checked. Remote OAuth entries
 * answered an unauthenticated MCP initialize with 401 and a Bearer
 * challenge, published OAuth metadata, and accepted a dynamic client
 * registration for a localhost redirect. Open entries answered initialize
 * with 200. Token entries answered with a Bearer challenge. Local entries'
 * packages resolved on npm or PyPI. Re-verify when editing the list.
 */
export const MCP_CATALOG_VERIFIED_AT = "2026-10-01";

const remote = (
  slug: string,
  name: string,
  description: string,
  url: string,
  iconDomain: string,
  auth: McpConnectorHttpAuth = { type: "oauth", scopes: "", clientId: "", connectedAt: null },
  extra: Partial<Pick<McpCatalogEntry, "docsUrl" | "tokenUrl" | "fields">> = {},
): McpCatalogEntry => ({
  id: `builtin:${slug}`,
  name,
  description,
  source: "built-in",
  iconDomain,
  connector: {
    name,
    enabled: true,
    catalogId: `builtin:${slug}`,
    transport: { type: "http", url, headers: [], auth },
  },
  fields: extra.fields ?? [],
  ...(extra.docsUrl ? { docsUrl: extra.docsUrl } : {}),
  ...(extra.tokenUrl ? { tokenUrl: extra.tokenUrl } : {}),
});

const open = { type: "none" } as const;
const token = { type: "bearer", token: "" } as const;
const tokenField = (label: string, description: string): McpCatalogField => ({
  id: "token",
  label,
  description,
  secret: true,
  required: true,
  target: { type: "bearer" },
});

const local = (
  slug: string,
  name: string,
  description: string,
  runtime: "npx" | "uvx",
  args: ReadonlyArray<string>,
  iconDomain: string,
  fields: ReadonlyArray<McpCatalogField> = [],
): McpCatalogEntry => ({
  id: `builtin:${slug}`,
  name,
  description,
  source: "built-in",
  iconDomain,
  runtime,
  connector: {
    name,
    enabled: true,
    catalogId: `builtin:${slug}`,
    transport: {
      type: "stdio",
      command: runtime,
      args: runtime === "npx" ? ["-y", ...args] : [...args],
      env: [],
    },
  },
  fields,
});

export const BUILT_IN_MCP_CATALOG: ReadonlyArray<McpCatalogEntry> = [
  // Remote, OAuth with dynamic client registration: one click and a browser sign-in.
  remote(
    "linear",
    "Linear",
    "Issues, projects, and cycles",
    "https://mcp.linear.app/mcp",
    "linear.app",
  ),
  remote(
    "notion",
    "Notion",
    "Pages, databases, and search",
    "https://mcp.notion.com/mcp",
    "notion.so",
  ),
  remote(
    "sentry",
    "Sentry",
    "Errors, issues, and releases",
    "https://mcp.sentry.dev/mcp",
    "sentry.io",
  ),
  remote(
    "atlassian",
    "Atlassian",
    "Jira issues and Confluence pages",
    "https://mcp.atlassian.com/v1/mcp",
    "atlassian.com",
  ),
  remote(
    "stripe",
    "Stripe",
    "Payments, customers, and docs",
    "https://mcp.stripe.com",
    "stripe.com",
  ),
  remote(
    "vercel",
    "Vercel",
    "Projects, deployments, and logs",
    "https://mcp.vercel.com",
    "vercel.com",
  ),
  remote(
    "supabase",
    "Supabase",
    "Databases, migrations, and edge functions",
    "https://mcp.supabase.com/mcp",
    "supabase.com",
  ),
  remote(
    "neon",
    "Neon",
    "Serverless Postgres projects and branches",
    "https://mcp.neon.tech/mcp",
    "neon.tech",
  ),
  remote(
    "prisma",
    "Prisma Postgres",
    "Databases and schema migrations",
    "https://mcp.prisma.io/mcp",
    "prisma.io",
  ),
  remote(
    "netlify",
    "Netlify",
    "Sites, deploys, and forms",
    "https://netlify-mcp.netlify.app/mcp",
    "netlify.com",
  ),
  remote(
    "cloudflare-bindings",
    "Cloudflare Workers",
    "Workers, KV, R2, and D1",
    "https://bindings.mcp.cloudflare.com/mcp",
    "cloudflare.com",
  ),
  remote(
    "cloudflare-observability",
    "Cloudflare Observability",
    "Worker logs and analytics",
    "https://observability.mcp.cloudflare.com/mcp",
    "cloudflare.com",
  ),
  remote(
    "huggingface",
    "Hugging Face",
    "Models, datasets, Spaces, and papers",
    "https://huggingface.co/mcp",
    "huggingface.co",
  ),
  remote(
    "posthog",
    "PostHog",
    "Product analytics, flags, and errors",
    "https://mcp.posthog.com/mcp",
    "posthog.com",
  ),
  remote(
    "semgrep",
    "Semgrep",
    "Static analysis and security scans",
    "https://mcp.semgrep.ai/mcp",
    "semgrep.dev",
  ),
  remote(
    "jam",
    "Jam",
    "Bug reports with console and network logs",
    "https://mcp.jam.dev/mcp",
    "jam.dev",
  ),
  remote("miro", "Miro", "Boards, diagrams, and sticky notes", "https://mcp.miro.com/", "miro.com"),
  remote(
    "canva",
    "Canva",
    "Designs, folders, and brand templates",
    "https://mcp.canva.com/mcp",
    "canva.com",
  ),
  remote(
    "webflow",
    "Webflow",
    "Sites, CMS collections, and pages",
    "https://mcp.webflow.com/mcp",
    "webflow.com",
  ),
  remote("wix", "Wix", "Sites, stores, and bookings", "https://mcp.wix.com/mcp", "wix.com"),
  remote(
    "airtable",
    "Airtable",
    "Bases, tables, and records",
    "https://mcp.airtable.com/mcp",
    "airtable.com",
  ),
  remote(
    "monday",
    "monday.com",
    "Boards, items, and updates",
    "https://mcp.monday.com/mcp",
    "monday.com",
  ),
  remote(
    "clickup",
    "ClickUp",
    "Tasks, docs, and spaces",
    "https://mcp.clickup.com/mcp",
    "clickup.com",
  ),
  remote("todoist", "Todoist", "Tasks and projects", "https://ai.todoist.net/mcp", "todoist.com"),
  remote(
    "granola",
    "Granola",
    "Meeting notes and transcripts",
    "https://mcp.granola.ai/mcp",
    "granola.ai",
  ),
  remote(
    "attio",
    "Attio",
    "CRM records, lists, and notes",
    "https://mcp.attio.com/mcp",
    "attio.com",
  ),
  remote(
    "intercom",
    "Intercom",
    "Conversations, contacts, and tickets",
    "https://mcp.intercom.com/mcp",
    "intercom.com",
  ),
  remote(
    "vanta",
    "Vanta",
    "Compliance controls, tests, and vendors",
    "https://mcp.vanta.com/mcp",
    "vanta.com",
  ),
  remote(
    "paypal",
    "PayPal",
    "Invoices, orders, and transactions",
    "https://mcp.paypal.com/mcp",
    "paypal.com",
  ),
  remote(
    "square",
    "Square",
    "Payments, catalog, and orders",
    "https://mcp.squareup.com/mcp",
    "squareup.com",
  ),
  remote(
    "zapier",
    "Zapier",
    "Actions across thousands of apps",
    "https://mcp.zapier.com/api/mcp/mcp",
    "zapier.com",
  ),
  remote(
    "pipedream",
    "Pipedream",
    "Actions across thousands of APIs",
    "https://mcp.pipedream.net/v2",
    "pipedream.com",
  ),
  // Remote, no sign-in needed.
  remote(
    "context7",
    "Context7",
    "Up-to-date library documentation",
    "https://mcp.context7.com/mcp",
    "context7.com",
    open,
  ),
  remote(
    "deepwiki",
    "DeepWiki",
    "Ask questions about public GitHub repos",
    "https://mcp.deepwiki.com/mcp",
    "deepwiki.com",
    open,
  ),
  remote("exa", "Exa", "Web search and code context", "https://mcp.exa.ai/mcp", "exa.ai", open),
  remote(
    "cloudflare-docs",
    "Cloudflare Docs",
    "Cloudflare developer documentation",
    "https://docs.mcp.cloudflare.com/mcp",
    "cloudflare.com",
    open,
  ),
  // Remote, token instead of OAuth (no dynamic client registration).
  remote(
    "github",
    "GitHub",
    "Repos, issues, pull requests, and Actions",
    "https://api.githubcopilot.com/mcp/",
    "github.com",
    token,
    {
      tokenUrl: "https://github.com/settings/personal-access-tokens/new",
      fields: [
        tokenField(
          "Personal access token",
          "Create a fine-grained token with read and write access to Contents, Issues, and Pull requests (Metadata is read-only) for the repositories agents should use.",
        ),
      ],
    },
  ),
  remote(
    "render",
    "Render",
    "Services, deploys, logs, and Postgres",
    "https://mcp.render.com/mcp",
    "render.com",
    token,
    {
      tokenUrl: "https://dashboard.render.com/u/settings#api-keys",
      fields: [tokenField("API key", "Create an API key under Account Settings > API Keys.")],
    },
  ),
  remote(
    "apify",
    "Apify",
    "Web scrapers and automation actors",
    "https://mcp.apify.com",
    "apify.com",
    token,
    {
      tokenUrl: "https://console.apify.com/settings/integrations",
      fields: [
        tokenField("API token", "Copy your personal API token from Settings > API & Integrations."),
      ],
    },
  ),
  // Local servers run on the environment through npx or uvx.
  local(
    "playwright",
    "Playwright",
    "Drive a browser: navigate, click, and snapshot pages",
    "npx",
    ["@playwright/mcp@latest"],
    "playwright.dev",
  ),
  local(
    "chrome-devtools",
    "Chrome DevTools",
    "Inspect, debug, and profile pages in Chrome",
    "npx",
    ["chrome-devtools-mcp@latest"],
    "developer.chrome.com",
  ),
  local(
    "context7-local",
    "Context7 (local)",
    "Library documentation, run on this machine",
    "npx",
    ["@upstash/context7-mcp@latest"],
    "context7.com",
  ),
  local(
    "filesystem",
    "Filesystem",
    "Read and write files in one directory",
    "npx",
    ["@modelcontextprotocol/server-filesystem"],
    "modelcontextprotocol.io",
    [
      {
        id: "directory",
        label: "Directory",
        description: "Absolute path of the directory the server may access.",
        placeholder: "/home/me/projects",
        secret: false,
        required: true,
        target: { type: "arg" },
      },
    ],
  ),
  local(
    "memory",
    "Memory",
    "A persistent knowledge graph agents can recall",
    "npx",
    ["@modelcontextprotocol/server-memory"],
    "modelcontextprotocol.io",
  ),
  local(
    "sequential-thinking",
    "Sequential Thinking",
    "Step-by-step problem solving",
    "npx",
    ["@modelcontextprotocol/server-sequential-thinking"],
    "modelcontextprotocol.io",
  ),
  local(
    "fetch",
    "Fetch",
    "Fetch web pages as markdown",
    "uvx",
    ["mcp-server-fetch"],
    "modelcontextprotocol.io",
  ),
  local("git", "Git", "Read and search Git repositories", "uvx", ["mcp-server-git"], "git-scm.com"),
  local(
    "time",
    "Time",
    "Current time and timezone conversion",
    "uvx",
    ["mcp-server-time"],
    "modelcontextprotocol.io",
  ),
];
