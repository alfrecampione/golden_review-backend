import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import 'dotenv/config';

const s3 = new S3Client({
    region: process.env.AWS_REGION || 'us-east-1'
});

// Upload a local file to S3 with a unique key to avoid collisions.
export async function uploadToS3(filePath, contactId, fileId = null) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Archivo no encontrado: ${filePath}`);
    }

    const fileName = path.basename(filePath);
    const bucket = process.env.AWS_S3_BUCKET;
    const fileExt = path.extname(fileName);
    const baseName = path.basename(fileName, fileExt);

    const uniqueName = fileId
        ? `${fileId}${fileExt}`
        : `${baseName}_${Date.now()}${fileExt}`;

    const key = `${contactId}/${uniqueName}`;
    const fileContent = fs.readFileSync(filePath);

    const params = {
        Bucket: bucket,
        Key: key,
        Body: fileContent
    };

    await s3.send(new PutObjectCommand(params));

    const fileUrl = `https://${bucket}.s3.${process.env.AWS_REGION || 'us-east-1'}.amazonaws.com/${key}`;
    return fileUrl;
}
