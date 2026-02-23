import prisma from '../prisma.js';
import { syncAndFindApplication } from '../services/applicationSyncService.js';
import { invokePdfLambda } from '../services/lambdaInvoke.js';

class ParserController {
    static auditPolicy = async (request, reply) => {
        try {
            const { policyId } = request.params;
            if (!policyId) {
                return reply.code(400).send({
                    success: false,
                    message: 'policyId is required'
                });
            }

            // 1. Get customerId from policyId
            const result = await prisma.$queryRaw`
                SELECT customer_id
                FROM qq.policies
                WHERE policy_id = ${policyId}
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


            // 2-4. Sync files, get files, and find application in one step
            const { syncResult, applicationInfo } = await syncAndFindApplication(numericCustomerId);
            console.log('[auditPolicy] Sync result:', syncResult);
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
            console.error('Error fetching customer_id by policyId:', error);
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



}

export default ParserController;