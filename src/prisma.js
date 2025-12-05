import { PrismaClient } from './generated/prisma/index.js';

// Create global Prisma instance
let prisma;

if (process.env.NODE_ENV === 'production') {
    prisma = new PrismaClient();
} else {
    // In development, use a global instance to avoid multiple connections
    if (!global.prisma) {
        global.prisma = new PrismaClient({
            log: ['query', 'info', 'warn', 'error'],
        });
    }
    prisma = global.prisma;
}

// Function to validate goldentrust.com email
export const validateGoldenTrustEmail = (email) => {
    const allowedDomain = '@goldentrust.com';
    return email && email.toLowerCase().endsWith(allowedDomain.toLowerCase());
};

// Function to create or update user from Microsoft
export const createOrUpdateMicrosoftUser = async (microsoftProfile) => {
    const { id: microsoftId, mail, displayName, givenName, surname, jobTitle, department } = microsoftProfile;

    // Validate that email is from goldentrust.com
    if (!validateGoldenTrustEmail(mail)) {
        throw new Error('Only users with @goldentrust.com domain can access');
    }

    try {
        // Try to update existing user or create new one
        const user = await prisma.user.upsert({
            where: { email: mail },
            update: {
                microsoftId,
                firstName: givenName,
                lastName: surname,
                fullName: displayName,
                department: department,
                position: jobTitle,
                lastAccess: new Date(),
            },
            create: {
                id: microsoftId,
                microsoftId,
                email: mail,
                firstName: givenName,
                lastName: surname,
                fullName: displayName,
                department: department,
                position: jobTitle,
                lastAccess: new Date(),
            },
        });

        return user;
    } catch (error) {
        console.error('Error creating/updating user:', error);
        throw error;
    }
};

// Function to register authentication attempts
export const registerAuthenticationAttempt = async (email, isSuccessful, failureReason = null, requestInfo = {}) => {
    try {
        await prisma.authLog.create({
            data: {
                email,
                isSuccessful: isSuccessful,
                failureReason: failureReason,
                ipAddress: requestInfo.ip,
                userAgent: requestInfo.userAgent,
            },
        });
    } catch (error) {
        console.error('Error registering authentication attempt:', error);
    }
};

export default prisma;