# Attendance Card AI Extractor

A web application powered by **Google Gemini Vision LLM** to automatically extract handwritten employee attendance cards into structured CSV files.

## Features
- **Individual Page JPEG Conversion**: Converts every preview item `objectUrl` into an individual ~120KB JPEG File object, preventing raw uncompressed PDF files from being duplicated in FormData requests.
- **Micro-Payload Batching**: Sends 2 lightweight page JPEG images per request (~240KB total payload), well below Vercel's 4.5MB serverless limit.
- **Robust Server Response Handling**: Reads `res.text()` first to handle non-JSON Gateway responses cleanly without throwing syntax errors.
- **Count-Aware Model Escalation**: Computes `expectedMinCards = Math.ceil(pageCount / 2)` and escalates models if an undercounted result is produced.
- **1-Click CSV Export**: Downloads formatted CSVs for payroll ingestion (`Emp ID`, `Month`, `Year`, `Date`, `Time In`, `Time Out`).

## Vercel Deployment
1. Import this repository in [Vercel](https://vercel.com/new).
2. Set Environment Variable: `GEMINI_API_KEY` = `your_google_ai_studio_api_key`.
3. Deploy!
