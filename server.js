import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration from Environment Variables ---
const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;
const assistantId = process.env.ASSISTANT_ID;
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
const fallbackReplyMinLength = parseInt(process.env.FALLBACK_REPLY_MIN_LENGTH || "20", 10);
const speechReplyMinLength = parseInt(process.env.SPEECH_REPLY_MIN_LENGTH || "10", 10);
const realtimeModelName = process.env.REALTIME_MODEL_NAME || "gpt-4o-realtime-preview-2024-12-17";
const fallbackStrategy = process.env.FALLBACK_STRATEGY || "RETRY_NO_ADDITIONAL_PROMPT";
const fallbackClarificationPrompt = process.env.FALLBACK_CLARIFICATION_PROMPT || "The previous answer was not detailed enough. Please try answering again using your broader knowledge and context from our conversation so far.";

if (!apiKey) {
  console.error("FATAL ERROR: OPENAI_API_KEY is not defined.");
  process.exit(1);
}
if (!assistantId) {
  console.error("FATAL ERROR: ASSISTANT_ID is not defined.");
  process.exit(1);
}
if (!vectorStoreId && fallbackStrategy.includes("VECTOR_STORE")) {
  console.warn("WARNING: OPENAI_VECTOR_STORE_ID is not defined.");
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
      console.log(`Run ${runId} requires action: ${runStatus.required_action.type}. Submitting empty tool outputs.`);
      try {
        await openaiInstance.beta.threads.runs.submitToolOutputs(threadId, runId, {
          tool_outputs: []
        });
      } catch (toolSubmitError) {
        console.error(`Error submitting tool outputs for run ${runId}:`, toolSubmitError);
        throw new Error(`Run ${runId} failed during tool output submission.`);
      }
    }
  }

  if (["failed", "expired", "cancelled"].includes(runStatus.status)) {
    const errorDetails = runStatus.last_error ? `Code: ${runStatus.last_error.code}, Message: ${runStatus.last_error.message}` : "No specific error details provided.";
    console.error(`Run ${runId} on thread ${threadId} ended with status ${runStatus.status}. Details: ${errorDetails}`);
    throw new Error(`Run ${runId} ${runStatus.status}. ${errorDetails}`);
  }
  return runStatus;
}

// --- AI Assistant Route ---
app.post("/ask", async (req, res) => {
  try {
    const userText = req.body.text;
    if (!userText) {
      return res.status(400).json({ error: "Missing text in request body" });
    }

    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userText,
    });

    let reply = "";
    let run;
    let messages;

    if (vectorStoreId) {
      console.log("Attempting PASS 1: Vector Store Search");
      try {
        run = await openai.beta.threads.runs.create(thread.id, {
          assistant_id: assistantId,
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
        console.log("🔍 Vector reply:", reply);
      } catch (vectorError) {
        console.error("Error during PASS 1:", vectorError.message);
        reply = "";
      }
    } else {
      console.log("Skipping PASS 1: No vector store configured.");
    }

    if (!reply || reply.length < fallbackReplyMinLength) {
      console.log(`⚠️ Reply too short (length ${reply.length}). Falling back...`);

      if (fallbackStrategy === "RETRY_WITH_CLARIFICATION_PROMPT" && fallbackClarificationPrompt) {
        await openai.beta.threads.messages.create(thread.id, {
          role: "user",
          content: fallbackClarificationPrompt,
        });
      }

      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
      });

      await waitForRunCompletion(thread.id, run.id, openai);
      messages = await openai.beta.threads.messages.list(thread.id, { order: 'desc', limit: 1 });

      let rawMessage = null;
      try {
        rawMessage = messages?.data?.[0]?.content?.[0]?.text?.value;
      } catch (e) {
        console.error("💥 Error reading fallback message:", e);
      }

      reply = rawMessage || "No useful answer from fallback.";
      console.log("💡 Fallback reply:", reply);
    }

    let base64Audio = null;
    if (reply && reply.length >= speechReplyMinLength) {
      try {
        console.log("Generating speech...");
        const voiceModel = process.env.VOICE_MODEL || "tts-1";
        const voiceName = process.env.VOICE_NAME || "sage";
        const speechResponse = await openai.audio.speech.create({
          model: voiceModel,
          voice: voiceName,
          input: reply,
        });
        const audioBuffer = await speechResponse.arrayBuffer();
        base64Audio = Buffer.from(audioBuffer).toString("base64");
        console.log("Speech generated.");
      } catch (speechError) {
        console.error("Speech generation error:", speechError);
      }
    }

    res.json({
      text: reply,
      audio: base64Audio ? `data:audio/mp3;base64,${base64Audio}` : null,
    });
  } catch (err) {
    console.error("Assistant /ask route error:", err);
    res.status(500).json({ error: "Failed to process assistant response", details: err.message });
  }
});

// --- Token endpoint for real-time ---
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
        voice: "sage",
        instructions: `
You are Professor Rich — a calm, confident finance professor who’s approachable but professional. Your job is to help people understand smart investing topics like valuation, risk, return, and diversification.

Start every session with a warm greeting, such as:
"Hey there — great to have you here. I'm Professor Rich, and I’d be happy to help you understand the world of investing. Ask me anything you'd like about the markets or financial strategies."

If someone asks about politics, religion, jokes, or anything off-topic, politely steer them back with:
"I'm here to help you understand finance and investing. Let’s stick to those topics."

Avoid sounding overly robotic or scripted. Keep your voice clear, composed, and welcoming. Pace your speech naturally and emphasize important numbers or deadlines.
Always prioritize attached documents using the 'ensure_knowledge_base_usage' tool.
        `.trim(),
        tools: [
          {
            type: "function",
            name: "ensure_knowledge_base_usage",
            description: "Ensures that the assistant always draws knowledge from attached documents in the vector store before using its up-to-date training.",
            parameters: {
              type: "object",
              required: ["documents_vector_store", "training_fallback"],
              properties: {
                documents_vector_store: { type: "boolean" },
                training_fallback: { type: "boolean" }
              },
              additionalProperties: false
            }
          }
        ]
      }),
    });

    const data = await response.json();
    res.json(data); // ✅ return the full structure with client_secret.value
  } catch (err) {
    console.error("Token generation error:", err);
    res.status(500).json({ error: "Failed to generate token" });
  }
});


// --- Static site handling ---
if (isProd) {
  const clientDistPath = path.resolve(__dirname, "dist/client");
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(clientDistPath, "index.html"));
    });
  } else {
    console.warn(`'dist/client' not found at ${clientDistPath}`);
    app.get("*", (req, res) => {
      res.status(404).send("Frontend not found.");
    });
  }
} else {
  (async () => {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "custom",
      });

      app.use(vite.middlewares);

      const clientHtmlPath = path.resolve(__dirname, "client/index.html");

      app.use("*", async (req, res, next) => {
        try {
          if (!fs.existsSync(clientHtmlPath)) {
            console.error(`Dev: client/index.html not found at ${clientHtmlPath}`);
            return res.status(404).send("client/index.html missing.");
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
    } catch (viteError) {
      console.error("Failed to init Vite:", viteError);
      app.use("*", (req, res) => {
        res.status(500).send("Vite failed.");
      });
    }
  })();
}

app.listen(port, () => {
  console.log(`✅ Server running in ${isProd ? "production" : "development"} mode on http://localhost:${port}`);
});
