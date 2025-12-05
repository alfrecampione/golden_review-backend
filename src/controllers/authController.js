import { ConfidentialClientApplication } from '@azure/msal-node';
import { v4 as uuidv4 } from 'uuid';
import prisma, {
    validateGoldenTrustEmail,
    createOrUpdateMicrosoftUser,
    registerAuthenticationAttempt
} from '../prisma.js';

// MSAL (Microsoft Authentication Library) configuration
const msalConfig = {
    auth: {
        clientId: process.env.MS_CLIENT_ID,
        clientSecret: process.env.MS_CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}`,
    },
};

const msalInstance = new ConfidentialClientApplication(msalConfig);

class AuthController {

    // Start login process - returns Microsoft URL for redirect
    static async initiateLogin(request, reply) {
        try {
            const state = uuidv4(); // State to validate callback

            // Configure authentication parameters
            const authCodeUrlParameters = {
                scopes: ["user.read", "email", "profile", "openid"],
                redirectUri: process.env.REDIRECT_URI,
                state: state,
                prompt: "select_account", // Allow account selection
            };

            // Get Microsoft authorization URL
            const authUrl = await msalInstance.getAuthCodeUrl(authCodeUrlParameters);

            // Save state in session for later validation
            request.session.authState = state;

            return {
                success: true,
                authUrl: authUrl,
                message: 'Redirect user to this URL for authentication'
            };

        } catch (error) {
            console.error('Error initiating login:', error);
            return reply.code(500).send({
                success: false,
                error: 'Internal server error',
                details: error.message
            });
        }
    }

    // Handle Microsoft callback after login
    static async handleCallback(request, reply) {
        try {
            const { code, state, error, error_description } = request.query;

            // Check if there was an error from Microsoft
            if (error) {
                await registerAuthenticationAttempt(
                    'unknown',
                    false,
                    `Microsoft error: ${error_description || error}`,
                    { ip: request.ip, userAgent: request.headers['user-agent'] }
                );

                return reply.code(400).send({
                    success: false,
                    error: 'Authentication error',
                    details: error_description || error
                });
            }

            // Validate state to prevent CSRF
            if (state !== request.session.authState) {
                return reply.code(400).send({
                    success: false,
                    error: 'Invalid authentication state'
                });
            }

            // Exchange code for token
            const tokenRequest = {
                code: code,
                scopes: ["user.read", "email", "profile", "openid"],
                redirectUri: process.env.REDIRECT_URI,
            };

            const tokenResponse = await msalInstance.acquireTokenByCode(tokenRequest);

            // Get user information from Microsoft Graph
            const userProfile = await getUserProfile(tokenResponse.accessToken);

            // Validate that user is from goldentrust.com
            if (!validateGoldenTrustEmail(userProfile.mail || userProfile.userPrincipalName)) {
                await registerAuthenticationAttempt(
                    userProfile.mail || userProfile.userPrincipalName,
                    false,
                    'Unauthorized domain (@goldentrust.com required)',
                    { ip: request.ip, userAgent: request.headers['user-agent'] }
                );

                return reply.code(403).send({
                    success: false,
                    error: 'Access denied',
                    message: 'Only users with @goldentrust.com domain can access'
                });
            }

            // Create or update user in database
            const user = await createOrUpdateMicrosoftUser(userProfile);

            // Register successful login
            await registerAuthenticationAttempt(
                user.email,
                true,
                null,
                { ip: request.ip, userAgent: request.headers['user-agent'] }
            );

            // Clear authentication state from session
            delete request.session.authState;

            // Save user session in Fastify session (cookie-based)
            request.session.userId = user.id;
            request.session.authenticated = true;

            // Return only success message - session is in cookie
            return {
                success: true,
                message: 'Authentication successful'
            };

        } catch (error) {
            console.error('Error in authentication callback:', error);

            await registerAuthenticationAttempt(
                'unknown',
                false,
                `Server error: ${error.message}`,
                { ip: request.ip, userAgent: request.headers['user-agent'] }
            );

            return reply.code(500).send({
                success: false,
                error: 'Internal server error',
                details: error.message
            });
        }
    }

    // Validate existing session
    static async validateCurrentSession(request, reply) {
        try {
            // Check if user is authenticated via session cookie
            if (!request.session?.userId || !request.session?.authenticated) {
                return reply.code(401).send({
                    success: false,
                    error: 'No active session',
                    valid: false
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
                    error: 'User not found',
                    valid: false
                });
            }

            return {
                success: true,
                valid: true,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.fullName,
                    department: user.department,
                    position: user.position
                }
            };

        } catch (error) {
            console.error('Error validating session:', error);
            return reply.code(500).send({
                success: false,
                error: 'Internal server error'
            });
        }
    }

    // Logout
    static async logout(request, reply) {
        try {
            // Clear server session cookie
            request.session.destroy();

            return {
                success: true,
                message: 'Session closed successfully'
            };

        } catch (error) {
            console.error('Error closing session:', error);
            return reply.code(500).send({
                success: false,
                error: 'Error closing session'
            });
        }
    }

    // Get current user information
    static async getCurrentUser(request, reply) {
        try {
            // Check if user is authenticated via session cookie
            if (!request.session?.userId || !request.session?.authenticated) {
                return reply.code(401).send({
                    success: false,
                    error: 'Not authenticated'
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
                    error: 'User not found'
                });
            }

            return {
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.fullName,
                    department: user.department,
                    position: user.position
                }
            };

        } catch (error) {
            console.error('Error getting current user:', error);
            return reply.code(500).send({
                success: false,
                error: 'Internal server error'
            });
        }
    }
}

// Helper function to get user profile from Microsoft Graph
async function getUserProfile(accessToken) {
    try {
        const response = await fetch('https://graph.microsoft.com/v1.0/me', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`Error getting profile: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Error getting Microsoft Graph profile:', error);
        throw error;
    }
}

export default AuthController;