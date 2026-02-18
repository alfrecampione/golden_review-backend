import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import pdfParseModule from 'pdf-parse';

const { PDFParse } = pdfParseModule;

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

export async function determineApplication(customerId) {

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

    for (const file of pdfs) {

        const fileObj = await s3.send(
            new GetObjectCommand({
                Bucket: BUCKET,
                Key: file.Key
            })
        );

        const buffer = await streamToBuffer(fileObj.Body);
        const text = await extractText(buffer);

        if (text.includes('application for insurance')) {

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

export async function checkSingleFile(s3Url) {

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

    if (text.includes('application for insurance')) {

        return {
            found: true,
            fileKey,
            s3Url,
            carrier: detectCarrierFromText(text)
        };
    }

    return { found: false };
}
