// Import dependencies
import Fastify from 'fastify';
import dotenv from 'dotenv';
import routes from './routes.js';

// Load environment variables
dotenv.config();

const fastify = Fastify({
    logger: false
});

// Configure CORS to allow requests from frontend
await fastify.register(import('@fastify/cors'), {
    origin: [
        process.env.BASE_URL,
        'http://localhost:5173', // Vite dev server (local)
        'http://127.0.0.1:5173',
        'http://dev-goldenaudit.goldentrustinsurance.com:5173' // AWS dev server
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Set-Cookie']
});

// Configure cookies
await fastify.register(import('@fastify/cookie'), {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    parseOptions: {}
});

// Configure sessions
await fastify.register(import('@fastify/session'), {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    cookieName: 'sessionId',
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Allow HTTP in development
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax', // 'none' for cross-origin in production
        path: '/'
    },
    saveUninitialized: true, // Save session even if not modified
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