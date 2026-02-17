import prisma from '../prisma.js';
import { downloadFilesToDB } from '../services/contactFilesService.js';
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

            const syncResult = await downloadFilesToDB(numericCustomerId);

            // Si se detectó aplicación de seguro, inclúyela en la respuesta
            let applicationInfo = null;
            let lambdaResult = null;
            if (syncResult && Array.isArray(syncResult.applications) && syncResult.applications.length > 0) {
                applicationInfo = syncResult.applications;
                // Selecciona la aplicación más reciente
                const sortedApps = applicationInfo.slice().sort((a, b) => b.size - a.size);
                let mostRecent = sortedApps[0];
                if (applicationInfo.length > 1 && applicationInfo[0].fileName && applicationInfo[0].fileName.match(/\d{4}-\d{2}-\d{2}/)) {
                    mostRecent = applicationInfo.slice().sort((a, b) => {
                        const getDate = (f) => {
                            const m = f.fileName.match(/(\d{4}-\d{2}-\d{2})/);
                            return m ? new Date(m[1]) : new Date(0);
                        };
                        return getDate(b) - getDate(a);
                    })[0];
                }
                // Llama a la función Lambda AWS
                try {
                    lambdaResult = await invokePdfLambda(mostRecent.s3Url);
                } catch (lambdaErr) {
                    lambdaResult = { error: 'Error invoking Lambda', details: lambdaErr.message };
                }
            }

            return reply.send({
                success: true,
                policyNumber,
                customerId: numericCustomerId,
                sync: syncResult,
                applicationInfo,
                lambdaResult
            });
        } catch (error) {
            console.error('Error fetching customer_id by policyNumber:', error);
            // If error is AxiosError with response from QQ Catalyst, propagate status and data
            if (error.response && error.response.status && error.response.data) {
                return reply.code(error.response.status).send({
                    success: false,
                    message: 'Error from QQ Catalyst',
                    error: error.response.data
                });
            }
            // Otherwise, fallback to generic 500
            return reply.code(500).send({
                success: false,
                message: 'Internal error fetching customer_id',
                error: error.message
            });
        }
    }

}

export default ParserController;