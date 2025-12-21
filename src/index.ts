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

    // Not found
    return Response.json(
      { error: "Not found", endpoints: { mcp: "/mcp (POST)", health: "/health" } },
      { status: 404, headers: corsHeaders }
    );
  },
};
