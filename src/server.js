// Import dependencies
import Fastify from 'fastify';
import dotenv from 'dotenv';
import routes from './routes.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import connectPgSimple from 'connect-pg-simple';
import { startUserSyncJob } from './jobs/syncUsersJob.js';
import { startPoliciesSyncJob } from './jobs/syncPoliciesJob.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SSL certificate paths
const sslPath = path.join(__dirname, '../../front/src/ssl');
const httpsOptions = {
    key: fs.readFileSync(path.join(sslPath, 'server.key')),
    cert: fs.readFileSync(path.join(sslPath, '31e810c645f53345.crt')),
    ca: fs.readFileSync(path.join(sslPath, 'gd_bundle-g2.crt'))
};

const fastify = Fastify({
    logger: false,
    https: httpsOptions
});

// Configure CORS to allow requests from frontend
await fastify.register(import('@fastify/cors'), {
    origin: [
        process.env.BASE_URL,
        'http://localhost:5173', // Vite dev server (local HTTP)
        'http://127.0.0.1:5173',
        'https://localhost:5173', // Vite dev server (local HTTPS)
        'https://127.0.0.1:5173',
        'http://dev-goldenaudit.goldentrustinsurance.com:5173', // AWS dev server (HTTP)
        'https://dev-goldenaudit.goldentrustinsurance.com:5173' // AWS dev server (HTTPS)
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

// Configure PostgreSQL session store
const PgSession = connectPgSimple({ Store: Object });
const pgPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for AWS RDS
    }
});

const sessionStore = new PgSession({
    pool: pgPool,
    tableName: 'session',
    schemaName: 'goldenaudit',
    createTableIfMissing: false // Table already exists in schema
});

// Configure sessions with persistent store
await fastify.register(import('@fastify/session'), {
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    store: sessionStore, // Use PostgreSQL store instead of in-memory
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

// Schedule background jobs
startUserSyncJob();
startPoliciesSyncJob();

// Function to start the server
const start = async () => {
    try {
        const port = process.env.PORT || 4000;
        fastify.listen({
            port: port,
            host: '0.0.0.0' // Allow connections from any IP
        });
        console.log(`✅ HTTPS Server running on https://localhost:${port}`);
        console.log(`✅ Database connected successfully`);
    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

start();