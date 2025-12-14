import prisma from '../prisma.js';

// Controller for policies endpoints
class PoliciesController {

    /**
     * Get all policies with detailed information
     * Query joins policies with contacts and locations tables
     */
    static async getPolicies(request, reply) {
        try {
            // Execute raw SQL query to get policies with all related data
            const policies = await prisma.$queryRaw`
                SELECT 
                    p.policy_number, 
                    c.display_name as insured_name, 
                    p.effective_date, 
                    p.exp_date, 
                    c1.display_name as carrier, 
                    p.premium, 
                    c2.display_name as csr
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                WHERE p.binder_date >= '12/01/2025' 
                    AND p.business_type = 'N' 
                    AND l.location_type = 1
                ORDER BY p.binder_date
            `;

            // Convert BigInt values to strings for JSON serialization
            const serializedPolicies = policies.map(policy => ({
                policy_number: policy.policy_number,
                insured_name: policy.insured_name,
                effective_date: policy.effective_date,
                exp_date: policy.exp_date,
                carrier: policy.carrier,
                premium: policy.premium !== null ? Number(policy.premium) : null,
                csr: policy.csr
            }));

            return {
                success: true,
                count: serializedPolicies.length,
                data: serializedPolicies
            };

        } catch (error) {
            console.error('Error fetching policies:', error);
            return reply.code(500).send({
                success: false,
                error: 'Error fetching policies',
                message: error.message
            });
        }
    }
}

export default PoliciesController;
