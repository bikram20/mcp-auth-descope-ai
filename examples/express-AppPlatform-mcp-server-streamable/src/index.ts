import dotenv from "dotenv";
import express, { Request, Response } from "express";
import cors from "cors";
import path from 'path';
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { descopeMcpAuthRouter, descopeMcpBearerAuth } from "@descope/mcp-express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

dotenv.config();

// Validate required environment variables
const requiredEnvVars = ['DESCOPE_PROJECT_ID', 'DESCOPE_MANAGEMENT_KEY', 'SERVER_URL'];
const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingEnvVars.length > 0) {
  console.error('Missing required environment variables:', missingEnvVars);
  console.error('Please check your .env file and ensure all required variables are set.');
  process.exit(1);
}

console.log('Environment variables loaded:');
console.log('- DESCOPE_PROJECT_ID:', process.env.DESCOPE_PROJECT_ID ? 'Set' : 'Missing');
console.log('- DESCOPE_MANAGEMENT_KEY:', process.env.DESCOPE_MANAGEMENT_KEY ? 'Set' : 'Missing');
console.log('- SERVER_URL:', process.env.SERVER_URL);

const PORT = process.env.PORT || 3000;

const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

// Create server instance
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// Helper function for making NWS API requests
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

interface AlertFeature {
  properties: {
    event?: string;
    areaDesc?: string;
    severity?: string;
    status?: string;
    headline?: string;
  };
}

// Format alert data
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

interface ForecastPeriod {
  name?: string;
  temperature?: number;
  temperatureUnit?: string;
  windSpeed?: string;
  windDirection?: string;
  shortForecast?: string;
}

interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}

// Register weather tools
server.tool(
  "get-alerts",
  "Get weather alerts for a state",
  {
    state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    if (!alertsData) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve alerts data",
          },
        ],
      };
    }

    const features = alertsData.features || [];
    if (features.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No active alerts for ${stateCode}`,
          },
        ],
      };
    }

    const formattedAlerts = features.map(formatAlert);
    const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join("\n")}`;

    return {
      content: [
        {
          type: "text",
          text: alertsText,
        },
      ],
    };
  },
);

server.tool(
  "get-forecast",
  "Get weather forecast for a location",
  {
    latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
    longitude: z.number().min(-180).max(180).describe("Longitude of the location"),
  },
  async ({ latitude, longitude }) => {
    // Get grid point data
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

    if (!pointsData) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
          },
        ],
      };
    }

    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to get forecast URL from grid point data",
          },
        ],
      };
    }

    // Get forecast data
    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve forecast data",
          },
        ],
      };
    }

    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No forecast periods available",
          },
        ],
      };
    }

    // Format forecast periods
    const formattedForecast = periods.map((period: ForecastPeriod) =>
      [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${period.temperatureUnit || "F"}`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
      ].join("\n"),
    );

    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join("\n")}`;

    return {
      content: [
        {
          type: "text",
          text: forecastText,
        },
      ],
    };
  },
);

const app = express();

// Middleware setup
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(cors({
  origin: true,
  methods: '*',
  allowedHeaders: 'Authorization, Origin, Content-Type, Accept, *',
}));
app.options("*", cors());

// Initialize transport BEFORE using it
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // set to undefined for stateless servers
});

// Descope MCP Auth - moved after transport initialization
// IMPORTANT: The auth router must come BEFORE other routes to handle OAuth endpoints
const authRouter = descopeMcpAuthRouter();
app.use(authRouter);
app.use(["/mcp"], descopeMcpBearerAuth());

// Add a health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Add a debug endpoint to check OAuth metadata
app.get('/.well-known/oauth-authorization-server', (req: Request, res: Response, next) => {
  console.log('OAuth metadata requested');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // Let the actual handler from Descope take over
  next();
});

// Add a root endpoint for testing
app.get('/', (req: Request, res: Response) => {
  res.json({ 
    message: 'Weather MCP Server is running',
    endpoints: {
      mcp: '/mcp',
      health: '/health',
      oauth_metadata: '/.well-known/oauth-authorization-server'
    },
    environment: {
      hasDescopeProjectId: !!process.env.DESCOPE_PROJECT_ID,
      hasDescopeManagementKey: !!process.env.DESCOPE_MANAGEMENT_KEY,
      serverUrl: process.env.SERVER_URL
    }
  });
});

// MCP endpoint with better error handling
app.post('/mcp', async (req: Request, res: Response) => {
  console.log('Received MCP request:', JSON.stringify(req.body, null, 2));
  console.log('Request headers:', req.headers);
  
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: 'Internal server error',
        },
        id: req.body?.id || null,
      });
    }
  }
});

// Add GET endpoint for testing (though MCP should use POST)
app.get('/mcp', (req: Request, res: Response) => {
  console.log('Received GET request to /mcp');
  res.json({
    message: 'MCP endpoint is available. Use POST with JSON-RPC 2.0 format.',
    server: 'weather-mcp-server',
    version: '1.0.1'
  });
});

// Server setup
const setupServer = async () => {
  try {
    // Connect server to transport
    await server.connect(transport);
    console.log('MCP Server connected to transport successfully');
    
    // Server connected successfully
    console.log('MCP Server setup complete');
    
  } catch (error) {
    console.error('Failed to set up the MCP server:', error);
    throw error;
  }
};

// Start server
setupServer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
      console.log(`Server URL: http://localhost:${PORT}`);
      console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`OAuth metadata: http://localhost:${PORT}/.well-known/oauth-authorization-server`);
      
      // Debug: List all registered routes
      console.log('\nRegistered routes:');
      (app as any)._router.stack.forEach((middleware: any, index: number) => {
        if (middleware.route) {
          console.log(`  ${middleware.route.path} [${Object.keys(middleware.route.methods).join(', ').toUpperCase()}]`);
        } else if (middleware.name === 'router') {
          console.log(`  Router middleware`);
          if (middleware.handle && middleware.handle.stack) {
            middleware.handle.stack.forEach((nestedRoute: any) => {
              if (nestedRoute.route) {
                console.log(`    ${nestedRoute.route.path} [${Object.keys(nestedRoute.route.methods).join(', ').toUpperCase()}]`);
              }
            });
          }
        }
      });
    });
  })
  .catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });

// Handle server shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  try {
    console.log('Closing transport');
    await transport.close();
  } catch (error) {
    console.error('Error closing transport:', error);
  }

  try {
    await server.close();
    console.log('Server shutdown complete');
  } catch (error) {
    console.error('Error closing server:', error);
  }
  process.exit(0);
});