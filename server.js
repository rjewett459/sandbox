import express from "express";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import "dotenv/config"; // Make sure to install dotenv: npm install dotenv
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Configuration from Environment Variables ---
const isProd = process.env.NODE_ENV === "production";
const port = process.env.PORT || 3000;
const apiKey = process.env.OPENAI_API_KEY;

const assistantId = process.env.OPENAI_ASSISTANT_ID;
const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
const fallbackReplyMinLength = parseInt(process.env.FALLBACK_REPLY_MIN_LENGTH || "20", 10);
const speechReplyMinLength = parseInt(process.env.SPEECH_REPLY_MIN_LENGTH || "10", 10);
const realtimeModelName = process.env.REALTIME_MODEL_NAME || "gpt-4o-realtime-preview-2024-12-17"; // Example, ensure this is current
const fallbackStrategy = process.env.FALLBACK_STRATEGY || "RETRY_NO_ADDITIONAL_PROMPT"; // "RETRY_NO_ADDITIONAL_PROMPT" or "RETRY_WITH_CLARIFICATION_PROMPT"
const fallbackClarificationPrompt = process.env.FALLBACK_CLARIFICATION_PROMPT || "The previous answer was not detailed enough. Please try answering again using your broader knowledge and context from our conversation so far.";


// --- Validate Essential Configuration ---
if (!apiKey) {
  console.error("FATAL ERROR: OPENAI_API_KEY is not defined in your environment variables.");
  process.exit(1);
}
if (!assistantId) {
  console.error("FATAL ERROR: OPENAI_ASSISTANT_ID is not defined in your environment variables.");
  process.exit(1);
}
if (!vectorStoreId && fallbackStrategy.includes("VECTOR_STORE")) { // If your strategy relies on it
    console.warn("WARNING: OPENAI_VECTOR_STORE_ID is not defined. Vector store search might not work as expected.");
}


const openai = new OpenAI({ apiKey });
const app = express();
app.use(express.json());

