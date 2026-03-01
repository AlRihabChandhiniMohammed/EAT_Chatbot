const express = require("express");
const cors = require("cors");
const multer = require("multer");
const pdfParse = require("pdf-parse"); // ✅ pdf-parse@1.1.1
require("dotenv").config();


const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
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
  const url = `https://generativelanguage.googleapis.com/v1/${modelName}:generateContent?key=${GEMINI_API_KEY}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents, generationConfig }),
  });

  const data = await resp.json();
  return { ok: resp.ok, status: resp.status, data };
}

// ---- Mode prompts ----
function buildSystemPrompt(mode) {
  const base =
    "You are Edualttech AI. Motto: 'Learn Beyond Books'. Rules: 1) Be concise. 2) Use '->' for lists. 3) NO markdown bold (** or *). 4) Use emojis. 5) Focus on alternative learning and tech. 6) End with: 'Do you want any changes? 👇'";

  if (mode === "study") {
    return base +
      " Mode: Study Plan. Make a clear plan with daily tasks, time estimates, resources, and checklist.";
  }
  if (mode === "resume") {
    return base +
      " Mode: Resume Helper. Improve ATS bullets using action verbs + metrics, rewrite summary, suggest skills, and ask 1 follow-up question.";
  }
  if (mode === "projects") {
    return base +
      " Mode: Project Ideas. Give 6-8 ideas: Easy/Medium/Hard, include stack, features, and what student learns.";
  }
  return base + " Mode: General assistant.";
}

// ============ CHAT ============
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [], mode = "general" } = req.body;

    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY in backend/.env" });
    }

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
        maxOutputTokens: 2000, // ✅ bigger so it won’t cut off
      },
    });

    if (!result.ok) {
      console.error("❌ Gemini error:", JSON.stringify(result.data, null, 2));
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
    console.error("❌ Server crash:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ============ PDF SUMMARIZE ============
app.post("/api/summarize-pdf", upload.single("pdf"), async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: "Missing GEMINI_API_KEY in backend/.env" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No PDF uploaded (field name must be 'pdf')" });
    }

    if (req.file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only PDF files are allowed" });
    }

    const parsed = await pdfParse(req.file.buffer);
    const text = (parsed.text || "").trim();

    if (!text) {
      return res.status(400).json({
        error: "Could not extract text from this PDF (maybe scanned image PDF).",
      });
    }

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
        maxOutputTokens: 2000, // ✅ bigger output
      },
    });

    if (!result.ok) {
      console.error("❌ Gemini PDF error:", JSON.stringify(result.data, null, 2));
      return res.status(result.status).json({
        error: result.data?.error?.message || "Gemini API error",
        details: result.data,
      });
    }

    const summary =
      result.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No summary generated.";

    return res.json({ summary, extracted_chars: clipped.length });
  } catch (err) {
    console.error("❌ PDF summarize error:", err);
    return res.status(500).json({ error: err.message });
  }
});
const PORT = process.env.PORT || 8001;
app.listen(PORT, "0.0.0.0", () => {
  console.log("Running on port", PORT);
});

