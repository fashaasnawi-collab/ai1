require("dotenv").config();

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_CONCURRENT_REQUESTS = Math.max(
  1,
  Number(process.env.MAX_CONCURRENT_REQUESTS || 1)
);
const MAX_QUEUE_SIZE = Math.max(1, Number(process.env.MAX_QUEUE_SIZE || 20));
const MAX_IMAGE_MB = Math.max(1, Number(process.env.MAX_IMAGE_MB || 10));

if (!GEMINI_API_KEY) {
  console.warn("[NEXA] WARNING: GEMINI_API_KEY is not configured.");
}

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*"
  })
);
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_MB * 1024 * 1024
  }
});

// ------------------------------------------------------------
// Request queue: deliberately one active Gemini request at a time.
// ------------------------------------------------------------

let activeRequests = 0;
const queue = [];

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffMs(attempt) {
  // 2s, 4s, 8s, 16s + small jitter.
  const base = Math.min(16000, 2000 * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 400);
  return base + jitter;
}

async function runWithRetry(task, maxAttempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;

      const retryable = [408, 429, 500, 502, 503, 504].includes(
        Number(error.status)
      );

      if (!retryable || attempt >= maxAttempts) {
        throw error;
      }

      const delay = getBackoffMs(attempt);
      console.warn(
        `[NEXA][RETRY] status=${error.status} attempt=${attempt}/${maxAttempts} delay=${delay}ms`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

function enqueue(task, requestId) {
  return new Promise((resolve, reject) => {
    if (queue.length >= MAX_QUEUE_SIZE) {
      const error = new Error("NEXA AI queue is full.");
      error.status = 429;
      reject(error);
      return;
    }

    queue.push({ task, resolve, reject, requestId });
    processQueue();
  });
}

async function processQueue() {
  if (activeRequests >= MAX_CONCURRENT_REQUESTS) return;

  const item = queue.shift();
  if (!item) return;

  activeRequests++;

  console.log(
    `[NEXA][PROCESSING] requestId=${item.requestId} active=${activeRequests} queue=${queue.length}`
  );

  try {
    const result = await item.task();
    item.resolve(result);
  } catch (error) {
    item.reject(error);
  } finally {
    activeRequests--;
    setImmediate(processQueue);
  }
}

function safeErrorMessage(error) {
  const status = Number(error?.status || 500);

  if (status === 400) return "Permintaan tidak valid.";
  if (status === 401) return "API key tidak valid.";
  if (status === 403) return "API key/project tidak memiliki izin atau akses yang diperlukan.";
  if (status === 404) return "Model atau resource tidak ditemukan.";
  if (status === 408) return "Request timeout. Silakan coba lagi.";
  if (status === 429) return "Rate limit atau quota tercapai. Silakan tunggu lalu coba lagi.";
  if (status === 500) return "Gemini mengalami internal server error.";
  if (status === 502) return "Gateway Gemini bermasalah sementara.";
  if (status === 503) return "Gemini sedang tidak tersedia sementara. Request sudah mencoba retry.";
  if (status === 504) return "Gemini timeout. Silakan coba lagi.";

  return "Terjadi error saat memproses request.";
}

async function callGemini({ question, imageBase64, mimeType, requestId }) {
  if (!GEMINI_API_KEY) {
    const error = new Error("GEMINI_API_KEY is missing.");
    error.status = 500;
    throw error;
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const parts = [];

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType,
        data: imageBase64
      }
    });
  }

  parts.push({
    text: question || "Analisis gambar ini dan jelaskan secara singkat."
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts
        }
      ]
    })
  });

  const rawText = await response.text();

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    data = { raw: rawText };
  }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || `Gemini HTTP ${response.status}`
    );
    error.status = response.status;
    error.gemini = data?.error || data;
    throw error;
  }

  const answer =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("")
      .trim() || "";

  if (!answer) {
    const error = new Error("Gemini returned an empty answer.");
    error.status = 502;
    throw error;
  }

  console.log(
    `[NEXA][SUCCESS] requestId=${requestId} model=${GEMINI_MODEL}`
  );

  return {
    answer,
    model: GEMINI_MODEL
  };
}

// ------------------------------------------------------------
// Routes
// ------------------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "nexa-ai-backend",
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    activeRequests,
    queueSize: queue.length,
    maxConcurrentRequests: MAX_CONCURRENT_REQUESTS
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    provider: "Google Gemini API",
    apiKeyConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    activeRequests,
    queueSize: queue.length,
    maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
    maxQueueSize: MAX_QUEUE_SIZE
  });
});

app.post("/api/ask", async (req, res) => {
  const requestId = req.body?.requestId || makeId("nexa_request");
  const question = String(req.body?.question || "").trim();

  if (!question) {
    return res.status(400).json({
      ok: false,
      requestId,
      error: "Question is required."
    });
  }

  console.log(`[NEXA][REQUEST] requestId=${requestId} type=text`);

  try {
    const result = await enqueue(
      () =>
        runWithRetry(() =>
          callGemini({
            question,
            requestId
          })
        ),
      requestId
    );

    res.json({
      ok: true,
      requestId,
      ...result
    });
  } catch (error) {
    console.error(
      `[NEXA][FAILED] requestId=${requestId} status=${error.status || 500}`
    );

    res.status(Number(error.status) || 500).json({
      ok: false,
      requestId,
      status: Number(error.status) || 500,
      error: safeErrorMessage(error)
    });
  }
});

app.post("/api/analyze-image", upload.single("image"), async (req, res) => {
  const requestId = req.body?.requestId || makeId("nexa_request");
  const photoId = req.body?.photoId || makeId("nexa_photo");
  const question = String(
    req.body?.question || "Analisis gambar ini dan jelaskan apa yang kamu lihat."
  ).trim();

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      requestId,
      photoId,
      error: "Image is required."
    });
  }

  if (!req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({
      ok: false,
      requestId,
      photoId,
      error: "Uploaded file must be an image."
    });
  }

  const imageBase64 = req.file.buffer.toString("base64");
  const mimeType = req.file.mimetype;

  console.log(
    `[NEXA][REQUEST] requestId=${requestId} photoId=${photoId} type=image size=${req.file.size}`
  );

  try {
    const result = await enqueue(
      () =>
        runWithRetry(() =>
          callGemini({
            question,
            imageBase64,
            mimeType,
            requestId
          })
        ),
      requestId
    );

    res.json({
      ok: true,
      requestId,
      photoId,
      ...result
    });
  } catch (error) {
    console.error(
      `[NEXA][FAILED] requestId=${requestId} photoId=${photoId} status=${error.status || 500}`
    );

    res.status(Number(error.status) || 500).json({
      ok: false,
      requestId,
      photoId,
      status: Number(error.status) || 500,
      error: safeErrorMessage(error)
    });
  }
});

app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      ok: false,
      error: `Image terlalu besar. Maksimum ${MAX_IMAGE_MB} MB.`
    });
  }

  console.error("[NEXA][UNHANDLED]", err);

  res.status(500).json({
    ok: false,
    error: "Internal server error."
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[NEXA] Backend running on port ${PORT}`);
  console.log(`[NEXA] Model: ${GEMINI_MODEL}`);
  console.log(
    `[NEXA] Max concurrent requests: ${MAX_CONCURRENT_REQUESTS}`
  );
});