// --- Helper Function to Wait for Run Completion ---
async function waitForRunCompletion(threadId, runId, openaiInstance) {
  let runStatus = await openaiInstance.beta.threads.runs.retrieve(threadId, runId);
  while (["queued", "in_progress", "requires_action"].includes(runStatus.status)) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // Poll every 1 second
    runStatus = await openaiInstance.beta.threads.runs.retrieve(threadId, runId);

    if (runStatus.status === "requires_action" && runStatus.required_action?.type === "submit_tool_outputs") {
        // This is a basic example. You might need to handle specific tool calls if your assistant uses them.
        // For now, assuming file_search doesn't require manual tool output submission in this flow.
        // If other tools are added, this part would need to be expanded.
        console.log(`Run ${runId} requires action: ${runStatus.required_action.type}. Submitting empty tool outputs for now if applicable.`);
        try {
            await openaiInstance.beta.threads.runs.submitToolOutputs(threadId, runId, {
                tool_outputs: [] // Or map runStatus.required_action.submit_tool_outputs.tool_calls
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
    if (!assistantId) {
        return res.status(500).json({ error: "Assistant ID is not configured on the server." });
    }
    if (!vectorStoreId) {
        console.warn("OPENAI_VECTOR_STORE_ID is not set. Vector store search pass will be skipped or may fail if assistant relies on it.");
        // Depending on strictness, you might want to return an error here
        // return res.status(500).json({ error: "Vector Store ID is not configured." });
    }
    run = await openai.beta.threads.runs.create(thread.id, {
  assistant_id: assistantId,
  tool_choice: {
    type: "function",
    function: "ensure_knowledge_base_usage"
  },
  tool_resources: {
    function: {
      ensure_knowledge_base_usage: {
        documents_vector_store: true,
        training_fallback: true
      }
    }
  }
});


    const thread = await openai.beta.threads.create();

    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: userText,
    });

    let reply = "";
    let run;
    let messages;

    // === PASS 1: Vector Store Only (if vectorStoreId is configured) ===
    if (vectorStoreId) {
        console.log("Attempting PASS 1: Vector Store Search");
        try {
            run = await openai.beta.threads.runs.create(thread.id, {
              assistant_id: assistantId,
              tool_choice: { type: "file_search" }, // Forcing file_search (vector store)
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
            console.error("Error during PASS 1 (Vector Store Search):", vectorError.message);
            reply = ""; // Ensure reply is empty to trigger fallback
        }
    } else {
        console.log("Skipping PASS 1: Vector Store Search (OPENAI_VECTOR_STORE_ID not configured).");
    }


    // === PASS 2: Fallback to Model if reply too short or generic ===
    if (!reply || reply.length < fallbackReplyMinLength) {
      console.log(`⚠️ Vector store reply insufficient (length: ${reply.length}, min: ${fallbackReplyMinLength}). Retrying with general model knowledge...`);

      if (fallbackStrategy === "RETRY_WITH_CLARIFICATION_PROMPT" && fallbackClarificationPrompt) {
        await openai.beta.threads.messages.create(thread.id, {
          role: "user", // Or "assistant" if you want to frame it as a thought process for the AI
          content: fallbackClarificationPrompt,
        });
        console.log("Added clarification prompt for fallback.");
      }
      // If "RETRY_NO_ADDITIONAL_PROMPT", we simply create a new run without adding more messages.

      run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistantId,
        // tool_choice: "auto", // Let assistant decide, or remove to use its default configuration
      });

      await waitForRunCompletion(thread.id, run.id, openai);

      messages = await openai.beta.threads.messages.list(thread.id, { order: 'desc', limit: 1 });

let rawMessage = null;
try {
  rawMessage = messages?.data?.[0]?.content?.[0]?.text?.value;
} catch (e) {
  console.error("💥 Error reading message content:", e);
}

reply = rawMessage || "No useful answer from fallback.";
console.log("💡 Fallback reply:", reply);

    }

  // === Optional: Generate speech (only if meaningful reply) ===
let base64Audio = null;
if (reply && reply.length >= speechReplyMinLength) {
  try {
    console.log("Generating speech...");

    // ✅ Extract voice config from env first
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
    // Continue without audio if speech generation fails
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

// --- Token endpoint for realtime voice using Professor Rich with guardrails & error trapping ---
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

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[TOKEN ERROR] Status ${response.status}: ${errorText}`);
      return res.status(500).json({ error: "OpenAI token fetch failed", details: errorText });
    }

    const data = await response.json();

    if (!data.client_secret || !data.client_secret.value) {
  console.error("[TOKEN ERROR] No client_secret returned:", data);
  return res.status(500).json({ error: "Missing client_secret in OpenAI response", raw: data });
}

res.json({
  token: data.client_secret.value,
  expires_in: data.client_secret.expires_at
});
  } catch (error) {
    console.error("[TOKEN ERROR] Unexpected:", error);
    res.status(500).json({ error: "Token generation failed", details: error.message });
  }
}); // ✅ This must be present and closed!

// --- Serve static site ---
if (isProd) {
  const clientDistPath = path.resolve(__dirname, "dist/client");
  if (fs.existsSync(clientDistPath)) {
    app.use(express.static(clientDistPath));
    app.get("*", (req, res) => {
      res.sendFile(path.resolve(clientDistPath, "index.html"));
    });
  } else {
    console.warn(`Production mode: 'dist/client' directory not found at ${clientDistPath}. Frontend will not be served.`);
    app.get("*", (req, res) => {
        res.status(404).send("Frontend not found. Ensure your client application is built and in the 'dist/client' directory.");
    });
  }
} else { // Development mode
  (async () => {
    try {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: "custom",
        // Define the root of your client project if it's not the same as the server project root
        // root: path.resolve(__dirname, "../client") // Example if client is in a parent 'client' folder
      });

      app.use(vite.middlewares);

      const clientHtmlPath = path.resolve(__dirname, "client/index.html");

      app.use("*", async (req, res, next) => {
        try {
          if (!fs.existsSync(clientHtmlPath)) {
            console.error(`Development mode: client/index.html not found at ${clientHtmlPath}`);
            return res.status(404).send(`client/index.html not found at ${clientHtmlPath}. Please check the path.`);
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
      console.log("Vite dev server middleware configured.");
    } catch (viteError) {
        console.error("Failed to create or use Vite server:", viteError);
        // Fallback or error message if Vite fails
        app.use("*", (req, res) => {
            res.status(500).send("Vite server failed to initialize. Check server logs.");
        });
    }
  })();
}

app.listen(port, () => {
  console.log(`✅ Express server running in ${isProd ? 'production' : 'development'} mode on http://localhost:${port}`);
  if (!isProd) {
    console.log("   Vite dev server is active for client-side assets.");
  }
});
