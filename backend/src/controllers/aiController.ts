import { Request, Response } from 'express';
import { generateAIResponse } from '../services/aiService';
import { generateAndSaveApiKey } from '../services/mcpTokenService';
import { AuthRequest } from '../middlewares/authMiddleware';

export const chatWithAI = async (req: Request, res: Response) => {
    try {
        const { message } = req.body;
        const authReq = req as AuthRequest;

        if (!message) {
            return res.status(400).json({ error: "Message is required" });
        }

        // Use authenticated user's ID instead of hardcoded value
        const userId = authReq.user?.user_id;
        if (!userId) {
            return res.status(401).json({ error: "Authentication required" });
        }

        const reply = await generateAIResponse(message, userId);

        return res.json({ reply });

    } catch (error) {
        console.error("Controller Error:", error);
        return res.status(500).json({ error: "Internal Server Error" });
    }
};

export const generateApiKey = async (req: Request, res: Response) => {
  try {
    const authReq = req as AuthRequest;
    
    // Get user ID from authenticated request (JWT token)
    const userId = authReq.user?.user_id;

    if (!userId) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }

    // Call the Service
    const apiKey = await generateAndSaveApiKey(userId);

    // Send Success Response
    return res.status(200).json({
      success: true,
      message: "API Key generated successfully.",
      apiKey: apiKey
    });

  } catch (error: any) {
    console.error("Controller Error:", error.message);
    return res.status(500).json({ success: false, message: error.message });
  }
};