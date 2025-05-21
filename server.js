import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const assistantId = process.env.OPENAI_ASSISTANT_ID;
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
const fallbackReplyMinLength = parseInt(process.env.FALLBACK_REPLY_MIN_LENGTH || "20", 10);
const speechReplyMinLength = parseInt(process.env.SPEECH_REPLY_MIN_LENGTH || "10", 10);
const fallbackStrategy = process.env.FALLBACK_STRATEGY || "RETRY_NO_ADDITIONAL_PROMPT";
const fallbackClarificationPrompt = process.env.FALLBACK_CLARIFICATION_PROMPT || "The previous answer was not detailed enough. Please try again.";

if (!apiKey || !assistantId) {
  console.error("FATAL: Missing required OpenAI env variables.");
  process.exit(1);
}

const openai = new OpenAI({ apiKey });
const app = express();
app.use(express.json());

async function waitForRunCompletion(threadId, runId, openaiInstance) {
  let runStatus = await openaiInstance.beta.threads.runs.retrieve(threadId, runId);
  while (["queued", "in_progress", "requires_action"].includes(runStatus.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    runStatus = await openaiInstance.beta.threads.runs.retrieve(threadId, runId);

    if (runStatus.status === "requires_action" && runStatus.required_action?.type === "submit_tool_outputs") {
      await openaiInstance.beta.threads.runs.submitToolOutputs(threadId, runId, {
        tool_outputs: []
      });
    }
  }

  if (["failed", "expired", "cancelled"].includes(runStatus.status)) {
    throw new Error(`Run ${runId} ${runStatus.status}`);
  }
  return runStatus;
}

app.post("/ask", async (req, res) => {
  try {
    const userText = req.body.text;
    const userId = req.body.user_id || "anonymous_user"; // ✅ Identify the user for memory

    if (!userText) return res.status(400).json({ error: "Missing text in request body" });

    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userText,
    });

    let reply = "";
    let run;
    let messages;

    // === PASS 1: Vector store only ===
    if (vectorStoreId) {
      try {
        run = await openai.beta.threads.runs.create(thread.id, {
          assistant_id: assistantId,
          user_id: userId, // ✅ Include user_id for memory tracking
          tool_choice: { type: "file_search" },
          tool_resources: {
            file_search: {
              vector_store_ids: [vectorStoreId],
            },
          },
        });

        await waitForRunCompletion(thread.id, run.id, openai);
        messages = await openai.beta.threads.messages.list(thread.id, { order: 'desc', limit: 1 });
        reply = messages.data[0]?.content[0]?.text?.value || "";
      } catch (e) {
        console.warn("Vector store fallback:", e.message);
        reply = "";
      }
    }

    // === PASS 2: Fallback to model if reply too short ===
    if (!reply || reply.length < fallbackReplyMinLength) {
      if (fallbackStrategy === "RETRY_WITH_CLARIFICATION_PROMPT") {
        await openai.beta.threads.messages.create(thread.id, {
          role: "user",
          content: fallbackClarificationPrompt,
        });
      }

      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
        user_id: userId, // ✅ Include user_id here too
      });

      await waitForRunCompletion(thread.id, run.id, openai);
      messages = await openai.beta.threads.messages.list(thread.id, { order: 'desc', limit: 1 });

      reply = messages?.data?.[0]?.content?.[0]?.text?.value || "No fallback reply available.";
    }

    // === Optional: Generate speech ===
    let base64Audio = null;
    if (reply.length >= speechReplyMinLength) {
      try {
        const voiceModel = process.env.VOICE_MODEL || "tts-1";
        const voiceName = process.env.VOICE_NAME || "verse";

        const speechResponse = await openai.audio.speech.create({
          model: voiceModel,
          voice: voiceName,
          input: reply,
        });

        const audioBuffer = await speechResponse.arrayBuffer();
        base64Audio = Buffer.from(audioBuffer).toString("base64");
      } catch (err) {
        console.error("Speech generation error:", err);
      }
    }

    res.json({
      text: reply,
      audio: base64Audio ? `data:audio/mp3;base64,${base64Audio}` : null,
    });

  } catch (err) {
    console.error("/ask error:", err);
    res.status(500).json({ error: "Assistant failed", details: err.message });
  }
});

app.get("/token", async (req, res) => {
  try {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-realtime-preview",
        voice: "verse",
        instructions: `
You are Professor Rich — a calm, confident finance professor who’s approachable but professional. Your job is to help people understand smart investing topics like valuation, risk, return, and diversification.

Start every session with a warm greeting, such as:
"Hey there — great to have you here. I'm Professor Rich, and I’d be happy to help you understand the world of investing. Ask me anything you'd like about the markets or financial strategies."

If someone asks about politics, religion, jokes, or anything off-topic, politely steer them back with:
"I'm here to help you understand finance and investing. Let’s stick to those topics."

Avoid sounding overly robotic or scripted. Keep your voice clear, composed, and welcoming. Pace your speech naturally and emphasize important numbers or deadlines.
        `.trim(),
      }),
    });

    const data = await response.json();
    res.json(data); // Important: must return full object so frontend can use client_secret.value
  } catch (err) {
    console.error("/token error:", err);
    res.status(500).json({ error: "Failed to create realtime session", details: err.message });
  }
});

// --- Static Site Hosting (Prod vs Dev) ---
if (isProd) {
  const clientDistPath = path.resolve(__dirname, "dist/client");
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(clientDistPath, "index.html"));
    });
  } else {
    app.get("*", (req, res) => {
      res.status(404).send("Frontend not built.");
    });
  }
} else {
  (async () => {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "custom",
    });

    app.use(vite.middlewares);
    const clientHtmlPath = path.resolve(__dirname, "client/index.html");

    app.use("*", async (req, res, next) => {
      try {
        if (!fs.existsSync(clientHtmlPath)) {
          return res.status(404).send("Missing client/index.html");
        }
        const html = await vite.transformIndexHtml(
          req.originalUrl,
          fs.readFileSync(clientHtmlPath, "utf-8")
        );
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (e) {
        vite.ssrFixStacktrace(e);
        next(e);
      }
    });
  })();
}

app.listen(port, () => {
  console.log(`✅ Server live on http://localhost:${port} (${isProd ? "prod" : "dev"} mode)`);
});
