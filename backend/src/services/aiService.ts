import { HfInference } from "@huggingface/inference";
import { bookingTools } from "./bookingTools";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

dotenv.config();

const hf = new HfInference(process.env.HUGGING_FACE_API_KEY);

// --- MCP CLIENT SETUP ---
let mcpClient: Client | null = null;
let mcpToolsOrchestration: any[] = [];

async function connectToMcpServer() {
    if (mcpClient) return mcpClient;
    try {
        const transport = new StdioClientTransport({
            command: "npx",
            args: ["-y", "@cocal/google-calendar-mcp"],
            env: {
                ...process.env,
                GOOGLE_OAUTH_CREDENTIALS: process.env.GOOGLE_OAUTH_CREDENTIALS || "E:/J/Projects/01/TravelPoint_V/backend/credentials.json"
            }
        });
        const client = new Client({ name: "TravelPoint-Client", version: "1.0.0" }, { capabilities: {} });

        // Add timeout to prevent hanging if server awaits auth
        const connectionPromise = client.connect(transport);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MCP Connection Timed Out - Check if credentials.json is missing or Auth is pending")), 60000)
        );

        await Promise.race([connectionPromise, timeoutPromise]);

        mcpClient = client;
        try {
            const result = await client.listTools();
            mcpToolsOrchestration = result.tools;
            console.log(`✅ MCP Connected. Tools found: ${result.tools.length}`);
        } catch (toolError: any) {
            console.error("❌ MCP Tool Discovery Failed:", toolError.message);
            console.warn("⚠️ Using fallback definitions based on actual server errors.");

            // Fallback based on ACTUAL server validation errors
            mcpToolsOrchestration = [
                {
                    name: "add-account",
                    description: "Authenticate a Google account (use this if 'No authenticated accounts' error occurs)",
                    inputSchema: {
                        type: "object",
                        properties: {},
                        required: []
                    }
                },
                {
                    name: "create-event",
                    description: "Create a new event in Google Calendar",
                    inputSchema: {
                        type: "object",
                        properties: {
                            account: {
                                type: "string",
                                description: "Account nickname (default: 'normal')"
                            },
                            calendarId: {
                                type: "string",
                                description: "Calendar ID - ALWAYS use 'primary' for the user's primary calendar"
                            },
                            summary: { type: "string", description: "Event title" },
                            description: { type: "string", description: "Event description" },
                            start: {
                                type: "string",
                                description: "Start time as ISO string (e.g. 2024-01-20T10:00:00)"
                            },
                            end: {
                                type: "string",
                                description: "End time as ISO string (e.g. 2024-01-20T12:00:00)"
                            },
                            location: { type: "string", description: "Event location" }
                        },
                        required: ["calendarId", "summary", "start", "end"]
                    }
                },
                {
                    name: "list-events",
                    description: "List events from calendar",
                    inputSchema: {
                        type: "object",
                        properties: {
                            account: { type: "string", description: "Account nickname (default: 'normal')" },
                            calendarId: { type: "string", description: "Calendar ID (use 'primary')" },
                            timeMin: { type: "string", description: "Start of time range (ISO format)" },
                            timeMax: { type: "string", description: "End of time range (ISO format)" },
                            maxResults: { type: "number", description: "Max events (default 10)" }
                        },
                        required: ["calendarId"]
                    }
                }
            ];
            console.log(`✅ Loaded ${mcpToolsOrchestration.length} fallback tools matching actual server schema.`);
        }
    } catch (e: any) {
        console.error("❌ MCP Connection Failed (Non-fatal):", e.message);
        console.warn("ℹ️  Note: mcp-google-calendar requires a credentials.json file/env var to function.");
    }
}

// Initialize MCP connection when module loads
connectToMcpServer().catch(err => {
    console.warn('⚠️ MCP initialization failed (non-fatal):', err.message);
});

