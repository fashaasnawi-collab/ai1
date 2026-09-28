# NEXA AI Backend

Backend proxy sederhana untuk NEXA AI + Gemini API.

## Struktur

```text
nexa-ai-backend/
├── package.json
├── server.js
├── .env.example
├── .gitignore
└── README.md
```

## Jalankan lokal

Pastikan Node.js 20+.

```bash
npm install
```

Salin `.env.example` menjadi `.env`, lalu isi:

```env
GEMINI_API_KEY=API_KEY_KAMU
GEMINI_MODEL=gemini-2.5-flash
PORT=10000
MAX_CONCURRENT_REQUESTS=1
MAX_QUEUE_SIZE=20
MAX_IMAGE_MB=10
CORS_ORIGIN=*
```

Jalankan:

```bash
npm start
```

Health check:

```text
http://localhost:10000/api/health
```

## Endpoint

### GET /api/health

Mengecek backend.

### GET /api/status

Menampilkan status backend tanpa membocorkan API key.

### POST /api/ask

JSON:

```json
{
  "requestId": "nexa_request_123",
  "question": "Apa itu fotosintesis?"
}
```

### POST /api/analyze-image

`multipart/form-data`:

- `image`: file gambar
- `question`: pertanyaan
- `requestId`: ID request
- `photoId`: ID foto

## Render

Buat Web Service dari repository GitHub.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Environment Variables di Render:

```text
GEMINI_API_KEY=API_KEY_KAMU
GEMINI_MODEL=gemini-2.5-flash
MAX_CONCURRENT_REQUESTS=1
MAX_QUEUE_SIZE=20
MAX_IMAGE_MB=10
CORS_ORIGIN=*
```

Jangan commit `.env` ke GitHub.

## Catatan keamanan

API key hanya berada di backend environment variable.
Jangan memasukkan API key ke source code Android atau GitHub.

Untuk production, ganti `CORS_ORIGIN=*` dengan origin yang memang diperlukan.
