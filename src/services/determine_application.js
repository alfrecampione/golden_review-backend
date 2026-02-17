import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { invokePdfLambda } from './lambdaInvoke.js';
import pdfParse from 'pdf-parse';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.S3_BUCKET;

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
        return data.text && data.text.includes('Application Form');
    } catch (err) {
        // fallback: búsqueda básica por texto
        const text = buffer.toString('utf8');
        return text.includes('Application Form');
    }
}

export async function determineApplication(customerId) {
    if (!customerId) {
        throw new Error('customerId es requerido');
    }

    if (!BUCKET) {
        throw new Error('S3_BUCKET no configurado');
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
            return {
                found: true,
                fileKey: file.Key,
                s3Url
            };
        }
    }

    return { found: false };
}