import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.AWS_S3_BUCKET;

function streamToBuffer(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
}

async function containsApplicationForm(buffer) {
    try {
        const data = await pdfParse(buffer);
        return data.text && data.text.includes('Application for Insurance');
    } catch (err) {
        // fallback: búsqueda básica por texto
        const text = buffer.toString('utf8');
        return text.includes('Application for Insurance');
    }
}

async function detectCarrier(buffer) {
    try {
        const data = await pdfParse(buffer);
        if (data.text.includes('progressive')) {
            return 'progressive';
        }
    }
    catch (err) {
        console.log('Error al detectar carrier:', err);
    }
    return null;
}

export async function determineApplication(customerId) {
    if (!customerId) {
        throw new Error('customerId es requerido');
    }

    if (!BUCKET) {
        throw new Error('AWS_S3_BUCKET no configurado');
    }

    // 1️⃣ Listar objetos bajo el prefijo del customer
    const list = await s3.send(
        new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${customerId}/`
        })
    );

    if (!list.Contents || list.Contents.length === 0) {
        return { found: false };
    }

    // 2️⃣ Filtrar PDFs
    const pdfs = list.Contents
        .filter(obj => obj.Key && obj.Key.toLowerCase().endsWith('.pdf'));

    if (pdfs.length === 0) {
        return { found: false };
    }

    // 3️⃣ Revisar cada PDF hasta encontrar uno válido
    for (const file of pdfs) {
        const fileObj = await s3.send(
            new GetObjectCommand({
                Bucket: BUCKET,
                Key: file.Key
            })
        );
        const buffer = await streamToBuffer(fileObj.Body);
        if (await containsApplicationForm(buffer)) {
            const s3Url = `https://${BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${file.Key}`;
            const carrier = await detectCarrier(buffer);
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

// Check a single S3 file by key for application form and carrier
export async function checkSingleFile(s3Url) {
    if (!s3Url) return { found: false };
    if (!BUCKET) throw new Error('AWS_S3_BUCKET no configurado');
    // Always expects a full S3 URL, extract the key
    const match = s3Url.match(/\.amazonaws\.com\/(.+)$/);
    console.log('[checkSingleFile] Checking S3 URL for application:', match ? match[1] : 'No match');
    const fileKey = match ? match[1] : null;
    if (!fileKey) return { found: false };
    const fileObj = await s3.send(
        new GetObjectCommand({
            Bucket: BUCKET,
            Key: fileKey
        })
    );
    const buffer = await streamToBuffer(fileObj.Body);
    if (await containsApplicationForm(buffer)) {
        const carrier = await detectCarrier(buffer);
        return {
            found: true,
            fileKey,
            s3Url,
            carrier
        };
    }
    return { found: false };
}