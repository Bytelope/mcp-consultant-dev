import { z } from "zod";

const API_BASE_URL = "https://consultant.dev/api";

interface Assignment {
  id: string;
  title: string;
  url: string;
  company?: string;
  location?: string;
  description?: string;
  posted?: string;
  deadline?: string;
  source?: string;
  role?: string;
  role_category?: string;
  seniority_level?: string;
  employment_type?: string;
  skills?: string[];
  quality_score?: number;
  location_hierarchy?: { type: string; name: string }[];
  country_codes?: string[];
  easy_apply?: { enabled: boolean; url?: string };
  company_name?: string;
  hourly_rate?: number;
  duration?: string;
  start_date?: string;
  end_date?: string;
  languages?: string[];
  security_clearance?: boolean;
}

interface SearchResponse {
  success: boolean;
  results: Assignment[];
  facets: {
    roles: { value: string; count: number }[];
    locations: { value: string; count: number }[];
    sources: { value: string; count: number }[];
    seniority_levels: { value: string; count: number }[];
    employment_types: { value: string; count: number }[];
    languages: { value: string; count: number }[];
    companies: { value: string; count: number }[];
  };
}

// Compact JSON helper - removes null/undefined values and outputs without whitespace
function compact(obj: unknown): string {
  return JSON.stringify(obj, (_, v) => (v === null || v === undefined ? undefined : v));
}

// API helper
async function fetchAPI(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${API_BASE_URL}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value) url.searchParams.append(key, value);
  });

  const response = await fetch(url.toString(), {
    headers: { "User-Agent": "MCP-Consultant-Jobs/1.0", Accept: "application/json" },
  });

  if (!response.ok) throw new Error(`API error: ${response.status}`);
  return response.json();
}

// Location coordinates cache for geo-filtering
let locationCoords: Record<string, { lat: number; lon: number }> = {};
let coordsLoaded = false;

async function loadLocationCoords(): Promise<void> {
  if (coordsLoaded) return;

  try {
    const resp = await fetch("https://consultant.dev/data/location-coordinates.json");
    const data = await resp.json() as {
      län?: Record<string, { name: string; lat: number; lon: number }>;
      kommuner?: Record<string, { name: string; lat: number; lon: number }>;
      cities?: Record<string, { lat: number; lon: number }>;
    };

    // Build lookup from län (counties)
    for (const [, info] of Object.entries(data.län || {})) {
      const name = info.name.toLowerCase();
      locationCoords[name] = { lat: info.lat, lon: info.lon };
      // Also add without "s län" suffix for easier matching
      const shortName = name.replace(/s län$/, "").replace(/ län$/, "");
      if (shortName !== name) {
        locationCoords[shortName] = { lat: info.lat, lon: info.lon };
      }
    }

    // Build lookup from kommuner (municipalities)
    for (const [, info] of Object.entries(data.kommuner || {})) {
      const name = info.name.toLowerCase();
      locationCoords[name] = { lat: info.lat, lon: info.lon };
    }

    // Build lookup from cities
    for (const [name, info] of Object.entries(data.cities || {})) {
      locationCoords[name.toLowerCase()] = { lat: info.lat, lon: info.lon };
    }

    coordsLoaded = true;
  } catch (e) {
    console.error("Failed to load location coordinates:", e);
  }
}

// Tool schemas
const SearchArgsSchema = z.object({
  query: z.string().optional(),
  sort: z.enum(["quality", "posted", "deadline"]).optional().default("quality"),
  page: z.number().int().min(1).optional().default(1),
  limit: z.number().int().min(1).max(20).optional().default(10),
  role: z.string().optional(),
  location: z.string().optional(),
  geo_lat: z.number().optional(),
  geo_lon: z.number().optional(),
  geo_radius: z.number().optional(),
  seniority: z.enum(["junior", "regular", "senior", "lead"]).optional(),
  employment_type: z.string().optional(),
  skills: z.array(z.string()).optional(),
});

const GetAssignmentArgsSchema = z.object({ id: z.string() });
const GetRecentArgsSchema = z.object({
  limit: z.number().int().min(1).max(20).optional().default(10),
});

