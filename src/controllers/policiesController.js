import prisma from '../prisma.js';

// Controller for policies endpoints
class PoliciesController {

    /**
     * Get all policies with detailed information
     * Query joins policies with contacts and locations tables
     * Supports pagination and search
     * Filters by user carriers if user role is "User"
     */
    static async getNewBusiness(request, reply) {
        try {
            // Get pagination parameters from query
            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit) || 25;
            const search = request.query.search || '';
            const sortBy = request.query.sortBy || 'binder_date';
            const sortOrder = request.query.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            const offset = (page - 1) * limit;

            // Map frontend column names to database column names
            const sortColumnMap = {
                'policy_number': 'p.policy_number',
                'insured_name': 'c.display_name',
                'carrier': 'c1.display_name',
                'effective_date': 'p.effective_date',
                'exp_date': 'p.exp_date',
                'premium': 'p.premium',
                'csr': 'c2.display_name',
                'binder_date': 'p.binder_date'
            };

            const sortColumn = sortColumnMap[sortBy] || 'p.binder_date';

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

            // Check if user has "User" role
            const isUserRole = request.user?.roles?.includes('User');
            const userId = request.user?.id;

            // Build join and where clause for user carrier filtering
            let userCarrierJoin = '';
            let userCarrierCondition = '';
            if (isUserRole && userId) {
                userCarrierJoin = `INNER JOIN goldenaudit.user_carrier uc ON uc."carrierId"::integer = p.carrier_id`;
                userCarrierCondition = `AND uc."userId" = '${userId}'`;
            }

            // First query to count total records (solo personal auto: lob_id = 6)
            const countResult = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) as total_count
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                ${userCarrierJoin}
                WHERE p.binder_date >= '01/01/2026' 
                    AND p.business_type = 'N' 
                    AND l.location_type = 1
                    AND p.lob_id = 6
                    ${searchCondition}
                    ${userCarrierCondition}
            `);

            const totalCount = countResult.length > 0 ? Number(countResult[0].total_count) : 0;
            const totalPages = Math.ceil(totalCount / limit);

            // Second query to get paginated results with dynamic sorting (solo personal auto: lob_id = 6)
            const policies = await prisma.$queryRawUnsafe(`
                SELECT 
                    p.policy_id,
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
                ${userCarrierJoin}
                WHERE p.binder_date >= '01/01/2026' 
                    AND p.business_type = 'N' 
                    AND l.location_type = 1
                    AND p.lob_id = 6
                    ${searchCondition}
                    ${userCarrierCondition}
                ORDER BY ${sortColumn} ${sortOrder}
                LIMIT ${limit} OFFSET ${offset}
            `);

            // Convert BigInt values to strings for JSON serialization
            const serializedPolicies = policies.map(policy => ({
                policy_id: policy.policy_id,
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
                count: totalCount,
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
            const sortBy = request.query.sortBy || 'binder_date';
            const sortOrder = request.query.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            const offset = (page - 1) * limit;

            // Map frontend column names to database column names
            const sortColumnMap = {
                'policy_number': 'p.policy_number',
                'insured_name': 'c.display_name',
                'carrier': 'c1.display_name',
                'effective_date': 'p.effective_date',
                'exp_date': 'p.exp_date',
                'premium': 'p.premium',
                'csr': 'c2.display_name',
                'binder_date': 'p.binder_date'
            };

            const sortColumn = sortColumnMap[sortBy] || 'p.binder_date';

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

            // Check if user has "User" role
            const isUserRole = request.user?.roles?.includes('User');
            const userId = request.user?.id;

            // Build join and where clause for user carrier filtering
            let userCarrierJoin = '';
            let userCarrierCondition = '';
            if (isUserRole && userId) {
                userCarrierJoin = `INNER JOIN goldenaudit.user_carrier uc ON uc."carrierId"::integer = p.carrier_id`;
                userCarrierCondition = `AND uc."userId" = '${userId}'`;
            }

            // First query to count total records (solo personal auto: lob_id = 6)
            const countResult = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) as total_count
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                INNER JOIN qq.policies p1 ON p1.policy_id = p.prior_policy_id
                ${userCarrierJoin}
                WHERE p.created_on >= '01/01/2026' 
                    AND p.business_type = 'R' 
                    AND l.location_type = 1
                    AND p.policy_status IN ('A', 'C')
                    AND p.carrier_id <> p1.carrier_id
                    AND p.lob_id = 6
                    ${searchCondition}
                    ${userCarrierCondition}
            `);

            const totalCount = countResult.length > 0 ? Number(countResult[0].total_count) : 0;
            const totalPages = Math.ceil(totalCount / limit);

            // Second query to get paginated results with dynamic sorting (solo personal auto: lob_id = 6)
            const policies = await prisma.$queryRawUnsafe(`
                SELECT 
                    p.policy_id,
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
                INNER JOIN qq.policies p1 ON p1.policy_id = p.prior_policy_id
                ${userCarrierJoin}
                WHERE p.created_on >= '01/01/2026' 
                    AND p.business_type = 'R' 
                    AND l.location_type = 1
                    AND p.policy_status IN ('A', 'C')
                    AND p.carrier_id <> p1.carrier_id
                    AND p.lob_id = 6
                    ${searchCondition}
                    ${userCarrierCondition}
                ORDER BY ${sortColumn} ${sortOrder}
                LIMIT ${limit} OFFSET ${offset}
            `);

            // Convert BigInt values to strings for JSON serialization
            const serializedPolicies = policies.map(policy => ({
                policy_id: policy.policy_id,
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
                count: totalCount,
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

    static async getUnassignedPolicies(request, reply) {
        try {
            // Get pagination parameters from query
            const page = parseInt(request.query.page) || 1;
            const limit = parseInt(request.query.limit) || 25;
            const search = request.query.search || '';
            const sortBy = request.query.sortBy || 'binder_date';
            const sortOrder = request.query.sortOrder?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            const offset = (page - 1) * limit;

            // Map frontend column names to database column names
            const sortColumnMap = {
                'policy_number': 'p.policy_number',
                'insured_name': 'c.display_name',
                'carrier': 'c1.display_name',
                'effective_date': 'p.effective_date',
                'exp_date': 'p.exp_date',
                'premium': 'p.premium',
                'csr': 'c2.display_name',
                'binder_date': 'p.binder_date'
            };
            const sortColumn = sortColumnMap[sortBy] || 'p.binder_date';

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


            // First query to count total records (solo personal auto: lob_id = 6)
            const countResult = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) as total_count
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                WHERE p.binder_date >= '01/01/2026'
                    AND l.location_type = 1
                    AND p.lob_id = 6
                    AND NOT EXISTS (
                        SELECT 1 FROM goldenaudit.user_carrier uc WHERE uc."carrierId"::integer = p.carrier_id
                    )
                    ${searchCondition}
            `);

            const totalCount = countResult.length > 0 ? Number(countResult[0].total_count) : 0;
            const totalPages = Math.ceil(totalCount / limit);


            // Second query to get paginated results with dynamic sorting (solo personal auto: lob_id = 6)
            const policies = await prisma.$queryRawUnsafe(`
                SELECT 
                    p.policy_id,
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
                WHERE p.binder_date >= '01/01/2026'
                    AND l.location_type = 1
                    AND p.lob_id = 6
                    AND NOT EXISTS (
                        SELECT 1 FROM goldenaudit.user_carrier uc WHERE uc."carrierId"::integer = p.carrier_id
                    )
                    ${searchCondition}
                ORDER BY ${sortColumn} ${sortOrder}
                LIMIT ${limit} OFFSET ${offset}
            `);

            // Convert BigInt values to strings for JSON serialization
            const serializedPolicies = policies.map(policy => ({
                policy_id: policy.policy_id,
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
                count: totalCount,
                page: page,
                limit: limit,
                totalPages: totalPages,
                data: serializedPolicies
            };
        }
        catch (error) {
            console.error('Error fetching unassigned policies:', error);
            return reply.code(500).send({
                success: false,
                error: 'Error fetching unassigned policies',
                message: error.message
            });
        }
    }

}

export default PoliciesController;
