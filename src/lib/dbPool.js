import { Pool } from 'pg';
import 'dotenv/config';

// Shared pg pool for raw SQL operations outside Prisma
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

export { pool };