// Tool definitions
const TOOLS = [
  // ChatGPT-compatible tools (required for ChatGPT Connectors/Deep Research)
  {
    name: "search",
    description: "Search for IT consultant jobs, freelance assignments, and contract work in the Nordic region. Returns a list of matching job postings.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'Python developer Stockholm', 'DevOps remote')" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description: "Get full details of a specific job posting by its ID, including complete description and how to apply.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: { type: "string", description: "The job ID to fetch" },
      },
      required: ["id"],
    },
  },
  // Extended tools for other MCP clients (Claude, etc.)
  {
    name: "search_assignments",
    description: "Search for IT consultant jobs in Sweden. Location names like 'Stockholm', 'Göteborg', 'Malmö' are automatically resolved to coordinates for precise filtering within 50km radius. Use this when users ask to find jobs, look for work, search for assignments, or want employment opportunities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query for job title, description, or skills (e.g., 'backend developer', 'data engineer')" },
        sort: { type: "string", enum: ["quality", "posted", "deadline"], default: "quality", description: "Sort by: quality (relevance), posted (newest), deadline (soonest)" },
        page: { type: "number", minimum: 1, default: 1 },
        limit: { type: "number", minimum: 1, maximum: 20, default: 10 },
        role: { type: "string", description: "Filter by job role (e.g., 'Backend Developer', 'Data Engineer', 'DevOps Engineer')" },
        location: { type: "string", description: "City or region name (e.g., 'Stockholm', 'Göteborg', 'Malmö', 'Remote'). Auto-resolved to geo-coordinates for precise 50km radius filtering." },
        geo_lat: { type: "number", description: "Latitude for geo-filtering (overrides location)" },
        geo_lon: { type: "number", description: "Longitude for geo-filtering (overrides location)" },
        geo_radius: { type: "number", description: "Search radius in km (default: 50)" },
        seniority: { type: "string", enum: ["junior", "regular", "senior", "lead"], description: "Filter by experience level" },
        employment_type: { type: "string", description: "Filter by employment type (e.g., 'contractor', 'freelance')" },
        skills: { type: "array", items: { type: "string" }, description: "Filter by required skills (e.g., ['Python', 'AWS', 'Kubernetes'])" },
      },
    },
  },
  {
    name: "get_assignment",
    description: "Get full details of a specific job or assignment by its ID, including complete description, requirements, and application information.",
    inputSchema: {
      type: "object" as const,
      properties: { id: { type: "string", description: "The job/assignment ID" } },
      required: ["id"],
    },
  },
  {
    name: "get_available_filters",
    description: "Get available filter options for job searches, including lists of roles, locations, seniority levels, employment types, and companies with job counts. Useful for discovering what jobs are available before searching.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "get_recent_assignments",
    description: "Get the most recently posted jobs and assignments. Use this when users want to see new job postings, latest opportunities, or fresh listings.",
    inputSchema: {
      type: "object" as const,
      properties: { limit: { type: "number", minimum: 1, maximum: 20, default: 10, description: "Number of recent jobs to return" } },
    },
  },
];

// ChatGPT-compatible tool handlers (search/fetch with OpenAI's expected format)
const ChatGPTSearchArgsSchema = z.object({ query: z.string() });
const ChatGPTFetchArgsSchema = z.object({ id: z.string() });

async function handleChatGPTSearch(args: z.infer<typeof ChatGPTSearchArgsSchema>) {
  const data = (await fetchAPI("/search", { q: args.query, limit: "10" })) as SearchResponse;
  if (!data.success || !data.results?.length) {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ results: [] }),
      }],
    };
  }

  // OpenAI expects: { results: [{ id, title, url }] }
  const results = data.results.map((a) => ({
    id: a.id,
    title: `${a.title} at ${a.company} - ${a.location}`,
    url: a.url || `https://consultant.dev/assignments/${a.id}`,
  }));

  return {
    content: [{ type: "text" as const, text: JSON.stringify({ results }) }],
  };
}

async function handleChatGPTFetch(args: z.infer<typeof ChatGPTFetchArgsSchema>) {
  try {
    const data = (await fetchAPI(`/job/${args.id}`)) as { job?: Assignment };
    if (!data.job) {
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ id: args.id, title: "Not found", text: "Job not found", url: "" }),
        }],
      };
    }
    const a = data.job;
    // OpenAI expects: { id, title, text, url, metadata }
    const result = {
      id: a.id,
      title: `${a.title} at ${a.company}`,
      text: `${a.title}\n\nCompany: ${a.company}\nLocation: ${a.location}\nRole: ${a.role || "N/A"}\nSeniority: ${a.seniority_level || "N/A"}\nPosted: ${a.posted?.split("T")[0] || "N/A"}\nDeadline: ${a.deadline?.split("T")[0] || "N/A"}\nSkills: ${a.skills?.join(", ") || "N/A"}\n\n${a.description || "No description available."}`,
      url: a.url || `https://consultant.dev/assignments/${a.id}`,
      metadata: {
        company: a.company,
        location: a.location,
        role: a.role,
        seniority: a.seniority_level,
        posted: a.posted?.split("T")[0],
        source: a.source,
      },
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  } catch {
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ id: args.id, title: "Error", text: "Failed to fetch job", url: "" }),
      }],
    };
  }
}

