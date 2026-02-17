import axios from 'axios';
import 'dotenv/config';

const QQ_TOKEN_URL = 'https://login.qqcatalyst.com/oauth/token';

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

    return 'Basic ' + Buffer
        .from(`${clientId}:${clientSecret}`)
        .toString('base64');
}

export async function getQqToken() {
    const refreshToken = getRequiredEnv('QQ_REFRESH_TOKEN');

    const payload = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken
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

        const accessToken = response.data?.access_token;
        const newRefreshToken = response.data?.refresh_token;

        if (!accessToken) {
            throw new Error('No se recibió access_token');
        }

        // ⚠️ IMPORTANTE:
        // Si Catalyst rota el refresh_token, deberías guardarlo en DB
        // Aquí solo lo mostramos
        if (newRefreshToken) {
            console.log('Nuevo refresh_token recibido. Debes persistirlo.');
        }

        return accessToken;

    } catch (err) {
        console.error('Error obteniendo token QQ:',
            err.response?.data || err.message
        );
        throw err;
    }
}