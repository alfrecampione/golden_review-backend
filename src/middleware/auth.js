// Middleware to require a minimum role based on hierarchy: Admin > Manager > User
export const requireMinimumRole = (minRole) => {
    // Define role hierarchy
    const roleOrder = ['User', 'Manager', 'Admin'];
    return async (request, reply) => {
        try {
            const user = request.user;
            if (!user || !Array.isArray(user.roles)) {
                return reply.code(403).send({
                    success: false,
                    error: 'Forbidden',
                    message: 'Insufficient role'
                });
            }

            // Find the highest role the user has
            let userMaxRoleIndex = -1;
            for (const role of user.roles) {
                const idx = roleOrder.indexOf(role);
                if (idx > userMaxRoleIndex) userMaxRoleIndex = idx;
            }

            const minRoleIndex = roleOrder.indexOf(minRole);
            if (userMaxRoleIndex < minRoleIndex) {
                return reply.code(403).send({
                    success: false,
                    error: 'Forbidden',
                    message: `Requires at least role: ${minRole}`
                });
            }
            // User has sufficient role, continue
        } catch (error) {
            console.error('Error in requireMinimumRole middleware:', error);
            return reply.code(500).send({
                success: false,
                error: 'Internal server error'
            });
        }
    };
};
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

// Middleware to verify roles
export const requireRole = (requiredRoles) => {
    return async (request, reply) => {
        try {
            const user = request.user;
            if (!user || !Array.isArray(user.roles)) {
                return reply.code(403).send({
                    success: false,
                    error: 'Forbidden',
                    message: 'Insufficient role'
                });
            }
            // Check if user has at least one of the required roles
            const hasRole = user.roles.some(role => requiredRoles.includes(role));
            if (!hasRole) {
                return reply.code(403).send({
                    success: false,
                    error: 'Forbidden',
                    message: `Requires one of roles: ${requiredRoles.join(', ')}`
                });
            }
            // User has required role, continue
        } catch (error) {
            console.error('Error in requireRole middleware:', error);
            return reply.code(500).send({
                success: false,
                error: 'Internal server error'
            });
        }
    };
};