// Extended tool handlers (for Claude and other MCP clients)
async function handleSearchAssignments(args: z.infer<typeof SearchArgsSchema>) {
  // Ensure coordinates are loaded for geo-filtering
  await loadLocationCoords();

  const params: Record<string, string> = {
    sort: args.sort || "quality",
    page: String(args.page || 1),
    limit: String(args.limit || 10),
  };

  // Handle geo-coordinates
  if (args.geo_lat && args.geo_lon) {
    // Use explicit coordinates provided by user
    params.geo_lat = String(args.geo_lat);
    params.geo_lon = String(args.geo_lon);
    params.geo_radius = String(args.geo_radius || 50);
  } else if (args.location) {
    const normalized = args.location.toLowerCase().trim();
    // Check if it's "remote" or similar - pass through as string
    if (normalized === "remote" || normalized === "distans") {
      params.location = args.location;
    } else {
      // Try to resolve location name to coordinates
      const coords = locationCoords[normalized];
      if (coords) {
        params.geo_lat = String(coords.lat);
        params.geo_lon = String(coords.lon);
        params.geo_radius = String(args.geo_radius || 50);
      } else {
        // Fallback to string location for unknown places
        params.location = args.location;
      }
    }
  }

  if (args.query) params.q = args.query;
  if (args.role) params.role = args.role;
  if (args.seniority) params.seniority = args.seniority;
  if (args.employment_type) params.employment_type = args.employment_type;
  if (args.skills?.length) params.skills = args.skills.join(",");

  const data = (await fetchAPI("/search", params)) as SearchResponse;
  if (!data.success) return { content: [{ type: "text" as const, text: "Search failed." }] };

  if (!data.results?.length) {
    return {
      content: [{
        type: "text" as const,
        text: "No exact matches found. Try expanding your location, broadening your search query, or lowering seniority level. Visit https://consultant.dev/alerts to get notified when matching roles appear.",
      }],
    };
  }

  const results = data.results.map((a) => ({
    id: a.id,
    title: a.title,
    company: a.company,
    location: a.location,
    posted: a.posted?.split("T")[0],
    deadline: a.deadline?.split("T")[0],
    skills: a.skills?.slice(0, 5),
  }));

  return {
    content: [{ type: "text" as const, text: compact({ total: results.length, page: args.page || 1, results }) }],
  };
}

async function handleGetAssignment(args: z.infer<typeof GetAssignmentArgsSchema>) {
  try {
    const data = (await fetchAPI(`/job/${args.id}`)) as { job?: Assignment; similarJobs?: Assignment[] };
    if (!data.job) {
      return { content: [{ type: "text" as const, text: `Assignment '${args.id}' not found.` }] };
    }
    const a = data.job;
    const result = {
      id: a.id,
      title: a.title,
      company: a.company,
      location: a.location,
      description: a.description,
      url: a.url,
      posted: a.posted?.split("T")[0],
      deadline: a.deadline?.split("T")[0],
      role: a.role,
      seniority_level: a.seniority_level,
      employment_type: a.employment_type,
      skills: a.skills,
    };
    return { content: [{ type: "text" as const, text: compact(result) }] };
  } catch {
    return { content: [{ type: "text" as const, text: `Assignment '${args.id}' not found.` }] };
  }
}

async function handleGetAvailableFilters() {
  const data = (await fetchAPI("/search", { limit: "1" })) as SearchResponse;
  if (!data.success) return { content: [{ type: "text" as const, text: "Failed to fetch filters." }] };
  // Return top 10 of each facet to keep response small
  const filters = {
    roles: data.facets.roles?.slice(0, 10),
    locations: data.facets.locations?.slice(0, 10),
    seniority_levels: data.facets.seniority_levels,
    employment_types: data.facets.employment_types,
    companies: data.facets.companies?.slice(0, 10),
  };
  return { content: [{ type: "text" as const, text: compact(filters) }] };
}

