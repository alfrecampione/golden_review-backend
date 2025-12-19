import prisma from '../prisma.js';

// Middleware to protect routes that require authentication
export const requireAuth = async (request, reply) => {
    try {
        // Check if user is authenticated via session cookie
        if (!request.session?.userId || !request.session?.authenticated) {
            return reply.code(401).send({
                success: false,
                error: 'Authentication required',
                message: 'Please log in to access this resource'
            });
        }

        // Get user from database
        const user = await prisma.user.findUnique({
            where: { id: request.session.userId }
        });

        if (!user) {
            // Clear invalid session
            request.session.destroy();
            return reply.code(401).send({
                success: false,
                error: 'Invalid session',
                message: 'User not found. Please log in again'
            });
        }

        // Attach user to request for use in route handlers
        request.user = user;

    } catch (error) {
        console.error('Error in authentication middleware:', error);
        return reply.code(500).send({
            success: false,
            error: 'Internal server error'
        });
    }
};

// Optional middleware for routes that can benefit from user info
export const optionalAuth = async (request, reply) => {
    try {
        // Check if user is authenticated via session cookie
        if (request.session?.userId && request.session?.authenticated) {
            // Get user from database
            const user = await prisma.user.findUnique({
                where: { id: request.session.userId }
            });

            if (user) {
                request.user = user;
            }
        }

        // Continue regardless - it's optional
    } catch (error) {
        console.error('Error in optional authentication middleware:', error);
        // Don't fail on optional middleware
    }
};

// Middleware to verify Golden Audit role
export const requireGoldenAudit = async (request, reply) => {
    const roles = request.user?.roles || [];

    if (!roles.includes('GoldenAuditUser')) {
        return reply.code(403).send({
            success: false,
            error: 'Access denied',
            message: 'GoldenAuditUser role required'
        });
    }
};