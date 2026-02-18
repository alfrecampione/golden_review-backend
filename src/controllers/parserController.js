import prisma from '../prisma.js';
import { downloadFilesToDB } from '../services/contactFilesService.js';
import { checkSingleFile } from '../services/determine_application.js';
import { invokePdfLambda } from '../services/lambdaInvoke.js';

class ParserController {
    static auditPolicy = async (request, reply) => {
        try {
            const { policyNumber } = request.params;
            if (!policyNumber) {
                return reply.code(400).send({
                    success: false,
                    message: 'policyNumber is required'
                });
            }

            // 1. Get customerId from policyNumber
            console.log('[auditPolicy] Step 1: Fetching customer_id for policyNumber', policyNumber);
            const result = await prisma.$queryRaw`
                SELECT customer_id
                FROM qq.policies
                WHERE policy_number = ${policyNumber}
                LIMIT 1
            `;
            const customerId = Array.isArray(result) && result.length > 0
                ? String(result[0].customer_id)
                : null;
            if (!customerId) {
                return reply.code(404).send({
                    success: false,
                    message: 'Policy not found'
                });
            }
            const numericCustomerId = Number(customerId);
            if (Number.isNaN(numericCustomerId)) {
                return reply.code(400).send({
                    success: false,
                    message: 'customer_id no es numerico'
                });
            }

            // 2. Sync files to S3 and DB
            console.log('[auditPolicy] Step 2: Syncing files to S3 and DB for customer', numericCustomerId);
            const syncResult = await downloadFilesToDB(numericCustomerId);
            console.log('[auditPolicy] Sync result:', syncResult);

            // 3. Get all files for this user from DB
            console.log('[auditPolicy] Step 3: Fetching all files for customer from DB');
            const dbFiles = await ParserController.getFilesForCustomer(numericCustomerId);
            console.log(`[auditPolicy] Found ${dbFiles.length} files in DB for customer ${numericCustomerId}`);

            // 4. Determine if any file is an application
            console.log('[auditPolicy] Step 4: Searching for application file in DB files');
            const applicationInfo = await ParserController.findApplicationInFiles(dbFiles);

            if (!applicationInfo) {
                return reply.send({
                    success: false,
                    message: 'No application file found'
                });
            }

            // 5. Call Lambda with the S3 URL of the application file
            let lambdaResult;
            try {
                console.log('[auditPolicy] Step 5: Invoking Lambda with S3 URL', applicationInfo.s3Url);
                lambdaResult = await invokePdfLambda(applicationInfo.s3Url);
            } catch (lambdaErr) {
                console.error('[auditPolicy] Lambda invocation error:', lambdaErr);
                return reply.code(500).send({
                    success: false,
                    message: 'Error invoking Lambda',
                    error: lambdaErr.message
                });
            }

            console.log('[auditPolicy] Step 6: Lambda invocation success');
            return reply.send({
                success: true,
                lambdaResult
            });
        } catch (error) {
            console.error('Error fetching customer_id by policyNumber:', error);
            if (error.response && error.response.status && error.response.data) {
                return reply.code(error.response.status).send({
                    success: false,
                    message: 'Error from QQ Catalyst',
                    error: error.response.data
                });
            }
            return reply.code(500).send({
                success: false,
                message: 'Internal error fetching customer_id',
                error: error.message
            });
        }
    }

    // Helper: get all files for a customer from DB
    static async getFilesForCustomer(customerId) {
        console.log('[getFilesForCustomer] Fetching files for customer', customerId);
        const files = await prisma.$queryRaw`
            SELECT * FROM qq.contact_files WHERE contact_id = ${customerId}
        `;
        return Array.isArray(files) ? files : [];
    }

    // Helper: find most recent application in DB files
    static async findApplicationInFiles(files) {
        console.log('[findApplicationInFiles] Checking files for application forms');
        let first = true;
        const foundApps = [];
        for (const file of files) {
            console.log(`[findApplicationInFiles] Checking file: ${JSON.stringify(file)}`);
            if (file.s3_url && file.content_type_final.includes('pdf')) {
                try {
                    if (first) {
                        console.log('[findApplicationInFiles] First file being checked:', file.s3_url);
                        first = false;
                        const result = await checkSingleFile(file.s3_url);
                        if (result && result.found) {
                            foundApps.push({
                                ...result,
                                dbFile: file
                            });
                        }
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
            const dateA = new Date(a.dbFile.inserted_at);
            const dateB = new Date(b.dbFile.inserted_at);
            return dateB - dateA;
        });
        console.log('[findApplicationInFiles] Most recent application file selected:', foundApps[0]?.dbFile?.s3_url);
        return foundApps[0];
    }

}

export default ParserController;