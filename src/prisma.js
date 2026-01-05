import { PrismaClient } from '@prisma/client';

// Create global Prisma instance
let prisma;

if (process.env.NODE_ENV === 'production') {
    prisma = new PrismaClient();
} else {
    // In development, use a global instance to avoid multiple connections
    if (!global.prisma) {
        global.prisma = new PrismaClient({
            log: ['warn', 'error'],
        });
    }
    prisma = global.prisma;
}

// Test database connection
prisma.$connect()
    .then(() => {
        console.log('✅ Database connected successfully');
    })
    .catch((error) => {
        console.error('❌ Failed to connect to database:', error.message);
    });

// Function to validate goldentrust.com email
export const validateGoldenTrustEmail = (email) => {
    const allowedDomain = '@goldentrust.com';

    return email && email.toLowerCase().endsWith(allowedDomain.toLowerCase());
};

// Function to create or update user from Microsoft
export const createOrUpdateMicrosoftUser = async (microsoftProfile) => {
    const { id: microsoftId, mail, displayName, givenName, surname, jobTitle, department, roles } = microsoftProfile;

    if (!microsoftId) {
        throw new Error('Missing microsoftId in profile');
    }

    // Validate that email is from goldentrust.com
    if (!validateGoldenTrustEmail(mail)) {
        throw new Error('Only users with @goldentrust.com domain can access');
    }

    try {
        // Try to update existing user or create new one
        const user = await prisma.user.upsert({
            where: { microsoftId },
            update: {
                microsoftId,
                firstName: givenName,
                lastName: surname,
                fullName: displayName,
                department: department,
                position: jobTitle,
                roles: roles || [],
                lastAccess: new Date(),
            },
            create: {
                microsoftId,
                email: mail,
                firstName: givenName,
                lastName: surname,
                fullName: displayName,
                department: department,
                position: jobTitle,
                roles: roles || [],
                lastAccess: new Date(),
            },
        });

        return user;
    } catch (error) {
        console.error('Error creating/updating user:', error);
        throw error;
    }
};

// Function to fetch Microsoft avatar from entra.user_avatars
export const getMSAPhotoPath = async (entraId) => {
    try {
        const result = await prisma.$queryRaw`SELECT s3_url AS photo FROM entra.user_avatars WHERE entra_id = ${entraId} LIMIT 1`;
        if (Array.isArray(result) && result.length > 0) {
            const photo = result[0].photo;
            return photo ? String(photo) : null;
        }
        return null;
    } catch (error) {
        console.error('Error fetching Microsoft photo path:', error);
        return null;
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