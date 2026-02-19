import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import 'dotenv/config';

// Crea el cliente Lambda usando credenciales especiales para Lambda
function getLambdaClient() {
    const accessKeyId = process.env.LAMBDA_AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.LAMBDA_AWS_SECRET_ACCESS_KEY;
    if (!accessKeyId || !secretAccessKey) {
        console.error('[lambdaInvoke] ERROR: LAMBDA_AWS_ACCESS_KEY_ID o LAMBDA_AWS_SECRET_ACCESS_KEY no están definidos.');
        throw new Error('Credenciales de Lambda no definidas en variables de entorno');
    }

    return new LambdaClient({
        region: process.env.AWS_REGION || 'us-east-1',
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });
}

export async function invokePdfLambda(s3Url) {
    const client = getLambdaClient();
    const payload = {
        s3_url: s3Url,
    };

    const command = new InvokeCommand({
        FunctionName: process.env.LAMBDA_FUNCTION_NAME || 'carrier-application-to-json-lambda',
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(payload)),
    });

    const response = await client.send(command);
    const rawPayload = Buffer.from(response.Payload).toString();
    const parsed = JSON.parse(rawPayload);

    if (parsed.body) {
        return JSON.parse(parsed.body);
    }
    return parsed;
}
