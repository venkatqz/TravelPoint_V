import { Request, Response } from 'express';
import fs from 'fs';
import csv from 'csv-parser';
import { pool } from '../config/config'; 
import { AuthRequest } from '../middlewares/authMiddleware';

// Define the shape of your CSV Row
interface RouteCSVRow {
  route_name: string;
  total_distance: string;
  estimated_time: string;
  stop_name: string;
  order_id: string;
  distance_from_source: string;
  price_from_source: string;
  stop_type: string; 
  stop_time: string;
}

export const uploadRouteCSV = async (req: Request, res: Response) => {
  const authReq = req as AuthRequest;
  
  // --- FIX: TypeScript Check ---
  // We check immediately if the file exists.
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No CSV file uploaded." });
  }
  
  // We assign it to a const so TypeScript knows it is not undefined below
  const file = req.file; 
  // -----------------------------

  const results: RouteCSVRow[] = [];
  const operatorId = authReq.user?.user_id;

  // Read the file from the path we just validated
  fs.createReadStream(file.path)
    .pipe(csv())
    .on('data', (data) => results.push(data))
    .on('end', async () => {
      
      const connection = await pool.getConnection(); // Get transaction connection
      
      try {
        await connection.beginTransaction(); // START TRANSACTION

        // 1. Group rows by Route Name
        const routesMap: Record<string, RouteCSVRow[]> = {};
        
        results.forEach(row => {
          // specific check to skip empty rows
          if(row.route_name) {
             if (!routesMap[row.route_name]) {
               routesMap[row.route_name] = [];
             }
             routesMap[row.route_name].push(row);
          }
        });

        // 2. Loop through each unique Route
        for (const routeName in routesMap) {
          const rows = routesMap[routeName];
          const firstRow = rows[0];

          // A. Insert the Parent ROUTE
          // Note: added 'ignore' or check if exists logic could go here, 
          // but for now we insert.
          const [routeResult]: any = await connection.execute(
            `INSERT INTO route (route_name, total_distance, estimated_time, operator_id) 
             VALUES (?, ?, ?, ?)`,
            [
              routeName, 
              parseFloat(firstRow.total_distance), 
              firstRow.estimated_time, 
              operatorId
            ]
          );

          const newPathId = routeResult.insertId;

          // B. Insert all STOPS for this Route
          for (const row of rows) {
            await connection.execute(
              `INSERT INTO stops 
              (path_id, stop_name, order_id, distance, price, estimated_time, stop_type) 
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                newPathId,
                row.stop_name,
                parseInt(row.order_id),
                parseFloat(row.distance_from_source),
                parseFloat(row.price_from_source),
                row.stop_time, 
                row.stop_type
              ]
            );
          }
        }

        await connection.commit(); // SAVE CHANGES
        
        // 3. Cleanup: Delete the uploaded file
        fs.unlinkSync(file.path); 

        return res.status(200).json({ 
          success: true, 
          message: `Successfully uploaded ${Object.keys(routesMap).length} routes and their stops.` 
        });

      } catch (error: any) {
        await connection.rollback(); // CANCEL CHANGES IF ERROR
        console.error("CSV Upload Error:", error);
        
        // Cleanup file even on error
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);

        return res.status(500).json({ success: false, message: "Failed to process CSV: " + error.message });
      } finally {
        connection.release();
      }
    });
};