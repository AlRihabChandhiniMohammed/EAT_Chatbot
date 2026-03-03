require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- config ----------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "models/gemini-2.5-flash";

// PDF upload in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
});

// ---------- helpers ----------
async function geminiGenerate({ contents, generationConfig }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "Missing GEMINI_API_KEY in server environment" } },
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  const text = await resp.text();
  let data = {};
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return { ok: resp.ok, status: resp.status, data };
}

function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: 'Learn Beyond Books'. " +
    "Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). " +
    "4) Use emojis. 5) Focus on alternative learning and tech. " +
    "6) End with: Do you want any changes? 👇";

  if (mode === "study") return base + " Mode: Study Plan. Make daily tasks, time estimates, resources, and checklist.";
  if (mode === "resume") return base + " Mode: Resume Helper. Improve ATS bullets with action verbs + metrics, suggest skills, ask 1 follow-up question.";
  if (mode === "projects") return base + " Mode: Project Ideas. Give 6-8 ideas (Easy/Medium/Hard) with stack + features + what student learns.";
  return base + " Mode: General assistant.";
}

// ---------- routes ----------
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running ✅" });
});

// CHAT
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], mode = "general" } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required (string)" });
    }

    const safeHistory = Array.isArray(history)
      ? history.filter(h => h && (h.role === "user" || h.role === "model") && Array.isArray(h.parts))
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
      console.error("Gemini error:", result.data);
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const reply = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
    res.json({ reply, model_used: MODEL });
  } catch (err) {
    console.error("/api/chat crash:", err);
    res.status(500).json({ error: err.message });
  }
});

// PDF SUMMARIZE (works for text + images/scans)
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF files are allowed" });

    const base64Pdf = req.file.buffer.toString("base64");

    const prompt =
      "Summarize this PDF for a student.\n" +
      "Output format:\n" +
      "-> 5 key takeaways\n" +
      "-> Important definitions\n" +
      "-> Short notes (10 lines)\n" +
      "-> 5 Important questions\n" +
      "-> Ask 3 follow-up questions\n" +
      "End with: Do you want any changes? 👇";

    const contents = [{
      role: "user",
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType: "application/pdf",
            data: base64Pdf
          }
        }
      ]
    }];

    const result = await geminiGenerate({
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 2500 },
    });

    if (!result.ok) {
      console.error("Gemini PDF error:", result.data);
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";
    res.json({ summary });
  } catch (err) {
    console.error("/api/summarize-pdf crash:", err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- start ----------
const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running on port", PORT);
});