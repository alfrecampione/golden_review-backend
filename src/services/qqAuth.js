import axios from 'axios';
import 'dotenv/config';

const QQ_TOKEN_URL = 'https://login.qqcatalyst.com/oauth/token';

let cachedToken = null;
let cachedExpiry = 0; // epoch ms

function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Falta la variable de entorno ${name}`);
    }
    return value;
}

export async function getQqToken() {
    const now = Date.now();
    // Reuse token if still valid for at least 60s
    if (cachedToken && cachedExpiry - now > 60000) {
        return cachedToken;
    }

    const client_id = getRequiredEnv('QQ_CLIENT_ID');
    const client_secret = getRequiredEnv('QQ_CLIENT_SECRET');
    const username = getRequiredEnv('QQ_USERNAME');
    const password = getRequiredEnv('QQ_PASSWORD');

    const payload = new URLSearchParams({
        grant_type: 'password',
        username,
        password,
        client_id,
        client_secret
    });

    const response = await axios.post(QQ_TOKEN_URL, payload.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    });

    const accessToken = response.data?.access_token;
    const expiresIn = Number(response.data?.expires_in) || 3600;

    if (!accessToken) {
        throw new Error('No se pudo obtener access_token de QQ');
    }

    cachedToken = accessToken;
    cachedExpiry = now + expiresIn * 1000;
    return cachedToken;
}
