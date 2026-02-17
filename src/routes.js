import UserController from './controllers/usersController.js';
import AuthController from './controllers/authController.js';
import PoliciesController from './controllers/policiesController.js';
import GraphController from './controllers/graphController.js';
import CarriersController from './controllers/carriersController.js';
import ParserController from './controllers/parserController.js';
import { requireAuth, optionalAuth, requireMinimumRole } from './middleware/auth.js';

// Function to register all routes
async function routes(fastify, options) {

    // ========== PUBLIC ROUTES ==========

    // Main route - server information
    fastify.get('/', UserController.getInfo);

    // ========== AUTHENTICATION ROUTES ==========

    // Create session (llamado por frontend después de autenticación exitosa en cliente)
    fastify.post('/auth/session', async (request, reply) => {
        return AuthController.createSession(request, reply);
    });

    // Validate existing session
    fastify.get('/auth/validate', AuthController.validateCurrentSession);

    // Logout
    fastify.post('/auth/logout', AuthController.logout);

    fastify.get('/parse/policy/:policyNumber', ParserController.auditPolicy);

    // ========== PROTECTED ROUTES (Require authentication) ==========


    // Get current user information
    fastify.get('/auth/me', { preHandler: [requireAuth, requireMinimumRole('User')] }, AuthController.getCurrentUser);

    // User routes (protected)
    fastify.get('/carriers/available', { preHandler: [requireAuth, requireMinimumRole('User')] }, CarriersController.getAvailableCarriers);
    fastify.get('/carriers/head-carriers', { preHandler: [requireAuth, requireMinimumRole('User')] }, CarriersController.getAvailableHeadCarriers);
    fastify.get('/users', { preHandler: [requireAuth, requireMinimumRole('User')] }, UserController.getAllUsers);
    fastify.get('/users/carriers', { preHandler: [requireAuth, requireMinimumRole('Manager')] }, CarriersController.getAllUserCarriers);
    fastify.get('/user/:id', { preHandler: [requireAuth, requireMinimumRole('User')] }, UserController.getUserById);
    fastify.post('/user', { preHandler: [requireAuth, requireMinimumRole('User')] }, UserController.createUser);
    fastify.put('/user/:id', { preHandler: [requireAuth, requireMinimumRole('User')] }, UserController.updateUser);
    fastify.delete('/user/:id', { preHandler: [requireAuth, requireMinimumRole('User')] }, UserController.deleteUser);
    fastify.put('/user/:id/carriers', { preHandler: [requireAuth, requireMinimumRole('Manager')] }, CarriersController.updateUserCarriers);

    // Policies routes (protected)
    fastify.get('/policies/new-business', { preHandler: [requireAuth, requireMinimumRole('User')] }, PoliciesController.getNewBusiness);
    fastify.get('/policies/renewals', { preHandler: [requireAuth, requireMinimumRole('User')] }, PoliciesController.getRenewals);
    fastify.get('/policies/unassigned', { preHandler: [requireAuth, requireMinimumRole('Manager')] }, PoliciesController.getUnassignedPolicies);
    fastify.put('/policies/:policyId/assign', { preHandler: [requireAuth, requireMinimumRole('Manager')] }, PoliciesController.assignPolicy);

    // 

    // Server health route
    fastify.get('/health', async (request, reply) => {
        return {
            status: 'ok',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            environment: process.env.NODE_ENV || 'development'
        };
    });
}

export default routes;