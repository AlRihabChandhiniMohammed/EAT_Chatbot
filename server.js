require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");

// Render scanned PDFs to images (for Gemini vision)
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("canvas");

const app = express();

/**
 * ✅ CORS
 * If frontend + backend are SAME Render service (recommended), you can keep this open.
 * If you host frontend separately, restrict origins.
 */
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * ✅ Serve your frontend (public/index.html)
 * Put index.html inside: public/index.html
 */
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running ✅" });
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Multer PDF upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ---------------- Gemini helpers ----------------
async function geminiGenerate({ modelName, contents, generationConfig }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "Missing GEMINI_API_KEY in Render env vars" } },
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  // IMPORTANT: always parse safely
  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  return { ok: resp.ok, status: resp.status, data };
}

function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: Learn Beyond Books. " +
    "Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). " +
    "4) Use emojis. 5) End with: Do you want any changes? 👇";

  if (mode === "study") {
    return base + " Mode: Study Plan. Give a clear plan with day-wise tasks + resources + checklist.";
  }
  if (mode === "resume") {
    return base + " Mode: Resume Helper. Improve ATS bullets with action verbs + metrics. Suggest skills. Ask 1 follow-up question.";
  }
  if (mode === "projects") {
    return base + " Mode: Project Ideas. Give 6-8 ideas (Easy/Medium/Hard) with stack + features + what student learns.";
  }
  return base + " Mode: General assistant.";
}

// ---------------- PDF render -> images (for scanned PDFs) ----------------
async function renderPdfPagesToPngParts(buffer, maxPages = 4) {
  // disableWorker avoids node worker issues
  const pdf = await pdfjsLib.getDocument({ data: buffer, disableWorker: true }).promise;

  const pages = Math.min(pdf.numPages, maxPages);
  const parts = [];

  for (let pageNum = 1; pageNum <= pages; pageNum++) {
    const page = await pdf.getPage(pageNum);

    // scale controls quality + cost. 1.6 is a good balance.
    const viewport = page.getViewport({ scale: 1.6 });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const png = canvas.toBuffer("image/png");
    const base64 = png.toString("base64");

    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: base64,
      },
    });
  }

  return parts;
}

// ============ CHAT ============
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
            Array.isArray(h.parts)
        )
      : [];

    const systemPrompt = buildSystemPrompt(mode);

    const contents = [
      { role: "user", parts: [{ text: systemPrompt }] },
      ...safeHistory,
      { role: "user", parts: [{ text: message }] },
    ];

    const modelName = "models/gemini-2.5-flash";

    const result = await geminiGenerate({
      modelName,
      contents,
      generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 2000 },
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const reply = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
    return res.json({ reply });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============ PDF SUMMARIZE (text PDFs + scanned PDFs) ============
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF files are allowed" });

    // 1) Try text extraction first
    let parsedText = "";
    try {
      const parsed = await pdfParse(req.file.buffer);
      parsedText = (parsed.text || "").trim();
    } catch {
      parsedText = "";
    }

    const modelName = "models/gemini-2.5-flash";

    // If we got good text -> summarize text
    if (parsedText && parsedText.length > 200) {
      const clipped = parsedText.length > 35000 ? parsedText.slice(0, 35000) : parsedText;

      const prompt =
        "Summarize this PDF for a student in this format:\n" +
        "-> 5 key takeaways\n-> Important definitions\n-> Short notes\n-> 10 important questions\n" +
        "End with: Do you want any changes? 👇\n\nPDF TEXT:\n" +
        clipped;

      const result = await geminiGenerate({
        modelName,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
      });

      if (!result.ok) {
        return res.status(result.status).json({
          error: result.data?.error?.message || "Gemini API error",
          details: result.data,
        });
      }

      const summary = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";
      return res.json({ summary, used_vision: false });
    }

    // 2) Otherwise scanned/image PDF -> render pages to PNG -> Gemini vision summarize
    const imageParts = await renderPdfPagesToPngParts(req.file.buffer, 4);

    const visionPrompt =
      "These are PDF page images (scanned notes). Read them and summarize for a student in this format:\n" +
      "-> 5 key takeaways\n-> Important definitions\n-> Short notes\n-> 10 important questions\n" +
      "End with: Do you want any changes? 👇";

    const result = await geminiGenerate({
      modelName,
      contents: [{ role: "user", parts: [{ text: visionPrompt }, ...imageParts] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";
    return res.json({ summary, used_vision: true, pages_used: imageParts.length });
  } catch (err) {
    console.error("❌ /api/summarize-pdf error:", err);
    // IMPORTANT: always return JSON (not HTML)
    return res.status(500).json({ error: err.message });
  }
});

// Start
const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => console.log("✅ Server running on port", PORT));