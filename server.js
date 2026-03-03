// server.js (COMPLETE) ✅
// One-service setup: serves frontend from /public + provides /api/chat + /api/summarize-pdf
// Works on Render + Local

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const path = require("path");

const app = express();

/* =========================
   Middleware
========================= */

// If you're serving frontend from same domain, CORS is not required,
// but keeping it on is fine for testing.
app.use(cors());

// Parse JSON bodies
app.use(express.json({ limit: "2mb" }));

// Serve static frontend from /public
app.use(express.static(path.join(__dirname, "public")));

// Home route -> index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Health route
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running ✅" });
});

/* =========================
   Config
========================= */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// PDF upload in memory (10MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* =========================
   Helpers
========================= */

// Gemini request helper
async function geminiGenerate({ modelName, contents, generationConfig }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "Missing GEMINI_API_KEY (set it in Render env vars)" } },
    };
  }

  // v1 endpoint
  const url = `https://generativelanguage.googleapis.com/v1/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  const text = await resp.text(); // read raw first
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  return { ok: resp.ok, status: resp.status, data };
}

// Mode prompts
function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: 'Learn Beyond Books'. " +
    "Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). " +
    "4) Use emojis. 5) Focus on alternative learning and tech. " +
    "6) End with: Do you want any changes? 👇";

  if (mode === "study") {
    return (
      base +
      " Mode: Study Plan. Make a clear plan with daily tasks, time estimates, resources, and checklist."
    );
  }
  if (mode === "resume") {
    return (
      base +
      " Mode: Resume Helper. Improve ATS bullets using action verbs + metrics, rewrite summary, suggest skills, and ask 1 follow-up question."
    );
  }
  if (mode === "projects") {
    return (
      base +
      " Mode: Project Ideas. Give 6-8 ideas: Easy/Medium/Hard, include stack, features, and what student learns."
    );
  }
  return base + " Mode: General assistant.";
}

// Quick check: is this PDF likely scanned/image-only?
function looksScannedOrImagePdf(extractedText) {
  const t = (extractedText || "").trim();
  return !t || t.length < 80;
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

    // Keep only valid history items
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
      modelName: "models/gemini-2.5-flash",
      contents,
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 2000,
      },
    });

    if (!result.ok) {
      console.error("❌ Gemini /api/chat error:", result.data);
      return res.status(result.status || 500).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const reply = result.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      console.error("❌ Empty Gemini reply:", result.data);
      return res.status(500).json({ error: "Gemini returned empty reply", details: result.data });
    }

    return res.json({ reply, model_used: "models/gemini-2.5-flash" });
  } catch (err) {
    console.error("❌ /api/chat crash:", err);
    return res.status(500).json({ error: err.message });
  }
});

// PDF SUMMARIZE (TEXT ONLY - FREE)
// NOTE: Image/scanned PDFs cannot be reliably summarized for FREE without OCR.
// We detect and return a helpful message instead of crashing.
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    }

    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only PDF files are allowed" });
    }

    // Extract selectable text
    const parsed = await pdfParse(req.file.buffer);
    const extractedText = (parsed.text || "").trim();

    // If scanned/image-only -> respond clearly (free solution limitation)
    if (looksScannedOrImagePdf(extractedText)) {
      return res.status(200).json({
        summary:
          "I couldn't extract readable text from this PDF 😕\n" +
          "Looks like it is a scanned/image PDF.\n\n" +
          "Free option:\n" +
          "-> Please export the PDF as text (if possible) OR upload a clearer text-based PDF.\n\n" +
          "If you want, I can add OCR (but it will be slow and may fail on Render free tier). \n" +
          "Do you want any changes? 👇",
        used_ocr: false,
        scanned_pdf: true,
      });
    }

    // Clip long text to stay safe
    const maxChars = 35000;
    const clipped = extractedText.length > maxChars ? extractedText.slice(0, maxChars) : extractedText;

    const prompt =
      "Summarize this PDF text for a student. Output format:\n" +
      "-> 5 key takeaways\n" +
      "-> Important definitions\n" +
      "-> Suggestions / improvements\n" +
      "-> Ask 3 follow-up questions\n" +
      "End with: Do you want any changes? 👇\n\n" +
      "PDF TEXT:\n" +
      clipped;

    const result = await geminiGenerate({
      modelName: "models/gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2000,
      },
    });

    if (!result.ok) {
      console.error("❌ Gemini /api/summarize-pdf error:", result.data);
      return res.status(result.status || 500).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary = result.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!summary) {
      console.error("❌ Empty Gemini summary:", result.data);
      return res.status(500).json({ error: "Gemini returned empty summary", details: result.data });
    }

    return res.json({
      summary,
      extracted_chars: clipped.length,
      scanned_pdf: false,
      used_ocr: false,
    });
  } catch (err) {
    console.error("❌ /api/summarize-pdf crash:", err);
    return res.status(500).json({ error: err.message });
  }
});

/* =========================
   Start server
========================= */

const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});