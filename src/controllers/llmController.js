import { getFilesForCustomer } from '../services/applicationSyncService.js';
import { resolvePolicyContext } from '../controllers/policiesController.js';
import { resolveCarrierName } from '../services/carrierConfig.js';
import { processCustomerFiles, processSingleBuffer } from '../services/documentPipeline.js';

export async function processDocumentWithBedrock(request, reply) {
    try {
        const { fileBuffer, carrier } = request.body || {};

        if (!fileBuffer) {
            return reply.code(400).send({ success: false, message: 'fileBuffer is required' });
        }

        const buffer = Buffer.from(fileBuffer, 'base64');
        const results = await processSingleBuffer(buffer, carrier);

        return reply.send({ success: true, documents: results });
    } catch (error) {
        console.error('processDocumentWithBedrock error:', error);
        return reply.code(500).send({ success: false, error: error.message });
    }
}

export async function processsCustomerWithBedrock(request, reply) {
    try {
        let { policyId } = request.params;

        policyId = Number(policyId);
        if (!Number.isInteger(policyId)) {
            return reply.code(400).send({ success: false, message: 'Invalid policyId' });
        }

        const context = await resolvePolicyContext(policyId);
        if (!context?.customerId) {
            return reply.code(404).send({ success: false, message: 'Policy not found' });
        }

        const carrierName = await resolveCarrierName(context.carrierId);
        const files = await getFilesForCustomer(context.customerId);
        const results = await processCustomerFiles({
            customerId: context.customerId,
            carrierName,
            files,
            policyNumber: context.policyNumber,
        });

        return reply.send({ success: true, count: results.length, data: results });
    } catch (error) {
        console.error('LLM pipeline error:', error);
        return reply.code(500).send({ success: false, error: error.message });
    }
}