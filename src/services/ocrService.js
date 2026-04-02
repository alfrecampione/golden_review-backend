import { TextractClient, AnalyzeDocumentCommand } from '@aws-sdk/client-textract';

class OCRService {
    constructor(region = 'us-east-1') {
        this.client = new TextractClient({ region });
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
