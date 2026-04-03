import { downloadFilesToDB } from './contactFilesService.js';
import { checkSingleFile } from './determine_application.js';
import prisma from '../prisma.js';

/**
 * Get all files for a customer from DB
 */
export async function getFilesForCustomer(customerId) {
    const files = await prisma.$queryRaw`
        SELECT * FROM qq.contact_files WHERE contact_id = ${customerId}
    `;
    return Array.isArray(files) ? files : [];
}

/**
 * Find most recent application in DB files
 */
export async function findApplicationInFiles(files, detectionOptions = {}) {
    const foundApps = [];
    for (const file of files) {
        if (file.s3_url && String(file.file_name_reported || '').toLowerCase().endsWith('.pdf')) {
            try {
                const result = await checkSingleFile(file.s3_url, detectionOptions);
                if (result && result.found) {
                    foundApps.push({
                        ...result,
                        dbFile: file
                    });
                }
            } catch (err) {
                console.error('[findApplicationInFiles] Error checking file for application:', err);
            }
        }
    }
    if (foundApps.length === 0) {
        console.log('[findApplicationInFiles] No application files found');
        return null;
    }
    foundApps.sort((a, b) => {
        const dateA = new Date(a.dbFile.created_on || a.dbFile.inserted_at || 0);
        const dateB = new Date(b.dbFile.created_on || b.dbFile.inserted_at || 0);
        return dateB - dateA;
    });
    return foundApps[0];
}

/**
 * Sync files for a customer and find application file
 */
export async function syncAndFindApplication(customerId, detectionOptions = {}) {
    const syncResult = await downloadFilesToDB(customerId);
    const dbFiles = await getFilesForCustomer(customerId);
    const applicationInfo = await findApplicationInFiles(dbFiles, detectionOptions);
    return {
        syncResult,
        dbFiles,
        applicationInfo,
    };
}