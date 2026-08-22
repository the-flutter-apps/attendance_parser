import express from 'express';
import multer from 'multer';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Pinned Vision Model Hierarchy
//
// gemini-3.7-flash is the newest flash build this key can reach. 3.5-flash stays
// as the FIRST fallback rather than being dropped: it is the only model in this
// list empirically proven to read these cards (a real Harika card extracted on
// it against the live key), so if the newer model reads them less well the chain
// lands straight back on the known-good one rather than on a pro model.
const PRIMARY_VISION_MODEL = 'gemini-3.5-flash';
const ESCALATION_VISION_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-2.5-pro',
  // Kept as -preview because that is what this API key can actually reach.
  // A plain 'gemini-3.1-pro' was tried and returns 404 "not found for API
  // version v1beta"; /api/models lists gemini-3.1-pro-preview and
  // gemini-3.1-pro-preview-customtools, with no GA build. Verified against the
  // live key rather than assumed — the preview suffix is not a leftover.
  'gemini-3.1-pro-preview'
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Which models this API key can actually reach.
//
// The pinned list is deliberately deterministic, but a pin can go stale without
// warning: gemini-2.0-flash was retired in June 2026 and every extraction failed
// until someone noticed. A 404 on a model reads identically to a broken
// migration, so being able to ask the API directly turns a guess into a fact.
app.get('/api/models', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'No API key configured.' });
  try {
    const genAI = new GoogleGenAI({ apiKey });
    const out = [];
    const pager = await genAI.models.list();
    for await (const m of pager) {
      const name = (m.name || '').replace(/^models\//, '');
      const actions = m.supportedActions || m.supportedGenerationMethods || [];
      if (!actions.length || actions.includes('generateContent')) out.push(name);
    }
    const pinned = [PRIMARY_VISION_MODEL, ...ESCALATION_VISION_MODELS];
    res.json({
      pinned,
      // The bit that matters: which of OUR pins are actually reachable.
      pinnedAvailable: pinned.filter(p => out.includes(p)),
      pinnedMissing: pinned.filter(p => !out.includes(p)),
      available: out.sort()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', (req, res) => {
  const hasEnvKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here');
  res.json({
    hasEnvKey,
    primaryModel: PRIMARY_VISION_MODEL,
    escalationModels: ESCALATION_VISION_MODELS
  });
});

// JSON Schema definition for Gemini response
const attendanceSchema = {
  type: Type.OBJECT,
  properties: {
    cards: {
      type: Type.ARRAY,
      description: "List of ALL distinct employee attendance cards found in the uploaded file(s)",
      items: {
        type: Type.OBJECT,
        properties: {
          employee_id: { type: Type.STRING, description: "Emp ID (e.g. 1055) or full name if Emp ID is missing" },
          employee_name: { type: Type.STRING, description: "Employee name from card header" },
          month: { type: Type.STRING, description: "Month name (e.g. July)" },
          year: { type: Type.STRING, description: "Year (e.g. 2026)" },
          has_page1: { type: Type.BOOLEAN, description: "True if Days 1-16 (Page 1) scan is present" },
          has_page2: { type: Type.BOOLEAN, description: "True if Days 17-31 (Page 2) scan is present" },
          records: {
            type: Type.ARRAY,
            description: "Daily attendance rows",
            items: {
              type: Type.OBJECT,
              properties: {
                date: { type: Type.INTEGER, description: "Day of month (1 to 31)" },
                shift: { type: Type.STRING, description: "Shift code (e.g., A, B, C, A+B, B+C, W/O, OFF)" },
                time_in: { type: Type.STRING, description: "Time In in HH:MM 24h format or empty string" },
                time_out: { type: Type.STRING, description: "Time Out in HH:MM 24h format or empty string" },
                ot_hours: { type: Type.STRING, description: "OT Hours if recorded or empty string" }
              },
              required: ["date", "time_in", "time_out"]
            }
          }
        },
        required: ["employee_id", "month", "year", "records"]
      }
    }
  },
  required: ["cards"]
};

// Safely extract valid JSON object substring from AI output text
function parseCleanJsonObject(rawText) {
  let text = rawText.trim();
  text = text.replace(/```json/gi, '').replace(/```/g, '').trim();

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(text);
}

// Deterministic backend deduplication & employee card merging
function sanitizeAndDeduplicateCards(rawCards) {
  if (!Array.isArray(rawCards)) return [];

  const employeeMap = new Map();
  let unknownCounter = 1;

  rawCards.forEach(rawCard => {
    const idTrim = (rawCard.employee_id || '').trim();
    const nameTrim = (rawCard.employee_name || '').trim();
    const rawKey = (idTrim || nameTrim).toLowerCase().replace(/[^a-z0-9]/g, '');
    const isBlankOrUnknown = !rawKey || rawKey === 'unknown';

    let groupKey;
    if (isBlankOrUnknown) {
      groupKey = `__unknown_${unknownCounter++}`;
    } else {
      groupKey = rawKey;
    }

    if (!employeeMap.has(groupKey)) {
      employeeMap.set(groupKey, {
        employee_id: idTrim || nameTrim || `UNKNOWN_${unknownCounter}`,
        employee_name: nameTrim || idTrim || 'Unknown Employee',
        month: rawCard.month || 'July',
        year: rawCard.year || '2026',
        has_page1: rawCard.has_page1 !== false,
        has_page2: rawCard.has_page2 !== false,
        recordsMap: new Map()
      });
    } else {
      const existingCard = employeeMap.get(groupKey);
      existingCard.has_page1 = existingCard.has_page1 || (rawCard.has_page1 !== false);
      existingCard.has_page2 = existingCard.has_page2 || (rawCard.has_page2 !== false);
    }

    const empObj = employeeMap.get(groupKey);

    if (rawCard.records && Array.isArray(rawCard.records)) {
      rawCard.records.forEach(rec => {
        const dateNum = parseInt(rec.date, 10);
        if (dateNum >= 1 && dateNum <= 31) {
          const existing = empObj.recordsMap.get(dateNum);
          if (!existing || (rec.time_in || rec.time_out)) {
            empObj.recordsMap.set(dateNum, {
              date: dateNum,
              shift: rec.shift || '',
              time_in: rec.time_in || '',
              time_out: rec.time_out || '',
              ot_hours: rec.ot_hours || ''
            });
          }
        }
      });
    }
  });

  const cleanCards = [];
  for (const empObj of employeeMap.values()) {
    const sortedRecords = Array.from(empObj.recordsMap.values())
      .sort((a, b) => a.date - b.date);

    cleanCards.push({
      employee_id: empObj.employee_id,
      employee_name: empObj.employee_name,
      month: empObj.month,
      year: empObj.year,
      has_page1: empObj.has_page1,
      has_page2: empObj.has_page2,
      records: sortedRecords
    });
  }

  return cleanCards;
}

app.post('/api/extract', upload.array('files', 10), async (req, res) => {
  try {
    const userApiKey = req.headers['x-api-key'] || req.body.apiKey;
    const apiKey = userApiKey || process.env.GEMINI_API_KEY;

    if (!apiKey || apiKey === 'your_gemini_api_key_here') {
      return res.status(400).json({
        error: 'Missing Gemini API Key. Please provide an API key in the UI settings header or in server .env file.'
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No image or PDF files were uploaded.' });
    }

    const pageCount = parseInt(req.body.pageCount || '0', 10) || 0;
    const expectedMinCards = pageCount > 0 ? Math.ceil(pageCount / 2) : 1;

    // @google/genai takes an options object; the old SDK took the key positionally.
    const genAI = new GoogleGenAI({ apiKey });

    const modelsToTry = [
      PRIMARY_VISION_MODEL,
      ...ESCALATION_VISION_MODELS
    ];

    const contentsParts = [];
    for (const file of req.files) {
      contentsParts.push({
        inlineData: {
          mimeType: file.mimetype,
          data: file.buffer.toString('base64')
        }
      });
    }

    const systemPrompt = `You are an expert OCR extraction assistant specialized in handwritten yellow employee attendance cards for factory/boiler contractors.
The upload may contain cards for MULTIPLE DIFFERENT EMPLOYEES. Each employee's card usually spans TWO pages: Page 1 = Days 1–16, Page 2 = Days 17–31.

IDENTITY RULES:
1. Look for printed/written "EMP 10XX" / "EMP XXXX" or "Emp ID" at top of page or card header. Use that as employee_id.
2. If "Emp ID" is blank or missing, use the handwritten Name (e.g. "B. Appalanaidu", "J. Chinna MALLESH", "B. Satya Rao", "G. Yeeri Naidu", "S. Sanyasi Rao").
3. Output ONE card object per DISTINCT employee. Merge Page 1 (Days 1–16) and Page 2 (Days 17–31) belonging to the same person into a single card object.

TIME & SHIFT NORMALIZATION RULES:
1. Always format times into 24-hour HH:MM strings (e.g. "06:00", "14:00", "22:00", "06:12", "21:45", "14:12").
2. Convert 4-digit handwritten numbers without colons into HH:MM (e.g. "2200"->"22:00", "0600"->"06:00", "1400"->"14:00", "2208"->"22:08", "0625"->"06:25").
3. Recognize standard factory shifts:
   - Shift A -> 06:00 to 14:00
   - Shift B -> 14:00 to 22:00
   - Shift C -> 22:00 to 06:00
   - Shift A+B -> 06:00 to 22:00
   - Shift B+C -> 14:00 to 06:00
   - Shift A+C -> 06:00 to 14:00 (or 22:00 to 06:00)
4. OFF / REST DAYS:
   - For rows marked "W/O", "W", "wo", "w/off", "off", "-", or blank rows, set time_in to "" and time_out to "".
5. Each date 1–31 appears AT MOST ONCE per card. Do not duplicate any date.

Return ONLY a single valid JSON object matching the schema, with a "cards" array containing every distinct employee.`;

    // An explicit text part. The old SDK accepted a bare string in the array;
    // being explicit costs nothing and removes the ambiguity.
    contentsParts.push({ text: systemPrompt });

    let bestResult = null;
    let lastError = null;

    for (const modelName of modelsToTry) {
      try {
        console.log(`Executing Vision OCR using model: ${modelName} (pageCount: ${pageCount}, expectedMinCards: ${expectedMinCards})...`);
        let rawCards = null;

        try {
          // One call: the model moves into the request and the generation
          // options move under `config`. Note response.text is a GETTER, not a
          // method —
          // calling it would throw "text is not a function".
          const result = await genAI.models.generateContent({
            model: modelName,
            contents: contentsParts,
            config: {
              responseMimeType: 'application/json',
              responseSchema: attendanceSchema,
              temperature: 0.0
            }
          });
          const responseText = result.text;
          const parsed = parseCleanJsonObject(responseText);
          rawCards = parsed.cards || [];
        } catch (schemaErr) {
          console.warn(`Schema mode fallback for ${modelName}:`, schemaErr.message);
          const result = await genAI.models.generateContent({
            model: modelName,
            contents: contentsParts,
            config: {
              responseMimeType: 'application/json',
              temperature: 0.0
            }
          });
          const responseText = result.text;
          const parsed = parseCleanJsonObject(responseText);
          rawCards = parsed.cards || [];
        }

        const sanitized = sanitizeAndDeduplicateCards(rawCards);
        console.log(`Model ${modelName} produced ${sanitized.length} sanitized card(s).`);

        if (sanitized.length > 0) {
          if (!bestResult || sanitized.length > bestResult.cards.length) {
            bestResult = { cards: sanitized, modelUsed: modelName };
          }

          if (sanitized.length >= expectedMinCards) {
            console.log(`Model ${modelName} satisfied expected card count (${sanitized.length} >= ${expectedMinCards}). Final model selected: ${modelName}`);
            break;
          } else {
            console.log(`Model ${modelName} produced ${sanitized.length} card(s), below expected ${expectedMinCards}. Escalating to next model...`);
          }
        }
      } catch (err) {
        console.warn(`Model ${modelName} failed with error: ${err.message}`);
        lastError = err;
      }
    }

    if (!bestResult || !bestResult.cards || bestResult.cards.length === 0) {
      throw lastError || new Error('All configured Gemini models failed to process the request.');
    }

    console.log(`Extraction complete. Final chosen model: ${bestResult.modelUsed} with ${bestResult.cards.length} card(s).`);

    return res.json({
      success: true,
      modelUsed: bestResult.modelUsed,
      data: { cards: bestResult.cards }
    });

  } catch (error) {
    console.error('Extraction Error:', error);
    return res.status(500).json({
      error: error.message || 'Failed to process attendance card image with Gemini API.'
    });
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Attendance Extractor App running at: http://localhost:${PORT}`);
  console.log(`=======================================================`);
});
