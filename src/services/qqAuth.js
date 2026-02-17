import axios from 'axios';
import 'dotenv/config';

const QQ_TOKEN_URL = 'https://login.qqcatalyst.com/oauth/token';

let cachedAccessToken = null;
let cachedExpiry = 0; // epoch ms
let cachedRefreshToken = process.env.QQ_REFRESH_TOKEN; // initial seed

function getRequiredEnv(name) {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Falta la variable de entorno ${name}`);
    }
    return value;
}

function getBasicAuthHeader() {
    const clientId = getRequiredEnv('QQ_CLIENT_ID');
    const clientSecret = getRequiredEnv('QQ_CLIENT_SECRET');

    const encoded = Buffer
        .from(`${clientId}:${clientSecret}`)
        .toString('base64');

    return `Basic ${encoded}`;
}

export async function getQqToken() {
    const now = Date.now();

    // Reuse token if valid for at least 60 seconds
    if (cachedAccessToken && cachedExpiry - now > 60000) {
        return cachedAccessToken;
    }

    if (!cachedRefreshToken) {
        throw new Error('No hay refresh token disponible');
    }

    const payload = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: cachedRefreshToken
    });

    try {
        const response = await axios.post(
            QQ_TOKEN_URL,
            payload.toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': getBasicAuthHeader()
                }
            }
        );

        const {
            access_token,
            refresh_token,
            expires_in
        } = response.data;

        if (!access_token) {
            throw new Error('No se recibió access_token');
        }

        cachedAccessToken = access_token;
        cachedExpiry = Date.now() + (Number(expires_in) || 3600) * 1000;

        // IMPORTANT: rotate refresh token if new one returned
        if (refresh_token) {
            cachedRefreshToken = refresh_token;
        }

        return cachedAccessToken;

    } catch (err) {
        console.error('Error obteniendo token QQ:',
            err.response?.data || err.message
        );
        throw err;
    }
}