const SYSTEM_INSTRUCTION_BASE = `You are the Travel Point AI Assistant. You help users with bus bookings and calendar management.

<tools>
  <tool name="get_booking_details">
    <description>Get status and details of a specific booking</description>
    <parameters>
      <parameter name="bookingId" type="number" required="true">The booking ID to check</parameter>
    </parameters>
  </tool>
  
  <tool name="search_trips">
    <description>Search for available bus trips</description>
    <parameters>
      <parameter name="query" type="string" required="true">Search query with city names or bus type</parameter>
    </parameters>
  </tool>
  
  <tool name="cancel_booking">
    <description>Cancel a booking and process refund</description>
    <parameters>
      <parameter name="bookingId" type="number" required="true">The booking ID to cancel</parameter>
    </parameters>
  </tool>
  
  <tool name="book_ticket">
    <description>Book a new ticket</description>
    <parameters>
      <parameter name="tripId" type="number" required="true">Trip ID to book</parameter>
      <parameter name="pickupId" type="number" required="true">Pickup stop ID</parameter>
      <parameter name="dropId" type="number" required="true">Drop stop ID</parameter>
      <parameter name="amount" type="number" required="true">Amount to pay</parameter>
    </parameters>
  </tool>
</tools>

<instructions>
CRITICAL RULES:
1. When user requests booking info, use "get_booking_details" tool
2. When user wants to search buses, use "search_trips" tool
3. When user wants to cancel/refund, use "cancel_booking" tool
4. When user wants to book a ticket, use "book_ticket" tool

To call a tool, reply with ONLY valid JSON in this EXACT format:
{"tool": "tool_name", "args": {"paramName": value}}

If the user is just chatting (hello, thanks, etc), reply normally without JSON.
</instructions>
`;

// Dynamic system instruction builder
function buildSystemInstruction(): string {
    const now = new Date();
    // Inject current time so AI knows "today", "tomorrow"
    // EXPLICITLY state the year to prevent AI using training data year (e.g. 2024)
    const humanDate = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    let instruction = `Current System Time: ${now.toISOString()}
TODAY IS: ${humanDate}
IMPORTANT: The current year is ${now.getFullYear()}. Do NOT use 2023, 2024 or 2025.\n` + SYSTEM_INSTRUCTION_BASE;

    // Dynamically add Google Calendar tools if available
    if (mcpToolsOrchestration.length > 0) {
        for (const tool of mcpToolsOrchestration) {
            instruction += `  <tool name="${tool.name}">
    <description>${tool.description}</description>
    <parameters>
`;
            // Add parameters from tool schema
            if (tool.inputSchema?.properties) {
                for (const [paramName, paramSchema] of Object.entries(tool.inputSchema.properties)) {
                    const schema = paramSchema as any;
                    const required = tool.inputSchema.required?.includes(paramName) || false;
                    instruction += `      <parameter name="${paramName}" type="${schema.type || 'string'}" required="${required}">${schema.description || ''}</parameter>
`;
                }
            }
            instruction += `    </parameters>
  </tool>
`;
        }
    }

    instruction += `</tools>

<instructions>
CRITICAL RULES:
1. When user requests booking info, use "get_booking_details" tool
2. When user wants to search buses, use "search_trips" tool
3. When user wants to cancel/refund, use "cancel_booking" tool
4. When user wants to book a ticket, use "book_ticket" tool
5. When user wants calendar operations, use the appropriate Google Calendar tool

CALENDAR TOOL RULES (STRICT):
- For "create-event", do NOT use a nested 'event' object. Place summary, description, start, and end directly in the top-level arguments alongside calendarId.
- ALWAYS use 'primary' as the calendarId unless specified otherwise.
- ALWAYS use 'normal' as the account nickname.
- Start/End times MUST be plain strings (ISO format), NOT objects.

To call a tool, reply with ONLY valid JSON in this EXACT format:
{"tool": "tool_name", "args": {"paramName": value}}

If the user is just chatting (hello, thanks, etc), reply normally without JSON.
</instructions>
`;

    return instruction;
}

/**
 * Helper to strip markdown and find the JSON object
 */
const extractJson = (text: string): string | null => {
    // Remove markdown code blocks and extra whitespace
    let clean = text
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/[\x00-\x1F\x7F]/g, "")
        .trim();

    console.log("🔍 Cleaned text (last 100 chars):", clean.substring(Math.max(0, clean.length - 100)));

    // Strategy: Search backwards for the last valid JSON object
    // 1. Find all closing braces '}'
    const closingIndices: number[] = [];
    for (let i = clean.length - 1; i >= 0; i--) {
        if (clean[i] === '}') closingIndices.push(i);
    }

    // 2. For each closing brace (starting from the very last one), try to find a matching opening brace
    for (const closeIdx of closingIndices) {
        let balance = 0;
        for (let i = closeIdx; i >= 0; i--) {
            const char = clean[i];
            if (char === '}') balance++;
            if (char === '{') balance--;

            if (balance === 0) {
                // Found a balanced block `candidate`
                const candidate = clean.substring(i, closeIdx + 1);
                try {
                    const parsed = JSON.parse(candidate);
                    // Basic heuristic: it should be an object with "tool" property
                    if (parsed && typeof parsed === 'object' && parsed.tool) {
                        console.log("📦 Extracted JSON:", candidate);
                        return candidate;
                    }
                } catch (e) {
                    // Not valid JSON, continue searching
                }
            }
        }
    }

    return null;
};

