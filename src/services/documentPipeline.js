import fs from 'fs';
import path from 'path';
import os from 'os';
import prisma from '../prisma.js';
import llm from './llmService.js';
import ocr from './ocrService.js';
import { DOCUMENT_TYPES, MIN_CONFIDENCE, getSchema, getInstructions } from './carrierConfig.js';

const TMP_DIR = os.tmpdir();

/* ── Prompts ─────────────────────────────────────── */

function buildClassificationPrompt(text) {
    return `You are an expert insurance document classifier.

A single PDF file may contain MULTIPLE documents concatenated together.
Analyze the full text and identify ALL distinct documents present.

For each document found, return its type and a confidence score.

Return JSON:
{
  "documents": [
    {
      "type": "declaration_page | application | id_card | other",
      "confidence": number (0-1),
      "carrier": "string (e.g. progressive, geico, state_farm, etc.) or null if unknown"
    }
  ]
}

Document type rules:
- declaration_page = policy summary / dec page showing coverages and premiums
- application = the carrier's application form for insurance with detailed policy data, drivers, vehicles, coverages, discounts, underwriting
- id_card = insurance ID card
- other = anything else

Important:
- A PDF can contain BOTH a declaration page AND an application
- Return ALL documents found, not just one
- Be specific about the carrier name (lowercase, underscored)

Text:
${text}`;
}

function buildExtractionPrompt(text, carrier) {
    const schema = getSchema(carrier);
    if (!schema) return null;

    return `You are an expert insurance document parser.

${getInstructions(carrier)}

Extract the data from the document below and return ONLY valid JSON matching this schema exactly:

${JSON.stringify(schema, null, 2)}

Rules:
- Missing fields → null
- Do NOT hallucinate or invent data
- Preserve the structure exactly as shown
- Keep raw values as they appear in the document (do not reformat dates, currency, etc.)
- For discounts: use "Policy" key for policy-level discounts, "Vehicle" key for vehicle-level discounts

Document:
${text}`;
}

/* ── File helpers ────────────────────────────────── */

function isPdf(file) {
    return file.s3_url && String(file.file_name_reported || '').toLowerCase().endsWith('.pdf');
}

async function downloadToLocal(fileId, s3Url) {
    const localPath = path.join(TMP_DIR, `${fileId}.pdf`);
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);

    const res = await fetch(s3Url);
    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(localPath, buffer);
    return buffer;
}

/* ── Core pipeline steps ─────────────────────────── */

async function classifyDocuments(text) {
    const result = await llm.invoke(buildClassificationPrompt(text), 500);
    return result?.documents ?? [];
}

async function extractApplicationData(text, carrier) {
    const prompt = buildExtractionPrompt(text, carrier);
    if (!prompt) return null;
    return llm.invoke(prompt, 4000);
}

/* ── Public API ──────────────────────────────────── */

async function processCustomerFiles({ customerId, carrierName, files }) {
    const results = [];

    for (const file of files) {
        if (!isPdf(file)) continue;

        const fileId = String(file.file_id);
        const buffer = await downloadToLocal(fileId, file.s3_url);
        if (!buffer) continue;

        const text = await ocr.extract(buffer);
        if (!text) continue;

        const documents = await classifyDocuments(text);

        for (const doc of documents) {
            if (doc.confidence < MIN_CONFIDENCE) continue;

            const carrier = doc.carrier || carrierName || 'progressive';
            let data = null;

            if (doc.type === DOCUMENT_TYPES.APPLICATION) {
                data = await extractApplicationData(text, carrier);
            }

            const saved = await prisma.customerDocument.create({
                data: {
                    customerId,
                    fileId,
                    type: doc.type,
                    carrier,
                    confidence: doc.confidence,
                    data: data || {},
                },
            });

            results.push({
                id: saved.id,
                customerId,
                fileId,
                type: doc.type,
                carrier,
                confidence: doc.confidence,
                data: data || {},
            });
        }
    }

    return results;
}

async function processSingleBuffer(buffer, carrierHint) {
    const text = await ocr.extract(buffer);
    if (!text) return [];

    const documents = await classifyDocuments(text);
    const results = [];

    for (const doc of documents) {
        if (doc.confidence < MIN_CONFIDENCE) continue;

        const carrier = doc.carrier || carrierHint || null;
        let data = null;

        if (doc.type === DOCUMENT_TYPES.APPLICATION && carrier) {
            data = await extractApplicationData(text, carrier);
        }

        results.push({
            type: doc.type,
            carrier,
            confidence: doc.confidence,
            data,
        });
    }

    return results;
}

export { processCustomerFiles, processSingleBuffer, DOCUMENT_TYPES };
