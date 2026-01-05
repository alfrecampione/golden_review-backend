import prisma, {
    createOrUpdateMicrosoftUser,
    registerAuthenticationAttempt,
    getMSAPhotoPath
} from '../prisma.js';

// Define existing roles that are allowed to access the system
const existing_roles = ['Manager', 'User', 'Admin'];

class AuthController {

    // Crear sesión con datos de usuario (llamado por el frontend después de autenticación exitosa)
    static async createSession(request, reply) {
        try {
            const { user } = request.body;

            if (!user || !user.email || !user.microsoftId) {
                return reply.code(400).send({
                    success: false,
                    error: 'Invalid user data',
                    message: 'User email and microsoftId are required'
                });
            }

            // Crear o actualizar usuario en la base de datos
            // Pass roles from Azure AD to be stored in the database
            const dbUser = await createOrUpdateMicrosoftUser({
                microsoftId: user.microsoftId,
                displayName: user.name || `${user.firstName} ${user.lastName}`,
                mail: user.email,
                givenName: user.firstName,
                surname: user.lastName,
                jobTitle: user.position,
                department: user.department,
                roles: user.roles || [] // Store roles from Azure AD
            });

            // Check if user has GoldenAuditUser role
            const roles = dbUser.roles || [];
            const hasValidRole = roles.some(role => existing_roles.includes(role));

            if (!hasValidRole) {
                // Registrar intento de autenticación fallido
                await registerAuthenticationAttempt(
                    dbUser.email,
                    false,
                    'Missing required role from existing_roles',
                    { ip: request.ip, userAgent: request.headers['user-agent'] }
                );

                return reply.code(403).send({
                    success: false,
                    error: 'Access denied',
                    message: 'Required role not found'
                });
            }

            // Registrar intento de autenticación exitoso
            await registerAuthenticationAttempt(
                dbUser.email,
                true,
                null,
                { ip: request.ip, userAgent: request.headers['user-agent'] }
            );

            // Guardar usuario en sesión
            request.session.userId = dbUser.id;
            request.session.authenticated = true;

            // Fetch Microsoft avatar path if available
            const photoUrl = await getMSAPhotoPath(dbUser.microsoftId);

            return {
                success: true,
                message: 'Session created successfully',
                user: {
                    id: dbUser.id,
                    email: dbUser.email,
                    name: dbUser.fullName,
                    firstName: dbUser.firstName,
                    lastName: dbUser.lastName,
                    department: dbUser.department,
                    position: dbUser.position,
                    roles: dbUser.roles || [],
                    photoUrl: photoUrl || null
                }
            };

        } catch (error) {
            console.error('Error creating session:', error);
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
                return {
                    success: true,
                    valid: false
                };
            }
            const user = await prisma.user.findUnique({
                where: { id: request.session.userId }
            });

            if (!user) {
                // Clear invalid session
                request.session.destroy();
                return {
                    success: true,
                    valid: false
                };
            }
            const photoUrl = await getMSAPhotoPath(user.id);
            return {
                success: true,
                valid: true,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.fullName,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    department: user.department,
                    position: user.position,
                    roles: user.roles || [],
                    photoUrl: photoUrl || null
                }
            };

        } catch (error) {
            console.error('💥 validateCurrentSession: Error validating session:', error);
            return reply.code(500).send({
                success: false,
                error: 'Internal server error'
            });
        }
    }

    // Logout
    static async logout(request, reply) {
        try {
            const sessionId = request.session.sessionId;

            // Clear server session cookie
            request.session.destroy();

            // Also delete session from database if sessionId exists
            if (sessionId) {
                try {
                    await prisma.session.delete({
                        where: { sid: sessionId }
                    });
                    console.log(`Session ${sessionId} deleted from database`);
                } catch (dbError) {
                    // Session might not exist in DB or already deleted - that's ok
                    console.log('Session already removed from database or does not exist');
                }
            }

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
            // El middleware requireAuth ya validó la sesión y agregó el usuario
            // Si llegamos aquí, el usuario está autenticado
            const user = request.user;

            const photoUrl = await getMSAPhotoPath(user.id);
            return {
                success: true,
                user: {
                    id: user.id,
                    email: user.email,
                    name: user.fullName,
                    firstName: user.firstName,
                    lastName: user.lastName,
                    department: user.department,
                    position: user.position,
                    roles: user.roles || [],
                    photoUrl: photoUrl || null
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

export default AuthController;