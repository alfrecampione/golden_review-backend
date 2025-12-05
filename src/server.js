// Import dependencies
import Fastify from 'fastify';
import dotenv from 'dotenv';
import routes from './routes.js';

// Load environment variables
dotenv.config();

const fastify = Fastify({
    logger: true
});

// Configure CORS to allow requests from frontend
await fastify.register(import('@fastify/cors'), {
    origin: [
        process.env.BASE_URL,
        'http://localhost:5173', // Vite dev server
        'http://127.0.0.1:5173'
    ],
    credentials: true
});

// Configure cookies
await fastify.register(import('@fastify/cookie'), {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    parseOptions: {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax'
    }
});

// Configure sessions
await fastify.register(import('@fastify/session'), {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    cookieName: 'sessionId',
    cookie: {
        secure: process.env.NODE_ENV === 'production', // HTTPS in production
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        sameSite: 'lax'
    },
    saveUninitialized: false,
    rolling: true // Renew cookie on each request
});

// Hook to add request information to logs
fastify.addHook('preHandler', async (request, reply) => {
    request.log.info({
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent']
    });
});

// Register routes
fastify.register(routes);

// Function to start the server
const start = async () => {
    try {
        const port = process.env.PORT || 3000;
        fastify.listen({
            port: port,
            host: '0.0.0.0' // Allow connections from any IP
        });
        console.log(`Server running on http://localhost:${port}`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();