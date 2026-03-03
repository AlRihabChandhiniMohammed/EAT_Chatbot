"use strict";

require("dotenv").config();

const path = require("path");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse");

const { createCanvas, DOMMatrix, ImageData } = require("canvas");

// ✅ Polyfills needed for pdfjs in Node (fixes DOMMatrix undefined)
global.DOMMatrix = global.DOMMatrix || DOMMatrix;
global.ImageData = global.ImageData || ImageData;

const app = express();

/* =========================
   CORS + BODY
========================= */
app.use(cors()); // ok for now
app.use(express.json({ limit: "2mb" }));

/* =========================
   STATIC FRONTEND (public/)
   Put index.html inside /public
========================= */
app.use(express.static(path.join(__dirname, "public")));

/* =========================
   HEALTH
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Backend is running ✅" });
});

/* =========================
   UPLOAD (PDF in memory)
========================= */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 }, // 12MB
});

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "models/gemini-2.5-flash";

/* =========================
   GEMINI CALL
========================= */
async function geminiGenerate({ contents, generationConfig }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      status: 500,
      data: { error: { message: "Missing GEMINI_API_KEY in environment variables" } },
    };
  }

  const url = `https://generativelanguage.googleapis.com/v1/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  const raw = await resp.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    // If Gemini ever returns non-json, keep raw snippet
    data = { error: { message: "Non-JSON response from Gemini", raw: raw.slice(0, 500) } };
  }

  return { ok: resp.ok, status: resp.status, data };
}

function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: 'Learn Beyond Books'. " +
    "Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). " +
    "4) Use emojis. 5) End with: Do you want any changes? 👇";

  if (mode === "study")
    return base + " Mode: Study Plan. Make a clear daily plan with checklist + resources.";
  if (mode === "resume")
    return base + " Mode: Resume Helper. Improve ATS bullets, rewrite summary, suggest skills, ask 1 follow-up question.";
  if (mode === "projects")
    return base + " Mode: Project Ideas. Give 6-8 ideas (Easy/Medium/Hard) with stack + features + learning outcome.";

  return base + " Mode: General.";
}

/* =========================
   PDF -> PNG PAGES (for scanned/image PDFs)
   Uses pdfjs-dist legacy ESM via dynamic import
========================= */
async function pdfToPngBuffers(pdfBuffer, maxPages = 3, scale = 2.0) {
  // ✅ pdfjs-dist v5 uses ESM. This is the correct way in CJS:
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfjsLib = pdfjs.default || pdfjs;

  // Important in Node: disable worker
  const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer, disableWorker: true });
  const pdfDoc = await loadingTask.promise;

  const pages = Math.min(pdfDoc.numPages, maxPages);
  const images = [];

  for (let i = 1; i <= pages; i++) {
    const page = await pdfDoc.getPage(i);
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");

    await page.render({ canvasContext: ctx, viewport }).promise;

    const png = canvas.toBuffer("image/png");
    images.push({ page: i, buffer: png });
  }

  return { numPages: pdfDoc.numPages, images };
}

/* =========================
   CHAT
========================= */
app.post("/api/chat", async (req, res, next) => {
  try {
    const { message, history = [], mode = "general" } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "message is required (string)" });
    }

    const safeHistory = Array.isArray(history)
      ? history.filter(
          (h) => h && (h.role === "user" || h.role === "model") && Array.isArray(h.parts)
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
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const reply =
      result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";

    res.json({ reply, model_used: GEMINI_MODEL });
  } catch (err) {
    next(err);
  }
});

/* =========================
   PDF SUMMARIZER
   - Try pdf-parse text
   - If no text -> render 1-3 pages to PNG and send to Gemini Vision
========================= */
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    if (req.file.mimetype !== "application/pdf") return res.status(400).json({ error: "Only PDF files are allowed" });

    // 1) Try extracting selectable text
    const parsed = await pdfParse(req.file.buffer);
    let text = (parsed.text || "").trim();

    const promptHeader =
      "Summarize this PDF for a student. Output format:\n" +
      "-> 5 key takeaways\n" +
      "-> Important definitions\n" +
      "-> Short notes\n" +
      "-> 10 important questions\n" +
      "-> Ask 3 follow-up questions\n" +
      "End with: Do you want any changes? 👇\n\n";

    // If text exists -> summarize normally
    if (text && text.length >= 120) {
      const maxChars = 35000;
      const clipped = text.length > maxChars ? text.slice(0, maxChars) : text;

      const result = await geminiGenerate({
        contents: [{ role: "user", parts: [{ text: promptHeader + "PDF TEXT:\n" + clipped }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
      });

      if (!result.ok) {
        return res.status(result.status).json({
          error: result.data?.error?.message || "Gemini API error",
          details: result.data,
        });
      }

      const summary =
        result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";

      return res.json({ summary, used_vision: false });
    }

    // 2) No/low text -> Vision fallback (render pages to images)
    const { numPages, images } = await pdfToPngBuffers(req.file.buffer, 3, 2.0);

    if (!images.length) {
      return res.status(400).json({ error: "Could not read PDF pages for vision summary." });
    }

    const parts = [
      { text: promptHeader + "The PDF is scanned / image-based. Read the pages and summarize clearly.\n" },
      ...images.map((img) => ({
        inline_data: {
          mime_type: "image/png",
          data: img.buffer.toString("base64"),
        },
      })),
      { text: `\nPages included: ${images.length}. Total pages in PDF: ${numPages}.` },
    ];

    const result = await geminiGenerate({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2000 },
    });

    if (!result.ok) {
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary =
      result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No summary generated.";

    return res.json({ summary, used_vision: true, pages_used: images.length, total_pages: numPages });
  } catch (err) {
    next(err);
  }
});

/* =========================
   JSON ERROR HANDLER (IMPORTANT!)
   This prevents HTML error pages for /api/*
========================= */
app.use((err, req, res, next) => {
  console.error("❌ SERVER ERROR:", err);

  // Always return JSON for API routes
  if (req.path.startsWith("/api/") || req.path === "/health") {
    return res.status(500).json({ error: err.message || "Internal Server Error" });
  }

  // For non-api pages
  res.status(500).send("Internal Server Error");
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => console.log("✅ Server running on port", PORT));