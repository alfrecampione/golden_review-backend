import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from '../lib/s3.js';
import prisma from '../prisma.js';
import llm from './llmService.js';
import { DOCUMENT_TYPES, MIN_CONFIDENCE, getSchema, getInstructions } from './carrierConfig.js';

const TMP_DIR = os.tmpdir();

/* ── Prompts ─────────────────────────────────────── */

function buildClassificationPrompt() {
    return `You are an expert insurance document classifier.

A single PDF file may contain MULTIPLE documents concatenated together.
Analyze the attached PDF document and identify ALL distinct documents present.

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
- Be specific about the carrier name (lowercase, underscored)`;
}

function buildExtractionPrompt(carrier) {
    const schema = getSchema(carrier);
    if (!schema) return null;

    return `You are an expert insurance document parser.

${getInstructions(carrier)}

Extract the data from the attached PDF document and return ONLY valid JSON matching this schema exactly:

${JSON.stringify(schema, null, 2)}

Rules:
- Missing fields → null
- Do NOT hallucinate or invent data
- Preserve the structure exactly as shown
- Keep raw values as they appear in the document (do not reformat dates, currency, etc.)
- For discounts: use "Policy" key for policy-level discounts, "Vehicle" key for vehicle-level discounts`;
}

/* ── File helpers ────────────────────────────────── */

function isPdf(file) {
    return file.s3_url && String(file.file_name_reported || '').toLowerCase().endsWith('.pdf');
}

function parseS3Key(s3Url) {
    try {
        const url = new URL(s3Url);
        return decodeURIComponent(url.pathname.replace(/^\//, ''));
    } catch {
        return null;
    }
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function downloadToLocal(fileId, s3Url) {
    const localPath = path.join(TMP_DIR, `${fileId}.pdf`);
    if (fs.existsSync(localPath)) return fs.readFileSync(localPath);

    const key = parseS3Key(s3Url);
    if (!key) return null;

    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const buffer = await streamToBuffer(res.Body);
    fs.writeFileSync(localPath, buffer);
    return buffer;
}

/* ── Core pipeline steps ─────────────────────────── */

async function classifyDocuments(pdfBuffer) {
    const result = await llm.invokeWithPdf(pdfBuffer, buildClassificationPrompt(), 500);
    return result?.documents ?? [];
}

async function extractApplicationData(pdfBuffer, carrier) {
    const prompt = buildExtractionPrompt(carrier);
    if (!prompt) return null;
    return llm.invokeWithPdf(pdfBuffer, prompt, 4000);
}

/* ── Public API ──────────────────────────────────── */

async function processCustomerFiles({ customerId, carrierName, files }) {
    const pdfFiles = files.filter(isPdf);
    console.log(`[Pipeline] Starting audit for customer ${customerId} | ${pdfFiles.length} PDF(s) of ${files.length} total files | carrierHint=${carrierName || 'none'}`);
    const results = [];

    for (const file of files) {
        if (!isPdf(file)) continue;

        const fileId = String(file.file_id);
        console.log(`[Pipeline] Downloading file ${fileId} (${file.file_name_reported})`);
        const buffer = await downloadToLocal(fileId, file.s3_url);
        if (!buffer) {
            console.warn(`[Pipeline] Download failed for file ${fileId}, skipping`);
            continue;
        }
        console.log(`[Pipeline] Downloaded file ${fileId} (${(buffer.length / 1024).toFixed(1)} KB)`);

        console.log(`[Pipeline] Classifying documents in file ${fileId}...`);
        const documents = await classifyDocuments(buffer);
        console.log(`[Pipeline] Classification result for file ${fileId}: ${documents.length} document(s) found`, documents.map(d => `${d.type} (${d.carrier}, conf=${d.confidence})`));

        for (const doc of documents) {
            if (doc.confidence < MIN_CONFIDENCE) {
                console.log(`[Pipeline] Skipping ${doc.type} (conf=${doc.confidence} < ${MIN_CONFIDENCE})`);
                continue;
            }

            const carrier = doc.carrier || carrierName || 'progressive';
            let data = null;

            if (doc.type === DOCUMENT_TYPES.APPLICATION) {
                console.log(`[Pipeline] Extracting application data for carrier=${carrier} from file ${fileId}...`);
                data = await extractApplicationData(buffer, carrier);
                console.log(`[Pipeline] Extraction complete for file ${fileId} | data=${data ? 'OK' : 'null'}`);
            }

            console.log(`[Pipeline] Saving document: type=${doc.type}, carrier=${carrier}, fileId=${fileId}`);
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
            console.log(`[Pipeline] Saved document id=${saved.id}`);

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

    console.log(`[Pipeline] Audit complete for customer ${customerId} | ${results.length} document(s) processed`);
    return results;
}

async function processSingleBuffer(buffer, carrierHint) {
    console.log(`[Pipeline] processSingleBuffer | size=${(buffer.length / 1024).toFixed(1)} KB | carrierHint=${carrierHint || 'none'}`);

    console.log('[Pipeline] Classifying documents...');
    const documents = await classifyDocuments(buffer);
    console.log(`[Pipeline] Classification result: ${documents.length} document(s) found`, documents.map(d => `${d.type} (${d.carrier}, conf=${d.confidence})`));
    const results = [];

    for (const doc of documents) {
        if (doc.confidence < MIN_CONFIDENCE) {
            console.log(`[Pipeline] Skipping ${doc.type} (conf=${doc.confidence} < ${MIN_CONFIDENCE})`);
            continue;
        }

        const carrier = doc.carrier || carrierHint || null;
        let data = null;

        if (doc.type === DOCUMENT_TYPES.APPLICATION && carrier) {
            console.log(`[Pipeline] Extracting application data for carrier=${carrier}...`);
            data = await extractApplicationData(buffer, carrier);
            console.log(`[Pipeline] Extraction complete | data=${data ? 'OK' : 'null'}`);
        }

        results.push({
            type: doc.type,
            carrier,
            confidence: doc.confidence,
            data,
        });
    }

    console.log(`[Pipeline] processSingleBuffer done | ${results.length} document(s) processed`);
    return results;
}

export { processCustomerFiles, processSingleBuffer, DOCUMENT_TYPES };
