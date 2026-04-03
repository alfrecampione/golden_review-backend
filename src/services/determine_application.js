import 'dotenv/config';
import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from '../lib/s3.js';

import { PDFParse } from 'pdf-parse';

const BASE_APPLICATION_KEYWORDS = ['application for insurance'];
const CARRIER_FLOW_BY_ID = {
    // Initial mapping: carrier 2 should use Progressive flow.
    '2': 'progressive',
};

const FLOW_REQUIRED_KEYWORDS = {
    progressive: ['progressiveagent'],
};

function parseKeywordsByCarrierFromEnv() {
    const raw = process.env.APPLICATION_KEYWORDS_BY_CARRIER;
    if (!raw) return {};

    try {
        const parsed = JSON.parse(raw);
        const entries = Object.entries(parsed || {});
        const normalized = {};

        for (const [carrierId, keywords] of entries) {
            if (!Array.isArray(keywords)) continue;
            normalized[String(carrierId)] = keywords
                .map((k) => String(k || '').toLowerCase().trim())
                .filter(Boolean);
        }

        return normalized;
    } catch (err) {
        console.error('[determine_application] Invalid APPLICATION_KEYWORDS_BY_CARRIER JSON:', err);
        return {};
    }
}

const KEYWORDS_BY_CARRIER = parseKeywordsByCarrierFromEnv();

function resolveCarrierFlow(carrierId) {
    if (carrierId == null) return null;
    return CARRIER_FLOW_BY_ID[String(carrierId)] || null;
}

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}


async function extractText(buffer) {
    const parser = new PDFParse({ data: buffer });
    try {
        const result = await parser.getText();
        return result?.text?.toLowerCase() || '';
    } finally {
        await parser.destroy();
    }
}

function detectCarrierFromText(text) {
    if (text.includes('progressive')) {
        return 'progressive';
    }
    return null;
}

function buildRequiredKeywords(options = {}) {
    const carrierId = options?.carrierId != null ? String(options.carrierId) : null;
    const flow = resolveCarrierFlow(carrierId);
    const flowKeywords = flow ? (FLOW_REQUIRED_KEYWORDS[flow] || []) : [];
    const carrierKeywords = carrierId ? (KEYWORDS_BY_CARRIER[carrierId] || []) : [];
    const explicitKeywords = Array.isArray(options?.requiredKeywords)
        ? options.requiredKeywords
        : [];

    return [...new Set([
        ...BASE_APPLICATION_KEYWORDS,
        ...flowKeywords,
        ...carrierKeywords,
        ...explicitKeywords
            .map((k) => String(k || '').toLowerCase().trim())
            .filter(Boolean),
    ])];
}

function matchesAllKeywords(text, requiredKeywords) {
    return requiredKeywords.every((keyword) => text.includes(keyword));
}

function normalizePolicyNumber(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function matchesPolicyNumber(text, policyNumber) {
    if (!policyNumber) {
        return true;
    }

    const normalizedText = normalizePolicyNumber(text);
    const normalizedPolicy = normalizePolicyNumber(policyNumber);

    if (!normalizedPolicy) {
        return true;
    }

    return normalizedText.includes(normalizedPolicy);
}

export async function determineApplication(customerId, options = {}) {

    if (!customerId) throw new Error('customerId es requerido');
    if (!BUCKET) throw new Error('AWS_S3_BUCKET no configurado');

    const list = await s3.send(
        new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${customerId}/`
        })
    );

    if (!list.Contents?.length) {
        return { found: false };
    }

    const pdfs = list.Contents
        .filter(obj => obj.Key?.toLowerCase().endsWith('.pdf'));

    if (!pdfs.length) {
        return { found: false };
    }

    const requiredKeywords = buildRequiredKeywords(options);

    for (const file of pdfs) {

        const fileObj = await s3.send(
            new GetObjectCommand({
                Bucket: BUCKET,
                Key: file.Key
            })
        );

        const buffer = await streamToBuffer(fileObj.Body);
        const text = await extractText(buffer);

        if (matchesAllKeywords(text, requiredKeywords)) {

            const carrier = detectCarrierFromText(text);

            const s3Url =
                `https://${BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${file.Key}`;

            return {
                found: true,
                fileKey: file.Key,
                s3Url,
                carrier
            };
        }
    }

    return { found: false };
}

export async function checkSingleFile(s3Url, options = {}) {

    if (!s3Url) return { found: false };
    if (!BUCKET) throw new Error('AWS_S3_BUCKET no configurado');

    const match = s3Url.match(/\.amazonaws\.com\/(.+)$/);
    const fileKey = match?.[1];

    if (!fileKey) return { found: false };

    const fileObj = await s3.send(
        new GetObjectCommand({
            Bucket: BUCKET,
            Key: fileKey
        })
    );

    const buffer = await streamToBuffer(fileObj.Body);
    const text = await extractText(buffer);

    const requiredKeywords = buildRequiredKeywords(options);
    const policyNumber = options?.policyNumber != null
        ? String(options.policyNumber)
        : null;

    if (matchesAllKeywords(text, requiredKeywords)) {
        if (!matchesPolicyNumber(text, policyNumber)) {
            return { found: false };
        }

        return {
            found: true,
            fileKey,
            s3Url,
            matchedKeywords: requiredKeywords,
            matchedPolicyNumber: policyNumber,
        };
    }

    return { found: false };
}
