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
            const syncResult = await downloadFilesToDB(numericCustomerId);
            console.log('[auditPolicy] Sync result:', syncResult);

            // 3. Get all files for this user from DB
            const dbFiles = await ParserController.getFilesForCustomer(numericCustomerId);

            // 4. Determine if any file is an application
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
                lambdaResult = await invokePdfLambda(applicationInfo.s3Url);
            } catch (lambdaErr) {
                return reply.code(500).send({
                    success: false,
                    message: 'Error invoking Lambda',
                    error: lambdaErr.message
                });
            }
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
        const files = await prisma.$queryRaw`
            SELECT * FROM qq.contact_files WHERE contact_id = ${customerId}
        `;
        return Array.isArray(files) ? files : [];
    }

    // Helper: find most recent application in DB files
    static async findApplicationInFiles(files) {
        const foundApps = [];
        for (const file of files) {
            if (file.s3_url && file.file_name_reported.endsWith('pdf')) {
                try {
                    const result = await checkSingleFile(file.s3_url);
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
            const dateA = new Date(a.dbFile.inserted_at);
            const dateB = new Date(b.dbFile.inserted_at);
            return dateB - dateA;
        });
        console.log('[findApplicationInFiles] Most recent application file selected:', foundApps[0]?.dbFile?.s3_url);
        return foundApps[0];
    }

}

export default ParserController;