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
            args: ["-y", "mcp-google-calendar"]
        });
        const client = new Client({ name: "TravelPoint-Client", version: "1.0.0" }, { capabilities: {} });

        // Add timeout to prevent hanging if server awaits auth
        const connectionPromise = client.connect(transport);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("MCP Connection Timed Out - Check if credentials.json is missing")), 5000)
        );

        await Promise.race([connectionPromise, timeoutPromise]);

        mcpClient = client;
        const result = await client.listTools();
        mcpToolsOrchestration = result.tools;
        console.log(`✅ MCP Connected. Tools found: ${result.tools.length}`);
    } catch (e: any) {
        console.error("❌ MCP Connection Failed (Non-fatal):", e.message);
        console.warn("ℹ️  Note: mcp-google-calendar requires a credentials.json file/env var to function.");
    }
}

const SYSTEM_INSTRUCTION = `You are the Travel Point AI Assistant. You help users with bus bookings.

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

/**
 * Helper to strip markdown and find the JSON object
 */
const extractJson = (text: string): string | null => {
    // Remove markdown code blocks and extra whitespace
    let clean = text
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .replace(/\r\n/g, "\n")  // Normalize line endings
        .replace(/[\x00-\x1F\x7F]/g, "") // Remove control characters
        .trim();

    console.log("🔍 Cleaned text:", clean.substring(0, 100));

    // Try multiple extraction strategies
    // Strategy 1: Find complete JSON object with balanced braces
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');

    if (start !== -1 && end !== -1 && end > start) {
        const jsonStr = clean.substring(start, end + 1);

        // Clean up any potential issues
        const finalJson = jsonStr
            .replace(/\n/g, " ")  // Remove newlines
            .replace(/\s+/g, " ")  // Normalize spaces
            .trim();

        console.log("📦 Extracted JSON:", finalJson);
        return finalJson;
    }
    return clean;
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
                    { role: "system", content: SYSTEM_INSTRUCTION },
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
                            console.warn(`⚠️ Unknown tool: ${toolCall.tool}`);
                            return "I couldn't understand which action to perform. Could you rephrase?";
                    }

                    console.log(`📊 Tool result: ${toolResult.substring(0, 100)}...`);

                    // D. Feed result back to AI for natural response
                    const finalResponse = await hf.chatCompletion({
                        model: model,
                        messages: [
                            { role: "system", content: SYSTEM_INSTRUCTION },
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