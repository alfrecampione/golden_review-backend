import prisma from '../prisma.js';

// Controller for policies endpoints
class PoliciesController {

    /**
     * Get all policies with detailed information
     * Query joins policies with contacts and locations tables
     * Supports pagination and search
     */
    static async getNewBusiness(request, reply) {
        try {
            // Get pagination parameters from query
            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit) || 25;
            const search = request.query.search || '';
            const offset = (page - 1) * limit;

            // Build search condition
            let searchCondition = '';
            if (search) {
                const searchLower = search.toLowerCase();
                searchCondition = `AND (
                    LOWER(p.policy_number) LIKE '%${searchLower}%' OR
                    LOWER(c.display_name) LIKE '%${searchLower}%' OR
                    LOWER(c1.display_name) LIKE '%${searchLower}%' OR
                    LOWER(c2.display_name) LIKE '%${searchLower}%'
                )`;
            }

            // Execute raw SQL query to get policies with total count using window function
            const policies = await prisma.$queryRawUnsafe(`
                SELECT 
                    p.policy_number, 
                    c.display_name as insured_name, 
                    p.effective_date, 
                    p.exp_date, 
                    c1.display_name as carrier, 
                    p.premium, 
                    c2.display_name as csr,
                    COUNT(*) OVER () as total_count
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                WHERE p.binder_date >= '12/01/2025' 
                    AND p.business_type = 'N' 
                    AND l.location_type = 1
                    ${searchCondition}
                ORDER BY p.binder_date
                LIMIT ${limit} OFFSET ${offset}
            `);

            // Get total count from first row (same for all rows due to window function)
            const totalCount = policies.length > 0 ? Number(policies[0].total_count) : 0;
            const totalPages = Math.ceil(totalCount / limit);

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
                count: policies.length,
                page: page,
                limit: limit,
                totalPages: totalPages,
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

    static async getRenewals(request, reply) {
        try {
            // Get pagination parameters from query
            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit) || 25;
            const search = request.query.search || '';
            const offset = (page - 1) * limit;

            // Build search condition
            let searchCondition = '';
            if (search) {
                const searchLower = search.toLowerCase();
                searchCondition = `AND (
                    LOWER(p.policy_number) LIKE '%${searchLower}%' OR
                    LOWER(c.display_name) LIKE '%${searchLower}%' OR
                    LOWER(c1.display_name) LIKE '%${searchLower}%' OR
                    LOWER(c2.display_name) LIKE '%${searchLower}%'
                )`;
            }

            // Execute raw SQL query to get policies with total count using window function
            const policies = await prisma.$queryRawUnsafe(`
                SELECT 
                    p.policy_number, 
                    c.display_name as insured_name, 
                    p.effective_date, 
                    p.exp_date, 
                    c1.display_name as carrier, 
                    p.premium, 
                    c2.display_name as csr,
                    COUNT(*) OVER () as total_count
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                WHERE p.binder_date >= '12/01/2025' 
                    AND p.business_type = 'R' 
                    AND l.location_type = 1
                    ${searchCondition}
                ORDER BY p.binder_date
                LIMIT ${limit} OFFSET ${offset}
            `);

            // Get total count from first row (same for all rows due to window function)
            const totalCount = policies.length > 0 ? Number(policies[0].total_count) : 0;
            const totalPages = Math.ceil(totalCount / limit);

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
                count: policies.length,
                page: page,
                limit: limit,
                totalPages: totalPages,
                data: serializedPolicies
            };

        } catch (error) {
            console.error('Error fetching renewals:', error);
            return reply.code(500).send({
                success: false,
                error: 'Error fetching renewals',
                message: error.message
            });
        }
    }

}

export default PoliciesController;
