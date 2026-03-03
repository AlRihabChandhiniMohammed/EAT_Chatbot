// server.js ✅ (Render + Local) — Supports PDF summarizing incl. image/scanned PDFs via Gemini inlineData
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");

const app = express();

/* =========================
   Middleware
========================= */
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Serve frontend from /public (recommended)
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running ✅" });
});

/* =========================
   Config
========================= */
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "models/gemini-2.5-flash";

// PDF upload in memory (15MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/* =========================
   Helpers
========================= */
function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: 'Learn Beyond Books'. " +
    "Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). " +
    "4) Use emojis. 5) Focus on alternative learning and tech. " +
    "6) End with: Do you want any changes? 👇 " +
    "IMPORTANT: If user says they will give a PDF, tell them to use the 📄 upload button and you can summarize it (including scanned/image PDFs).";

  if (mode === "study") return base + " Mode: Study Plan. Give a day-wise plan with tasks, time, resources, checklist.";
  if (mode === "resume") return base + " Mode: Resume Helper. ATS bullets with metrics, improve summary, skills, ask 1 follow-up question.";
  if (mode === "projects") return base + " Mode: Project Ideas. 6-8 ideas (Easy/Medium/Hard), stack, features, learnings.";
  if (mode === "pdf") return base + " Mode: PDF Summariser. Ask user to upload PDF using 📄. After upload: give summary + notes + questions.";
  return base + " Mode: General assistant.";
}

async function geminiGenerate({ contents, generationConfig }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "Missing GEMINI_API_KEY in Render Environment Variables" } },
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  // Read raw first so we never crash JSON parsing
  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  return { ok: resp.ok, status: resp.status, data };
}

/* =========================
   Routes
========================= */

// CHAT
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], mode = "general" } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required (string)" });
    }

    const safeHistory = Array.isArray(history)
      ? history.filter(
          (h) =>
            h &&
            (h.role === "user" || h.role === "model") &&
            Array.isArray(h.parts) &&
            h.parts.every((p) => typeof p?.text === "string")
        )
      : [];

    const systemPrompt = buildSystemPrompt(mode);

    const contents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      ...safeHistory,
      { role: "user", parts: [{ text: message }] },
    ];

    const result = await geminiGenerate({
      contents,
      generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2000 },
    });

    if (!result.ok) {
      console.error("❌ Gemini chat error:", result.data);
      return res.status(result.status || 500).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const reply = result.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      console.error("❌ Empty reply:", result.data);
      return res.status(500).json({ error: "Empty reply from Gemini", details: result.data });
    }

    return res.json({ reply, model_used: MODEL });
  } catch (err) {
    console.error("❌ /api/chat crash:", err);
    return res.status(500).json({ error: err.message });
  }
});

// PDF SUMMARISE (works for normal + scanned/image PDFs)
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF files are allowed" });

    const base64Pdf = req.file.buffer.toString("base64");

    const prompt =
      "Summarize this PDF for a student. Follow this format:\n" +
      "-> 8 key takeaways\n" +
      "-> Short notes (unit-wise if possible)\n" +
      "-> Important definitions/formulas\n" +
      "-> 10 important exam questions\n" +
      "-> 10 MCQs (with answers)\n" +
      "End with: Do you want any changes? 👇";

    const contents = [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: base64Pdf,
            },
          },
        ],
      },
    ];

    const result = await geminiGenerate({
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 2500 },
    });

    if (!result.ok) {
      console.error("❌ Gemini PDF error:", result.data);
      return res.status(result.status || 500).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary = result.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!summary) {
      console.error("❌ Empty PDF summary:", result.data);
      return res.status(500).json({ error: "Empty summary from Gemini", details: result.data });
    }

    return res.json({ summary, model_used: MODEL });
  } catch (err) {
    console.error("❌ /api/summarize-pdf crash:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================
   Start
========================= */
const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => console.log("✅ Server running on port", PORT));