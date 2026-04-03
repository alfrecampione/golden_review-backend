import 'dotenv/config';
import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';

const MINIMAL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9sWk0S8AAAAASUVORK5CYII=';

class OCRService {
    constructor() {
        this.client = new TextractClient({
            region: process.env.BEDROCK_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID,
                secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY,
            },
        });
    }

    async validateAccess() {
        const command = new AnalyzeDocumentCommand({
            Document: { Bytes: Buffer.from(MINIMAL_PNG_BASE64, 'base64') },
            FeatureTypes: ['FORMS', 'TABLES'],
        });

        await this.client.send(command);
        return true;
    }

    async extract(fileBuffer) {
        const command = new AnalyzeDocumentCommand({
            Document: { Bytes: fileBuffer },
            FeatureTypes: ['FORMS', 'TABLES'],
        });

        const res = await this.client.send(command);

        const text = (res.Blocks || [])
            .filter(b => b.BlockType === 'LINE')
            .map(b => b.Text)
            .join('\n');

        return text || '';
    }
}

const ocr = new OCRService();
export default ocr;
