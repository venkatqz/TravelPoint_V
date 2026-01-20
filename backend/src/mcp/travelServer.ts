import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pool } from "../config/config"; 
import { bookingTools } from "../services/bookingTools";

const server = new McpServer({
  name: "TravelPoint-Agent",
  version: "1.0.0",
});

// --- HELPER: AUTHENTICATION CHECK ---
async function getAuthenticatedUser() {
  const apiKey = process.env.TRAVEL_API_KEY;

  if (!apiKey) {
    throw new Error("❌ Configuration Error: TRAVEL_API_KEY is missing.");
  }

  // --- EXPIRATION CHECK ---
  const parts = apiKey.split('_');
  if (parts.length === 3) {
    const expiryTimestamp = parseInt(parts[1], 10);
    const currentTimestamp = Math.floor(Date.now() / 1000);

    if (!isNaN(expiryTimestamp)) {
      if (currentTimestamp > expiryTimestamp) {
        throw new Error(`❌ Access Denied: Your API Key expired on ${new Date(expiryTimestamp * 1000).toLocaleString()}. Please generate a new one.`);
      }
    }
  }

  // --- DATABASE CHECK ---
  const query = "SELECT * FROM users WHERE api_key = ?";
  const [rows]: any = await pool.execute(query, [apiKey]);

  if (rows.length === 0) {
    throw new Error("❌ Access Denied: API Key is invalid.");
  }

  return rows[0]; 
}

// --- SCHEMA: Route Import Structure ---
const RouteImportSchema = z.object({
  route_name: z.string(),
  total_distance: z.number(),
  estimated_time: z.string(),
  stops: z.array(z.object({
    stop_name: z.string(),
    order_id: z.number(),
    distance_from_source: z.number(),
    price_from_source: z.number(),
    stop_type: z.enum(["Boarding", "Dropping", "Both"]),
    stop_time: z.string()
  }))
});

// --- TOOL 1: GET BOOKING ---
server.tool(
  "get_booking_details",
  { bookingId: z.number() },
  async ({ bookingId }) => {
    try {
      const user = await getAuthenticatedUser();

      const query = `
        SELECT 
          b.booking_id, 
          b.booking_status,
          b.amount_paid,
          b.booking_date,
          t.departure_time, 
          t.arrival_time, 
          t.status as trip_status,
          GROUP_CONCAT(bs.seat_number) as seat_numbers
        FROM bookings b
        JOIN trips t ON b.trip_id = t.trip_id
        LEFT JOIN booked_seats bs ON bs.booking_id = b.booking_id
        WHERE b.booking_id = ? AND b.passenger_id = ?
        GROUP BY b.booking_id
      `;
      
      const [rows]: any = await pool.execute(query, [bookingId, user.user_id]);

      if (rows.length === 0) {
        return { content: [{ type: "text", text: `❌ Ticket #${bookingId} not found under your account.` }] };
      }

      const ticket = rows[0];
      const resultText = `
🎫 Ticket Details:
- Booking ID: ${ticket.booking_id}
- Status: ${ticket.booking_status}
- Seats: ${ticket.seat_numbers || 'N/A'}
- Amount Paid: ₹${ticket.amount_paid}
- Booked On: ${new Date(ticket.booking_date).toLocaleString()}
- Departure: ${new Date(ticket.departure_time).toLocaleString()}
- Arrival: ${new Date(ticket.arrival_time).toLocaleString()}
- Trip Status: ${ticket.trip_status}
      `;

      return { content: [{ type: "text", text: resultText }] };

    } catch (error: any) {
      return { content: [{ type: "text", text: "❌ Database Error: " + error.message }] };
    }
  }
);

// --- TOOL 2: SEARCH TRIPS ---
server.tool(
  "search_trips",
  { 
    query: z.string().describe("The city name or bus type") 
  },
  async ({ query }) => {
    try {
      console.error(`🔍 MCP search_trips called with query: "${query}"`);
      const result = await bookingTools.searchTrips(query);
      return { content: [{ type: "text", text: result }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: "❌ Search Error: " + error.message }], isError: true };
    }
  }
);

// --- TOOL 3: BOOK TICKET ---
server.tool(
  "book_ticket",
  { 
    tripId: z.number(),
    pickupId: z.number(),
    dropId: z.number(),
    amount: z.number()
  },
  async ({ tripId, pickupId, dropId, amount }) => {
    try {
      const user = await getAuthenticatedUser();
      const result = await bookingTools.bookTicket(tripId, user.user_id, pickupId, dropId, amount);
      return { content: [{ type: "text", text: result }] };
    } catch (error: any) {
      return { content: [{ type: "text", text: "❌ Booking Error: " + error.message }] };
    }
  }
);

// --- TOOL 4: CANCEL BOOKING ---
server.tool(
  "cancel_booking",
  { bookingId: z.number() },
  async ({ bookingId }) => {
    try {
      const user = await getAuthenticatedUser();
      
      // Verify ownership
      const checkQuery = "SELECT passenger_id FROM bookings WHERE booking_id = ?";
      const [rows]: any = await pool.execute(checkQuery, [bookingId]);

      if (rows.length === 0) return { content: [{ type: "text", text: `❌ Booking not found.` }] };
      if (rows[0].passenger_id !== user.user_id) return { content: [{ type: "text", text: `❌ Access denied.` }] };

      const result = await bookingTools.cancelTicket(bookingId);
      return { content: [{ type: "text", text: result }] };

    } catch (error: any) {
      return { content: [{ type: "text", text: "❌ Cancellation Error: " + error.message }] };
    }
  }
);

// --- TOOL 5: BULK IMPORT ROUTES (NEW) ---
server.tool(
  "import_routes_bulk",
  {
    routes: z.array(RouteImportSchema).describe("List of routes and their stops to import")
  },
  async ({ routes }) => {
    try {
      // 1. Authenticate & Check Role
      const user = await getAuthenticatedUser();
      
      // SECURITY: Only allow 'operator' or 'admin' to import data
      if (user.role !== 'operator' && user.role !== 'admin') {
         return { content: [{ type: "text", text: "⛔ Permission Denied: Only Operators can import routes." }] };
      }

      const connection = await pool.getConnection();
      
      try {
        await connection.beginTransaction();

        let addedCount = 0;

        for (const route of routes) {
          // A. Create Route
          // We use the authenticated user's ID as the operator_id
          const [res]: any = await connection.execute(
            `INSERT INTO route (route_name, total_distance, estimated_time, operator_id) VALUES (?, ?, ?, ?)`,
            [route.route_name, route.total_distance, route.estimated_time, user.user_id] 
          );
          
          const pathId = res.insertId;

          // B. Create Stops
          for (const stop of route.stops) {
            await connection.execute(
              `INSERT INTO stops (path_id, stop_name, order_id, distance, price, estimated_time, stop_type) 
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [pathId, stop.stop_name, stop.order_id, stop.distance_from_source, stop.price_from_source, stop.stop_time, stop.stop_type]
            );
          }
          addedCount++;
        }

        await connection.commit();
        return { content: [{ type: "text", text: `✅ Successfully imported ${addedCount} routes and all stops!` }] };

      } catch (dbError: any) {
        await connection.rollback();
        throw dbError;
      } finally {
        connection.release();
      }

    } catch (error: any) {
      return { content: [{ type: "text", text: "❌ Import Failed: " + error.message }] };
    }
  }
);

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Server running with 5 tools (including import_routes_bulk)...");
}

run().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});