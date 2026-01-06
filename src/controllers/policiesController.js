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
                'binder_date': 'p.binder_date',
                'assigned_user_name': 'u."fullName"'
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

            // Base from user_policy (already filtered by date/location in sync job)
            let userPolicyCondition = '';
            if (isUserRole && userId) {
                userPolicyCondition = `AND up."userId" = '${userId}'`;
            }

            // First query to count total records (solo personal auto: lob_id = 6)
            const countResult = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) as total_count
                FROM goldenaudit.user_policy up
                INNER JOIN qq.policies p ON up."policyId"::bigint = p.policy_id
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                LEFT JOIN goldenaudit."user" u ON u.id = up."userId"
                WHERE p.business_type = 'N' 
                    ${searchCondition}
                    ${userPolicyCondition}
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
                    c2.display_name as csr,
                    u.id as assigned_user_id,
                    u."fullName" as assigned_user_name
                FROM goldenaudit.user_policy up
                INNER JOIN qq.policies p ON up."policyId"::bigint = p.policy_id
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                LEFT JOIN goldenaudit."user" u ON u.id = up."userId"
                WHERE p.business_type = 'N' 
                    ${searchCondition}
                    ${userPolicyCondition}
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
                csr: policy.csr,
                assigned_user_id: policy.assigned_user_id || null,
                assigned_user_name: policy.assigned_user_name || null
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
                'binder_date': 'p.binder_date',
                'assigned_user_name': 'u."fullName"'
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

            // Base from user_policy (already filtered by date/location in sync job)
            let userPolicyCondition = '';
            if (isUserRole && userId) {
                userPolicyCondition = `AND up."userId" = '${userId}'`;
            }

            // First query to count total records (solo personal auto: lob_id = 6)
            const countResult = await prisma.$queryRawUnsafe(`
                SELECT COUNT(*) as total_count
                FROM goldenaudit.user_policy up
                INNER JOIN qq.policies p ON up."policyId"::bigint = p.policy_id
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                INNER JOIN qq.policies p1 ON p1.policy_id = p.prior_policy_id
                LEFT JOIN goldenaudit."user" u ON u.id = up."userId"
                WHERE p.business_type = 'R' 
                    AND p.policy_status IN ('A', 'C')
                    AND p.carrier_id <> p1.carrier_id
                    ${searchCondition}
                    ${userPolicyCondition}
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
                    c2.display_name as csr,
                    u.id as assigned_user_id,
                    u."fullName" as assigned_user_name
                FROM goldenaudit.user_policy up
                INNER JOIN qq.policies p ON up."policyId"::bigint = p.policy_id
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                INNER JOIN qq.policies p1 ON p1.policy_id = p.prior_policy_id
                LEFT JOIN goldenaudit."user" u ON u.id = up."userId"
                WHERE p.business_type = 'R' 
                    AND p.policy_status IN ('A', 'C')
                    AND p.carrier_id <> p1.carrier_id
                    ${searchCondition}
                    ${userPolicyCondition}
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
                csr: policy.csr,
                assigned_user_id: policy.assigned_user_id || null,
                assigned_user_name: policy.assigned_user_name || null,
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
                'binder_date': 'p.binder_date',
                'assigned_user_name': 'u."fullName"'
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
                FROM goldenaudit.user_policy up
                INNER JOIN qq.policies p ON up."policyId"::bigint = p.policy_id
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                LEFT JOIN goldenaudit."user" u ON u.id = up."userId"
                WHERE up."userId" IS NULL
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
                    c2.display_name as csr,
                    u.id as assigned_user_id,
                    u."fullName" as assigned_user_name
                FROM goldenaudit.user_policy up
                INNER JOIN qq.policies p ON up."policyId"::bigint = p.policy_id
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                INNER JOIN qq.locations l ON l.location_id = c.location_id
                LEFT JOIN goldenaudit."user" u ON u.id = up."userId"
                WHERE up."userId" IS NULL
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
                csr: policy.csr,
                assigned_user_id: policy.assigned_user_id || null,
                assigned_user_name: policy.assigned_user_name || null
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

    static async assignPolicy(request, reply) {
        try {
            const policyId = request.params.policyId;
            const { userId } = request.body;

            // Validate inputs
            if (!policyId || !userId) {
                return reply.code(400).send({
                    success: false,
                    error: 'Policy ID and User ID are required'
                });
            }

            const policyExists = await prisma.userPolicy.findUnique({
                where: {
                    policyId: policyId
                }
            });

            // Upsert user policy assignment
            await prisma.userPolicy.upsert({
                where: {
                    policyId: policyId
                },
                update: {
                    userId: userId
                },
                create: {
                    policyId: policyId,
                    userId: userId
                }
            });

            const updatedAssignment = await prisma.userPolicy.findUnique({
                where: {
                    policyId: policyId
                }
            });

            return {
                success: true,
                message: 'Policy assigned successfully'
            };

        } catch (error) {
            console.error('Error assigning policy:', error);
            return reply.code(500).send({
                success: false,
                error: 'Error assigning policy',
                message: error.message
            });
        }
    }

}

export default PoliciesController;