export const generateAIResponse = async (userMessage: string, userId: number = 1) => {
    console.log("🟢 generateAIResponse called with:", userMessage);

    // Use better models trained for instruction following and function calling
    const models = [
        'mistralai/Mixtral-8x7B-Instruct-v0.1',    // Excellent at JSON format
        'NousResearch/Hermes-2-Pro-Mistral-7B',    // Trained for function calling
        'meta-llama/Meta-Llama-3-8B-Instruct'      // Fallback
    ];

    let lastError = null;

    for (const model of models) {
        try {
            console.log(`🤖 Trying model: ${model}`);

            // A. Initial Request with enhanced prompt
            // Define validation helper if not imported
            const isValidToolCall = (obj: any): boolean => {
                return obj && typeof obj.tool === "string" && obj.args && typeof obj.args === "object";
            };

            const response = await hf.chatCompletion({
                model: model,
                messages: [
                    { role: "system", content: buildSystemInstruction() },
                    { role: "user", content: userMessage }
                ],
                max_tokens: 300,
                temperature: 0.1 // Low temp = strict logic
            });

            const content = response.choices[0]?.message?.content || "";
            console.log(`📝 Model response: ${content}`);

            // B. Check for Tool Call with improved detection
            const jsonStr = extractJson(content);

            if (jsonStr) {
                console.log(`🛠️ Detected potential tool call`);

                try {
                    // CLEAN the JSON before parsing
                    const toolCall = JSON.parse(jsonStr);

                    // Validate the tool call structure
                    if (!isValidToolCall(toolCall)) {
                        console.warn("⚠️ Invalid tool call structure, treating as normal response");
                        return content;
                    }

                    let toolResult = "";
                    console.log(`✅ Valid tool call: ${toolCall.tool}`);

                    // C. Execute the appropriate tool
                    switch (toolCall.tool) {
                        case "search_trips":
                            toolResult = await bookingTools.searchTrips(toolCall.args.query);
                            break;

                        case "get_booking_details":
                            const bookingId = parseInt(toolCall.args.bookingId);
                            if (isNaN(bookingId)) {
                                return "I need a valid booking ID number to check the status.";
                            }
                            toolResult = await bookingTools.getBookingDetails(bookingId);
                            break;

                        case "cancel_booking":
                            const cancelId = parseInt(toolCall.args.bookingId);
                            if (isNaN(cancelId)) {
                                return "I need a valid booking ID number to cancel.";
                            }
                            toolResult = await bookingTools.cancelTicket(cancelId);
                            break;

                        case "book_ticket":
                            toolResult = await bookingTools.bookTicket(
                                toolCall.args.tripId,
                                userId,
                                toolCall.args.pickupId,
                                toolCall.args.dropId,
                                toolCall.args.amount
                            );
                            break;

                        default:
                            // Check if it's a Google Calendar MCP tool
                            if (mcpClient && mcpToolsOrchestration.some(t => t.name === toolCall.tool)) {
                                console.log(`📅 Executing MCP tool: ${toolCall.tool}`);
                                try {
                                    // Transform to match server expectations
                                    let transformedArgs = toolCall.args;

                                    // Handle @cocal/google-calendar-mcp tool: create-event (Flat structure)
                                    if (toolCall.tool === "create-event") {
                                        transformedArgs = { ...toolCall.args };

                                        // Ensure account exists (default to 'normal')
                                        if (!transformedArgs.account) {
                                            transformedArgs.account = 'normal';
                                        }

                                        // Ensure calendarId exists
                                        if (!transformedArgs.calendarId) {
                                            transformedArgs.calendarId = 'primary';
                                        }

                                        // If AI wrapped in 'event' (old habit), unwrap it
                                        if (transformedArgs.event) {
                                            const evt = transformedArgs.event;
                                            transformedArgs = {
                                                ...transformedArgs,
                                                ...evt,
                                                // Prioritize event properties
                                                summary: evt.summary || transformedArgs.summary,
                                                description: evt.description || transformedArgs.description,
                                                start: evt.start || transformedArgs.start,
                                                end: evt.end || transformedArgs.end
                                            };
                                            delete transformedArgs.event;
                                        }

                                        // Ensure start/end are strings (AI might give objects)
                                        if (typeof transformedArgs.start === 'object') {
                                            transformedArgs.start = transformedArgs.start.dateTime || transformedArgs.start.date;
                                        }
                                        if (typeof transformedArgs.end === 'object') {
                                            transformedArgs.end = transformedArgs.end.dateTime || transformedArgs.end.date;
                                        }

                                        console.log("🔧 Normalized create-event args (Flat structure)");
                                    }
                                    // Handle mcp-google-calendar tool: create_calendar_event (Nested 'event' structure)
                                    else if (toolCall.tool === "list-events") {
                                        transformedArgs = { ...toolCall.args };

                                        // Ensure account exists (default to 'normal') and fix placeholders
                                        if (!transformedArgs.account || transformedArgs.account === 'value' || transformedArgs.account === 'your_account') {
                                            transformedArgs.account = 'normal';
                                        }

                                        // Ensure calendarId exists and fix placeholders
                                        if (!transformedArgs.calendarId || transformedArgs.calendarId === 'value' || transformedArgs.calendarId === 'your_calendar_id') {
                                            transformedArgs.calendarId = 'primary';
                                        }

                                        // Limit maxResults to prevent context overflow (default to 5 if not set)
                                        if (!transformedArgs.maxResults) {
                                            transformedArgs.maxResults = 5;
                                        }

                                        console.log("🔧 Normalized list-events args (Limit 5 events)");
                                    }
                                    // Handle mcp-google-calendar tool: create_calendar_event (Nested 'event' structure)
                                    else if (toolCall.tool === "create_calendar_event") {
                                        // Wrapper logic for original server (if fallback used)
                                        if (toolCall.args.event) {
                                            // Already wrapped, just fix dates
                                            const evt = toolCall.args.event;
                                            if (typeof evt.start === 'object' || typeof evt.end === 'object') {
                                                transformedArgs = {
                                                    ...toolCall.args,
                                                    event: {
                                                        ...evt,
                                                        start: typeof evt.start === 'object' ? (evt.start.dateTime || evt.start.date) : evt.start,
                                                        end: typeof evt.end === 'object' ? (evt.end.dateTime || evt.end.date) : evt.end
                                                    }
                                                };
                                            }
                                        } else {
                                            // Flat args needs wrapping
                                            transformedArgs = {
                                                calendarId: toolCall.args.calendarId || 'primary',
                                                event: { ...toolCall.args }
                                            };
                                        }
                                    }

                                    const mcpResult = await mcpClient.callTool({
                                        name: toolCall.tool,
                                        arguments: transformedArgs
                                    });

                                    // Extract text from MCP response
                                    toolResult = (mcpResult.content as any[])
                                        .map((c: any) => c.type === 'text' ? c.text : '')
                                        .join('\n');

                                    // Truncate if too long (prevents context overflow)
                                    if (toolResult && toolResult.length > 4000) {
                                        console.log(`⚠️ Truncating large tool result (${toolResult.length} chars)`);
                                        toolResult = toolResult.substring(0, 4000) + "\n... (Output truncated due to length limits)";
                                    }
                                } catch (mcpError: any) {
                                    console.error(`❌ MCP tool execution failed:`, mcpError);
                                    if (toolCall.tool.includes('calendar')) {
                                        toolResult = `I can see you want to use the calendar feature, but the Google Calendar service isn't fully configured yet. Please ask your administrator to set up the calendar credentials.`;
                                    } else {
                                        toolResult = `Calendar operation failed: ${mcpError.message}`;
                                    }
                                }
                            } else {
                                console.warn(`⚠️ Unknown tool: ${toolCall.tool}`);
                                return "I couldn't understand which action to perform. Could you rephrase?";
                            }
                    }

                    console.log(`📊 Tool result: ${toolResult.substring(0, 100)}...`);

                    // D. Feed result back to AI for natural response
                    const finalResponse = await hf.chatCompletion({
                        model: model,
                        messages: [
                            { role: "system", content: buildSystemInstruction() },
                            { role: "user", content: userMessage },
                            { role: "assistant", content: jsonStr },
                            { role: "user", content: `Tool Output: ${toolResult}. Please tell me what you did.` }
                        ],
                        max_tokens: 300
                    });

                    return finalResponse.choices[0]?.message?.content;

                } catch (parseError) {
                    console.error("❌ JSON Parse Error:", parseError);
                    // If JSON parsing fails, treat as normal response
                    return content;
                }
            }

            // E. No tool call detected - return conversational response
            return content;

        } catch (error: any) {
            console.warn(`⚠️ Model ${model} failed:`, error.message);
            lastError = error;
            continue; // Try next model
        }
    }

    // All models failed
    console.error("❌ All models failed:", lastError);
    return "I'm having trouble processing your request right now. Please try again in a moment.";
};