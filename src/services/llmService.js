import 'dotenv/config';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { TextDecoder } from 'util';

const MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
const API_VERSION = 'bedrock-2023-05-31';

class LLMService {
    constructor() {
        this.client = new BedrockRuntimeClient({
            region: process.env.BEDROCK_REGION || 'us-east-1',
            credentials: {
                accessKeyId: process.env.BEDROCK_ACCESS_KEY_ID,
                secretAccessKey: process.env.BEDROCK_SECRET_ACCESS_KEY,
            },
        });
    }

    async validateAccess() {
        try {
            const command = new InvokeModelCommand({
                modelId: MODEL_ID,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify({
                    anthropic_version: API_VERSION,
                    messages: [{ role: 'user', content: 'Reply with {} only.' }],
                    max_tokens: 10,
                    temperature: 0,
                }),
            });

            await this.client.send(command);
            return true;
        } catch (error) {
            throw new Error(`Bedrock validation failed: ${error.name || 'Error'} - ${error.message}`);
        }
    }

    async invoke(prompt, maxTokens = 1500) {
        const command = new InvokeModelCommand({
            modelId: MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: API_VERSION,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: maxTokens,
                temperature: 0,
            }),
        });

        const res = await this.client.send(command);
        const raw = new TextDecoder().decode(res.body);
        const parsed = JSON.parse(raw);
        const text = parsed.content?.[0]?.text ?? '';

        return LLMService.parseJson(text);
    }

    async invokeWithPdf(pdfBuffer, prompt, maxTokens = 1500) {
        const base64 = pdfBuffer.toString('base64');
        const command = new InvokeModelCommand({
            modelId: MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify({
                anthropic_version: API_VERSION,
                messages: [{
                    role: 'user',
                    content: [
                        {
                            type: 'document',
                            source: {
                                type: 'base64',
                                media_type: 'application/pdf',
                                data: base64,
                            },
                        },
                        { type: 'text', text: prompt },
                    ],
                }],
                max_tokens: maxTokens,
                temperature: 0,
            }),
        });

        const res = await this.client.send(command);
        const raw = new TextDecoder().decode(res.body);
        const parsed = JSON.parse(raw);
        const text = parsed.content?.[0]?.text ?? '';

        return LLMService.parseJson(text);
    }

    static parseJson(text) {
        try {
            return JSON.parse(text);
        } catch {
            const match = text.match(/\{[\s\S]*\}/);
            return match ? JSON.parse(match[0]) : null;
        }
    }
}

const llm = new LLMService();
export default llm;