async function handleGetRecentAssignments(args: z.infer<typeof GetRecentArgsSchema>) {
  const data = (await fetchAPI("/search", { sort: "posted", limit: String(args.limit || 10) })) as SearchResponse;
  if (!data.success) return { content: [{ type: "text" as const, text: "Failed to fetch recent assignments." }] };

  const results = data.results.map((a) => ({
    id: a.id,
    title: a.title,
    company: a.company,
    location: a.location,
    posted: a.posted?.split("T")[0],
    skills: a.skills?.slice(0, 5),
  }));

  return { content: [{ type: "text" as const, text: compact({ results }) }] };
}

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, mcp-session-id",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

// Simple in-memory session tracking (for protocol compliance)
const activeSessions = new Set<string>();

// Handle JSON-RPC requests (stateless - Streamable HTTP transport style)
async function handleJsonRpc(sessionId: string | null, request: any): Promise<any> {
  const { id, method, params } = request;

  try {
    switch (method) {
      case "initialize":
        // Generate session ID if not provided
        const newSessionId = sessionId || crypto.randomUUID();
        activeSessions.add(newSessionId);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "consultant-jobs", version: "1.0.0" },
          },
          _sessionId: newSessionId,
        };

      case "notifications/initialized":
        return null; // No response for notifications

      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

      case "tools/call": {
        const { name, arguments: args } = params;
        let result;

        switch (name) {
          // ChatGPT-compatible tools
          case "search":
            result = await handleChatGPTSearch(ChatGPTSearchArgsSchema.parse(args));
            break;
          case "fetch":
            result = await handleChatGPTFetch(ChatGPTFetchArgsSchema.parse(args));
            break;
          // Extended tools
          case "search_assignments":
            result = await handleSearchAssignments(SearchArgsSchema.parse(args || {}));
            break;
          case "get_assignment":
            result = await handleGetAssignment(GetAssignmentArgsSchema.parse(args));
            break;
          case "get_available_filters":
            result = await handleGetAvailableFilters();
            break;
          case "get_recent_assignments":
            result = await handleGetRecentAssignments(GetRecentArgsSchema.parse(args || {}));
            break;
          default:
            return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } };
        }

        return { jsonrpc: "2.0", id, result };
      }

      case "ping":
        return { jsonrpc: "2.0", id, result: {} };

      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
    }
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
    };
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/health") {
      return Response.json(
        { status: "healthy", server: "consultant-jobs", version: "1.0.0", tools: TOOLS.map((t) => t.name) },
        { headers: corsHeaders }
      );
    }

    // MCP endpoint - Streamable HTTP transport (stateless JSON-RPC over HTTP)
    if (url.pathname === "/mcp" && request.method === "POST") {
      const sessionId = request.headers.get("mcp-session-id");

      try {
        const body = await request.json();
        const response = await handleJsonRpc(sessionId, body);

        if (response === null) {
          // Notification - no response body
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Extract session ID if set during initialize
        const responseSessionId = response._sessionId;
        delete response._sessionId;

        const headers = { ...corsHeaders, "Content-Type": "application/json" };
        if (responseSessionId) {
          headers["mcp-session-id"] = responseSessionId;
        }

        return new Response(JSON.stringify(response), { headers });
      } catch (error) {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // SSE transport endpoint (for ChatGPT and other SSE-based clients)
    if (url.pathname === "/sse" && request.method === "GET") {
      // Generate a unique session/message endpoint
      const sessionId = crypto.randomUUID();
      const messageEndpoint = `${url.origin}/sse/message/${sessionId}`;

      // Create SSE response
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          // Send the endpoint event as required by MCP SSE transport
          const endpointEvent = `event: endpoint\ndata: ${messageEndpoint}\n\n`;
          controller.enqueue(encoder.encode(endpointEvent));

          // Keep connection alive with periodic pings
          const pingInterval = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              clearInterval(pingInterval);
            }
          }, 30000);

          // Store session for cleanup (in production, use KV or Durable Objects)
          activeSessions.add(sessionId);
        },
      });

      return new Response(stream, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // SSE message endpoint (receives JSON-RPC messages from SSE clients)
    if (url.pathname.startsWith("/sse/message/") && request.method === "POST") {
      const sessionId = url.pathname.split("/").pop() || null;

      try {
        const body = await request.json();
        const response = await handleJsonRpc(sessionId, body);

        if (response === null) {
          return new Response(null, { status: 204, headers: corsHeaders });
        }

        // Clean up internal fields
        delete response._sessionId;

        return new Response(JSON.stringify(response), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (error) {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
          { status: 400, headers: corsHeaders }
        );
      }
    }

    // Landing page
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(getLandingPageHtml(), {
        headers: { ...corsHeaders, "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // Not found
    return Response.json(
      { error: "Not found", endpoints: { mcp: "/mcp (POST)", health: "/health" } },
      { status: 404, headers: corsHeaders }
    );
  },
};

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getLandingPageHtml(): string {
  const toolsHtml = TOOLS
    .filter(t => !["search", "fetch"].includes(t.name))
    .map(t => `<li><span class="tool-name">${escapeHtml(t.name)}</span><br><span class="tool-desc">${escapeHtml(t.description.split('.')[0])}.</span></li>`)
    .join('\n        ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Server - Consultant.dev</title>
  <meta name="description" content="Search consultant jobs directly from your AI. Free MCP Server for Claude, Cursor, ChatGPT, and more.">
  <link rel="icon" href="https://consultant.dev/favicon.svg" type="image/svg+xml">
  <style>
    :root {
      --color-bg: #ffffff;
      --color-bg-subtle: #f6f9fc;
      --color-bg-muted: #edf2f7;
      --color-text: #0a2540;
      --color-text-secondary: #425466;
      --color-text-muted: #566678;
      --color-primary: #067267;
      --color-primary-hover: #055d54;
      --color-border: #e3e8ee;
      --color-border-subtle: #f0f4f8;
      --color-card: #ffffff;
      --font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --radius: 8px;
      --radius-lg: 12px;
      --radius-sm: 6px;
      --shadow-sm: 0 1px 2px rgba(50, 50, 93, 0.08), 0 1px 2px rgba(0, 0, 0, 0.06);
    }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { font-family: var(--font-family); font-size: 15px; line-height: 1.6; color: var(--color-text); background: var(--color-bg-subtle); -webkit-font-smoothing: antialiased; }
    body { min-height: 100vh; padding: 2rem 1rem; }
    .container { max-width: 800px; margin: 0 auto; }

    /* Hero */
    .hero { text-align: center; margin-bottom: 2.5rem; }
    .badge { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.375rem 0.75rem; background: var(--color-bg-muted); border-radius: 999px; font-size: 0.75rem; font-weight: 500; color: var(--color-text-muted); margin-bottom: 1rem; }
    .badge-dot { width: 8px; height: 8px; background: var(--color-primary); border-radius: 50%; animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .hero h1 { font-size: clamp(1.5rem, 4vw, 2rem); font-weight: 700; margin-bottom: 0.5rem; }
    .hero h1 span { color: var(--color-primary); }
    .hero p { color: var(--color-text-secondary); font-size: 1rem; margin-bottom: 1rem; }
    .meta { display: flex; justify-content: center; gap: 1.5rem; flex-wrap: wrap; font-size: 0.8125rem; color: var(--color-text-muted); }
    .meta span { display: flex; align-items: center; gap: 0.375rem; }
    .meta svg { width: 14px; height: 14px; color: var(--color-primary); }

    /* Video */
    .video-section { margin-bottom: 2rem; }
    .video-tabs { display: flex; justify-content: center; gap: 0.5rem; margin-bottom: 1rem; }
    .video-tab { display: flex; align-items: center; gap: 0.375rem; padding: 0.5rem 1rem; background: var(--color-card); border: 1px solid var(--color-border); border-radius: 999px; font-size: 0.8125rem; font-weight: 500; color: var(--color-text-muted); cursor: pointer; transition: all 0.2s; }
    .video-tab:hover { border-color: var(--color-primary); color: var(--color-text); }
    .video-tab.active { background: var(--color-primary); border-color: var(--color-primary); color: white; }
    .video-tab svg { width: 14px; height: 14px; }
    .video-container { aspect-ratio: 16/9; border-radius: var(--radius-lg); overflow: hidden; border: 1px solid var(--color-border); box-shadow: var(--shadow-sm); }
    .video-container iframe { width: 100%; height: 100%; border: none; display: none; }
    .video-container iframe.active { display: block; }

    /* Sections */
    .section { background: var(--color-card); border: 1px solid var(--color-border); border-radius: var(--radius-lg); padding: 1.5rem; margin-bottom: 1.5rem; }
    .section h2 { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); margin-bottom: 1rem; }

    /* Setup tabs */
    .tabs { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-bottom: 1rem; }
    .tab { padding: 0.5rem 0.875rem; border-radius: var(--radius-sm); background: var(--color-bg-subtle); color: var(--color-text-muted); cursor: pointer; font-size: 0.8125rem; font-weight: 500; border: none; transition: all 0.2s; }
    .tab:hover { background: var(--color-bg-muted); color: var(--color-text); }
    .tab.active { background: var(--color-primary); color: white; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .code-block { background: #0d1117; border-radius: var(--radius); padding: 1rem; font-family: 'SF Mono', Monaco, monospace; font-size: 0.8125rem; overflow-x: auto; }
    .code-block code { color: #c9d1d9; white-space: pre-wrap; word-break: break-all; }
    .note { font-size: 0.75rem; color: var(--color-text-muted); margin-top: 0.75rem; }

    /* Tools */
    .tools-list { list-style: none; }
    .tools-list li { padding: 0.625rem 0; border-bottom: 1px solid var(--color-border-subtle); }
    .tools-list li:last-child { border-bottom: none; }
    .tool-name { font-weight: 600; color: var(--color-primary); font-family: 'SF Mono', Monaco, monospace; font-size: 0.875rem; }
    .tool-desc { color: var(--color-text-secondary); font-size: 0.8125rem; }

    /* Prompts */
    .prompts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; }
    .prompt-card { padding: 0.875rem; background: var(--color-bg-subtle); border: 1px solid var(--color-border-subtle); border-radius: var(--radius); cursor: pointer; transition: all 0.2s; }
    .prompt-card:hover { border-color: var(--color-primary); }
    .prompt-cat { font-size: 0.625rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--color-text-muted); margin-bottom: 0.375rem; }
    .prompt-text { font-size: 0.8125rem; color: var(--color-text); line-height: 1.4; }
    .prompt-copy { font-size: 0.6875rem; color: var(--color-text-muted); margin-top: 0.5rem; }
    .prompt-card.copied .prompt-copy { color: var(--color-primary); }

    /* One-click install */
    .oneclick { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; margin-bottom: 1.5rem; }
    .oneclick-btn { display: flex; align-items: center; gap: 0.75rem; padding: 0.875rem 1rem; background: var(--color-card); border: 1px solid var(--color-border); border-radius: var(--radius); text-decoration: none; transition: all 0.2s; cursor: pointer; }
    .oneclick-btn:hover { border-color: var(--color-primary); }
    .oneclick-btn svg { width: 28px; height: 28px; flex-shrink: 0; }
    .oneclick-btn.vscode svg { color: #007acc; }
    .oneclick-btn.copy svg { color: var(--color-primary); }
    .oneclick-btn.copied { border-color: var(--color-primary); }
    .oneclick-text { display: flex; flex-direction: column; gap: 2px; }
    .oneclick-label { font-size: 0.875rem; font-weight: 600; color: var(--color-text); }
    .oneclick-hint { font-size: 0.6875rem; color: var(--color-text-muted); }
    .oneclick-note { text-align: center; font-size: 0.6875rem; color: var(--color-text-muted); margin-bottom: 1rem; }

    /* Architecture */
    .arch { display: flex; align-items: center; justify-content: center; gap: 1rem; flex-wrap: wrap; padding: 1.5rem 0; }
    .arch-node { display: flex; flex-direction: column; align-items: center; gap: 0.375rem; }
    .arch-icon { width: 48px; height: 48px; display: flex; align-items: center; justify-content: center; background: var(--color-bg-muted); border: 1px solid var(--color-border); border-radius: var(--radius); }
    .arch-icon.accent { background: var(--color-primary); border: none; }
    .arch-icon svg { width: 24px; height: 24px; color: var(--color-text-muted); }
    .arch-icon.accent svg { color: white; }
    .arch-label { font-size: 0.75rem; font-weight: 600; color: var(--color-text); }
    .arch-sub { font-size: 0.625rem; color: var(--color-text-muted); }
    .arch-arrow { color: var(--color-text-muted); font-size: 0.625rem; text-align: center; }
    .arch-arrow svg { width: 20px; height: 20px; }

    /* Links */
    .links { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; margin-top: 2rem; }
    .btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.625rem 1.25rem; border-radius: var(--radius); font-size: 0.875rem; font-weight: 600; text-decoration: none; transition: all 0.15s; }
    .btn-primary { background: var(--color-primary); color: white; }
    .btn-primary:hover { background: var(--color-primary-hover); }
    .btn-ghost { background: transparent; color: var(--color-text-muted); border: 1px solid var(--color-border); }
    .btn-ghost:hover { color: var(--color-primary); border-color: var(--color-primary); }
    .btn svg { width: 16px; height: 16px; }

    @media (max-width: 600px) {
      .tabs { gap: 0.25rem; }
      .tab { padding: 0.375rem 0.625rem; font-size: 0.75rem; }
      .prompts-grid { grid-template-columns: 1fr; }
      .oneclick { grid-template-columns: 1fr; }
      .arch { flex-direction: column; }
      .arch-arrow svg { transform: rotate(90deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="hero">
      <div class="badge"><span class="badge-dot"></span>MCP Server</div>
      <h1>Connect Your AI to <span>Live Job Data</span></h1>
      <p>Search thousands of consultant assignments directly from Claude, Cursor, ChatGPT, and more.</p>
      <div class="meta">
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>No API key required</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Privacy-first</span>
        <span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Real-time data</span>
      </div>
    </div>

    <div class="video-section">
      <div class="video-tabs">
        <button class="video-tab active" onclick="showVideo('demo')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Live Demo
        </button>
        <button class="video-tab" onclick="showVideo('setup')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
          Setup Guide
        </button>
      </div>
      <div class="video-container">
        <iframe id="video-demo" class="active" src="https://www.youtube-nocookie.com/embed/4h4EGE2kcmY" title="MCP Demo" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
        <iframe id="video-setup" src="https://www.youtube-nocookie.com/embed/olh4NVlSG0s" title="Setup Guide" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
      </div>
    </div>

    <div class="oneclick">
      <a href="vscode:mcp/install?%7B%22name%22%3A%22consultant-jobs%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.consultant.dev%2Fmcp%22%7D" class="oneclick-btn vscode">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"/></svg>
        <div class="oneclick-text"><span class="oneclick-label">Install in VS Code</span><span class="oneclick-hint">One-click setup</span></div>
      </a>
      <button class="oneclick-btn copy" onclick="copyUrl(this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
        <div class="oneclick-text"><span class="oneclick-label">Copy MCP URL</span><span class="oneclick-hint">https://mcp.consultant.dev/mcp</span></div>
      </button>
    </div>
    <p class="oneclick-note">One-click requires VS Code. Or configure manually below:</p>

    <div class="section">
      <h2>Quick Setup</h2>
      <div class="tabs">
        <button class="tab active" onclick="showTab('claude-code')">Claude Code</button>
        <button class="tab" onclick="showTab('claude-desktop')">Claude Desktop</button>
        <button class="tab" onclick="showTab('cursor')">Cursor</button>
        <button class="tab" onclick="showTab('chatgpt')">ChatGPT</button>
        <button class="tab" onclick="showTab('vscode')">VS Code</button>
      </div>
      <div id="claude-code" class="tab-content active">
        <div class="code-block"><code>claude mcp add --transport http consultant-jobs https://mcp.consultant.dev/mcp</code></div>
      </div>
      <div id="claude-desktop" class="tab-content">
        <div class="code-block"><code>{
  "mcpServers": {
    "consultant-jobs": {
      "url": "https://mcp.consultant.dev/mcp"
    }
  }
}</code></div>
        <p class="note">Add to claude_desktop_config.json</p>
      </div>
      <div id="cursor" class="tab-content">
        <div class="code-block"><code>{
  "consultant-jobs": {
    "url": "https://mcp.consultant.dev/mcp"
  }
}</code></div>
        <p class="note">Add to MCP Settings in Cursor</p>
      </div>
      <div id="chatgpt" class="tab-content">
        <div class="code-block"><code>https://mcp.consultant.dev/sse</code></div>
        <p class="note">Add as MCP Connector in ChatGPT Settings</p>
      </div>
      <div id="vscode" class="tab-content">
        <div class="code-block"><code>{
  "mcp": {
    "servers": {
      "consultant-jobs": {
        "url": "https://mcp.consultant.dev/mcp"
      }
    }
  }
}</code></div>
        <p class="note">Add to VS Code settings.json</p>
      </div>
    </div>

    <div class="section">
      <h2>Available Tools</h2>
      <ul class="tools-list">
        ${toolsHtml}
      </ul>
    </div>

    <div class="section">
      <h2>How It Works</h2>
      <div class="arch">
        <div class="arch-node">
          <div class="arch-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg></div>
          <span class="arch-label">Your IDE</span>
          <span class="arch-sub">Claude / Cursor</span>
        </div>
        <div class="arch-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg><br>HTTPS</div>
        <div class="arch-node">
          <div class="arch-icon accent"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg></div>
          <span class="arch-label">MCP Server</span>
          <span class="arch-sub">mcp.consultant.dev</span>
        </div>
        <div class="arch-arrow"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg><br>API</div>
        <div class="arch-node">
          <div class="arch-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg></div>
          <span class="arch-label">Job Database</span>
          <span class="arch-sub">Live data</span>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Example Prompts</h2>
      <div class="prompts-grid">
        <div class="prompt-card" onclick="copyPrompt(this, 'Find backend developer jobs in Stockholm that match someone with 5 years of Java experience.')">
          <div class="prompt-cat">Resume Match</div>
          <div class="prompt-text">Find backend developer jobs in Stockholm that match someone with 5 years of Java experience.</div>
          <div class="prompt-copy">Click to copy</div>
        </div>
        <div class="prompt-card" onclick="copyPrompt(this, 'Which companies have the most open positions right now?')">
          <div class="prompt-cat">Market Analysis</div>
          <div class="prompt-text">Which companies have the most open positions right now?</div>
          <div class="prompt-copy">Click to copy</div>
        </div>
        <div class="prompt-card" onclick="copyPrompt(this, 'Find all jobs requiring Kubernetes and cloud experience.')">
          <div class="prompt-cat">Tech Stack</div>
          <div class="prompt-text">Find all jobs requiring Kubernetes and cloud experience.</div>
          <div class="prompt-copy">Click to copy</div>
        </div>
        <div class="prompt-card" onclick="copyPrompt(this, 'Show me the 5 most recently posted jobs.')">
          <div class="prompt-cat">Quick Search</div>
          <div class="prompt-text">Show me the 5 most recently posted jobs.</div>
          <div class="prompt-copy">Click to copy</div>
        </div>
      </div>
    </div>

    <div class="links">
      <a href="https://github.com/Bytelope/mcp-consultant-dev" class="btn btn-primary" target="_blank">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c6.63 0 12 5.27 12 11.79 0 5.07-3.29 9.57-8.18 11.19-.6.12-.82-.26-.82-.57v-3.24c0-1.1-.38-1.81-.81-2.18 2.67-.3 5.48-1.3 5.48-5.82 0-1.3-.47-2.34-1.23-3.17.12-.3.54-1.5-.12-3.13 0 0-1-.32-3.3 1.21a11.32 11.32 0 00-6 0c-2.3-1.53-3.3-1.21-3.3-1.21-.66 1.62-.24 2.83-.12 3.13-.77.83-1.23 1.88-1.23 3.17 0 4.51 2.79 5.52 5.46 5.82-.35.3-.66.81-.77 1.58-.69.31-2.42.81-3.5-.97-.22-.36-.9-1.22-1.84-1.21-1 .02-.41.56.01.78.51.28 1.1 1.33 1.23 1.67.24.66 1.02 1.93 4.04 1.39v2.2c0 .31-.22.68-.83.56C3.3 21.35 0 16.86 0 11.79 0 5.27 5.37 0 12 0z"/></svg>
        View on GitHub
      </a>
      <a href="https://consultant.dev" class="btn btn-ghost">Browse Jobs Manually</a>
    </div>
  </div>

  <script>
    function showTab(id) {
      document.querySelectorAll('.tabs .tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById(id).classList.add('active');
    }
    function showVideo(id) {
      document.querySelectorAll('.video-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.video-container iframe').forEach(f => f.classList.remove('active'));
      event.target.closest('.video-tab').classList.add('active');
      document.getElementById('video-' + id).classList.add('active');
    }
    function copyPrompt(el, text) {
      navigator.clipboard.writeText(text);
      el.classList.add('copied');
      el.querySelector('.prompt-copy').textContent = 'Copied!';
      setTimeout(() => {
        el.classList.remove('copied');
        el.querySelector('.prompt-copy').textContent = 'Click to copy';
      }, 2000);
    }
    function copyUrl(el) {
      navigator.clipboard.writeText('https://mcp.consultant.dev/mcp');
      el.classList.add('copied');
      el.querySelector('.oneclick-label').textContent = 'Copied!';
      setTimeout(() => {
        el.classList.remove('copied');
        el.querySelector('.oneclick-label').textContent = 'Copy MCP URL';
      }, 2000);
    }
  </script>
</body>
</html>`;
}
