import fs from 'fs';
import path from 'path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { s3, BUCKET } from '../lib/s3.js';

// Upload a local file to S3 with a unique key to avoid collisions.
export async function uploadToS3(filePath, contactId, fileId = null) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Archivo no encontrado: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const fileExt = path.extname(fileName);
    const baseName = path.basename(fileName, fileExt);

    const uniqueName = fileId
        ? `${fileId}${fileExt}`
        : `${baseName}_${Date.now()}${fileExt}`;

    const key = `${contactId}/${uniqueName}`;
    const fileContent = fs.readFileSync(filePath);

    const params = {
        Bucket: BUCKET,
        Key: key,
        Body: fileContent
    };

    await s3.send(new PutObjectCommand(params));

    const fileUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
    return fileUrl;
}
