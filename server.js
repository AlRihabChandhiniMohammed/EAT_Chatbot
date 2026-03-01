require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");

// OCR stack (for scanned/image PDFs)
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("canvas");
const Tesseract = require("tesseract.js");

const app = express();

// ✅ CORS (allow frontend anywhere for now)
app.use(cors());

app.use(express.json({ limit: "2mb" }));

// ✅ Health route
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running ✅" });
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// PDF upload in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

// ---- Gemini helper ----
async function geminiGenerate({ modelName, contents, generationConfig }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "Missing GEMINI_API_KEY in Render environment variables" } },
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

// ---- Mode prompts ----
function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: 'Learn Beyond Books'. " +
    "Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). " +
    "4) Use emojis. 5) Focus on alternative learning and tech. " +
    "6) End with: Do you want any changes? 👇";

  if (mode === "study") {
    return base + " Mode: Study Plan. Make a clear plan with daily tasks, time estimates, resources, and checklist.";
  }
  if (mode === "resume") {
    return base + " Mode: Resume Helper. Improve ATS bullets using action verbs + metrics, rewrite summary, suggest skills, and ask 1 follow-up question.";
  }
  if (mode === "projects") {
    return base + " Mode: Project Ideas. Give 6-8 ideas: Easy/Medium/Hard, include stack, features, and what student learns.";
  }
  return base + " Mode: General assistant.";
}

// ✅ OCR function: render PDF pages -> OCR -> text
async function ocrPdfToText(buffer, maxPages = 5) {
  const loadingTask = pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  const totalPages = Math.min(pdf.numPages, maxPages);
  let allText = "";

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdf.getPage(pageNum);

    // Render bigger for OCR accuracy
    const viewport = page.getViewport({ scale: 2.0 });

    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const imgBuffer = canvas.toBuffer("image/png");

    const result = await Tesseract.recognize(imgBuffer, "eng", {
      logger: () => {}, // quiet logs
    });

    allText += `\n\n--- Page ${pageNum} ---\n${result?.data?.text || ""}`;
  }

  return allText.trim();
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
      generationConfig: {
        temperature: 0.7,
        topP: 0.9,
        maxOutputTokens: 2000,
      },
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const reply =
      result.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response generated.";

    return res.json({ reply, model_used: modelName });
  } catch (err) {
    console.error("❌ /api/chat error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============ PDF SUMMARIZE (TEXT + OCR FALLBACK) ============
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    }

    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only PDF files are allowed" });
    }

    // 1) Try normal text extraction first
    const parsed = await pdfParse(req.file.buffer);
    let text = (parsed.text || "").trim();
    let used_ocr = false;

    // 2) If low/no text -> OCR fallback
    if (!text || text.length < 80) {
      used_ocr = true;
      console.log("📄 Scanned/image PDF detected -> using OCR fallback...");
      text = await ocrPdfToText(req.file.buffer, 5); // OCR first 5 pages
    }

    if (!text || text.length < 30) {
      return res.status(400).json({
        error: "Could not extract readable text from this PDF (even with OCR). Try a clearer scan or fewer pages.",
      });
    }

    // Clip long text
    const maxChars = 35000;
    const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;

    const prompt =
      "Summarize this PDF text for a student. Output format:\n" +
      "-> 5 key takeaways\n" +
      "-> Important definitions\n" +
      "-> Suggestions / improvements\n" +
      "-> Ask 3 follow-up questions\n" +
      "End with: Do you want any changes? 👇\n\n" +
      "PDF TEXT:\n" +
      clipped;

    const modelName = "models/gemini-2.5-flash";

    const result = await geminiGenerate({
      modelName,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2000,
      },
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary =
      result.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No summary generated.";

    return res.json({ summary, used_ocr });
  } catch (err) {
    console.error("❌ /api/summarize-pdf error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ✅ Render PORT
const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running on port", PORT);
});