import prisma from '../prisma.js';
import { Prisma } from '@prisma/client';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BUCKET } from '../lib/s3.js';
import {
    getFilesForCustomer,
} from '../services/applicationSyncService.js';
import { resolveCarrierName, DOCUMENT_TYPE_LABELS } from '../services/carrierConfig.js';
import { processCustomerFiles } from '../services/documentPipeline.js';
import { buildPolicyWhereClause } from '../lib/policyQueryUtils.js';

export async function resolvePolicyContext(policyId) {
    const result = await prisma.$queryRaw`
        SELECT customer_id, carrier_id, policy_number
        FROM qq.policies
        WHERE policy_id = ${policyId}
        LIMIT 1
    `;

    if (!Array.isArray(result) || result.length === 0) {
        return null;
    }

    const customerId = result[0].customer_id != null ? Number(result[0].customer_id) : null;
    const carrierId = result[0].carrier_id != null ? Number(result[0].carrier_id) : null;
    const policyNumber = result[0].policy_number != null ? String(result[0].policy_number) : null;

    return {
        customerId: customerId != null && !Number.isNaN(customerId) ? customerId : null,
        carrierId: carrierId != null && !Number.isNaN(carrierId) ? carrierId : null,
        policyNumber,
    };
}

function isJsonObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function getApplicationDataForCustomer(reply, customerId) {
    if (!customerId || Number.isNaN(customerId)) {
        return reply.code(404).send({ success: false, message: 'Contact not found' });
    }

    // Join with qq.contact_files to order by the original QQ created_on timestamp
    const rows = await prisma.$queryRaw`
        SELECT cd.id, cd.data
        FROM goldenaudit.customer_document cd
        JOIN qq.contact_files cf ON cf.file_id::text = cd."fileId"
        WHERE cd."customerId" = ${Number(customerId)} AND cd.type = 'application'
        ORDER BY cf.created_on DESC NULLS LAST
        LIMIT 1
    `;

    const doc = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    if (!doc?.data || !isJsonObject(doc.data)) {
        return reply.code(404).send({
            success: false,
            message: 'No application document found for this contact',
        });
    }

    return reply.send({
        success: true,
        customerId,
        data: doc.data,
    });
}

async function saveApplicationDataForCustomer(reply, customerId, payload) {
    if (!customerId || Number.isNaN(customerId)) {
        return reply.code(404).send({ success: false, message: 'Contact not found' });
    }

    if (!isJsonObject(payload)) {
        return reply.code(400).send({
            success: false,
            message: 'data must be a JSON object',
        });
    }

    // Join with qq.contact_files to find the most recent application by QQ created_on
    const existingRows = await prisma.$queryRaw`
        SELECT cd.id
        FROM goldenaudit.customer_document cd
        JOIN qq.contact_files cf ON cf.file_id::text = cd."fileId"
        WHERE cd."customerId" = ${Number(customerId)} AND cd.type = 'application'
        ORDER BY cf.created_on DESC NULLS LAST
        LIMIT 1
    `;

    const existing = Array.isArray(existingRows) && existingRows.length > 0 ? existingRows[0] : null;

    if (!existing) {
        return reply.code(404).send({
            success: false,
            message: 'No application document found for this contact',
        });
    }

    const savedRecord = await prisma.customerDocument.update({
        where: { id: existing.id },
        data: { data: payload },
    });

    return reply.send({
        success: true,
        message: 'Application data saved successfully',
        customerId,
        data: savedRecord.data,
    });
}

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
                    LOWER(c2.display_name) LIKE '%${searchLower}%' OR
                    LOWER(u."fullName") LIKE '%${searchLower}%'
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
                WHERE ${buildPolicyWhereClause({ businessType: 'N', assignment: 'assigned' })}
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
                    p.binder_date,
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
                WHERE ${buildPolicyWhereClause({ businessType: 'N', assignment: 'assigned' })}
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
                binder_date: policy.binder_date,
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
                    LOWER(c2.display_name) LIKE '%${searchLower}%' OR
                    LOWER(u."fullName") LIKE '%${searchLower}%'
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
                WHERE ${buildPolicyWhereClause({ businessType: 'R', assignment: 'assigned', requireCarrierChange: true })}
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
                    p.binder_date,
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
                WHERE ${buildPolicyWhereClause({ businessType: 'R', assignment: 'assigned', requireCarrierChange: true })}
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
                binder_date: policy.binder_date,
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
                    LOWER(c2.display_name) LIKE '%${searchLower}%' OR
                    LOWER(u."fullName") LIKE '%${searchLower}%'
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
                WHERE ${buildPolicyWhereClause({ assignment: 'unassigned' })}
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
                    p.binder_date,
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
                WHERE ${buildPolicyWhereClause({ assignment: 'unassigned' })}
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
                binder_date: policy.binder_date,
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
            if (!policyId || userId === undefined) {
                return reply.code(400).send({
                    success: false,
                    error: 'Policy ID is required and User ID must be provided (can be null to unassign)'
                });
            }

            // Update existing user policy assignment; do not create new rows here
            const updated = await prisma.userPolicy.update({
                where: {
                    policyId: policyId
                },
                data: {
                    userId: userId,
                    autoAssign: false
                }
            });

            if (!updated) {
                return reply.code(404).send({
                    success: false,
                    error: 'Policy not found in user_policy'
                });
            }

            return {
                success: true,
                message: userId ? 'Policy assigned successfully' : 'Policy unassigned successfully'
            };

        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
                request.log.warn({ policyId }, '[assignPolicy] policy not found in user_policy');
                return reply.code(404).send({ success: false, error: 'Policy not found in user_policy' });
            }
            console.error('Error assigning policy:', error);
            return reply.code(500).send({
                success: false,
                error: 'Error assigning policy',
                message: error.message
            });
        }
    }

    static async getPolicyFiles(request, reply) {
        try {
            let { policyId } = request.params;

            if (!policyId) {
                return reply.code(400).send({ success: false, message: 'policyId is required' });
            }

            policyId = Number(policyId);

            if (!Number.isInteger(policyId)) {
                return reply.code(400).send({ success: false, message: 'policyId must be an integer' });
            }

            // Get customer_id (contact_id) from the policy
            const result = await prisma.$queryRaw`
                SELECT customer_id
                FROM qq.policies
                WHERE policy_id = ${policyId}
                LIMIT 1
            `;

            const customerId = Array.isArray(result) && result.length > 0
                ? Number(result[0].customer_id)
                : null;

            if (!customerId) {
                return reply.code(404).send({ success: false, message: 'Policy not found' });
            }

            // Return all classified documents for the customer, deduplicated by type
            // (most recent contact_files.created_on wins when two docs share the same type)
            const docs = await prisma.$queryRaw`
                SELECT DISTINCT ON (cd.type)
                    cd.type,
                    cd.carrier,
                    cd.confidence,
                    cf.file_id,
                    cf.contact_id,
                    cf.created_on,
                    cf.modified_on
                FROM goldenaudit.customer_document cd
                JOIN qq.contact_files cf ON cf.file_id::text = cd."fileId"
                WHERE cd."customerId" = ${customerId}
                ORDER BY cd.type, cf.created_on DESC NULLS LAST
            `;

            const serializedDocs = docs.map(d => ({
                file_id: d.file_id != null ? String(d.file_id) : null,
                contact_id: d.contact_id != null ? Number(d.contact_id) : null,
                created_on: d.created_on || null,
                modified_on: d.modified_on || null,
                type: d.type,
                type_label: DOCUMENT_TYPE_LABELS[d.type] || d.type,
                carrier: d.carrier || null,
                confidence: d.confidence != null ? Number(d.confidence) : null,
            }));

            return {
                success: true,
                count: serializedDocs.length,
                data: serializedDocs,
            };
        } catch (error) {
            console.error('Error fetching policy files:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error fetching policy files',
                error: error.message,
            });
        }
    }

    static async getPolicyDetails(request, reply) {
        try {
            let { policyId } = request.params;

            if (!policyId) {
                return reply.code(400).send({ success: false, message: 'policyId is required' });
            }

            policyId = Number(policyId);

            if (!Number.isInteger(policyId)) {
                return reply.code(400).send({ success: false, message: 'policyId must be an integer' });
            }

            const result = await prisma.$queryRaw`
                SELECT 
                    p.policy_id,
                    p.policy_number,
                    c.display_name as insured_name,
                    c1.display_name as carrier,
                    p.effective_date,
                    p.exp_date,
                    p.binder_date,
                    p.premium,
                    c2.display_name as csr,
                    lob.display_name as lob,
                    p.business_type,
                    c3.display_name as mga,
                    p.policy_status,
                    p.customer_id
                FROM qq.policies p
                INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
                INNER JOIN qq.contacts c1 ON c1.entity_id = p.carrier_id
                INNER JOIN qq.contacts c2 ON c2.entity_id = p.csr_id
                LEFT JOIN admin.lob lob ON lob.lob_id = p.lob_id
                LEFT JOIN qq.contacts c3 ON c3.entity_id = p.mga_id
                WHERE p.policy_id = ${policyId}
                LIMIT 1
            `;

            if (!result || result.length === 0) {
                return reply.code(404).send({ success: false, message: 'Policy not found' });
            }

            const p = result[0];
            const customerId = p.customer_id != null ? Number(p.customer_id) : null;

            let applicationIsProcessed = false;
            if (customerId && !Number.isNaN(customerId)) {
                const userApp = await prisma.userApplication.findUnique({
                    where: { customerId },
                    select: { isProcessed: true },
                });
                applicationIsProcessed = Boolean(userApp?.isProcessed);
            }

            const businessTypeMap = { N: 'New Business', R: 'Renewal', };
            const statusMap = { A: 'Active', C: 'Cancelled', D: 'Deleted', E: 'Expired', P: 'Pending', V: 'Void' };

            return {
                success: true,
                data: {
                    policy_id: p.policy_id != null ? String(p.policy_id) : null,
                    policy_number: p.policy_number || null,
                    insured_name: p.insured_name || null,
                    carrier: p.carrier || null,
                    effective_date: p.effective_date || null,
                    exp_date: p.exp_date || null,
                    binder_date: p.binder_date || null,
                    premium: p.premium != null ? Number(p.premium) : null,
                    csr: p.csr || null,
                    lob: p.lob || null,
                    business_type: businessTypeMap[p.business_type] || p.business_type || null,
                    mga: p.mga || null,
                    status: statusMap[p.policy_status] || p.policy_status || null,
                    application_is_processed: applicationIsProcessed,
                },
            };
        } catch (error) {
            console.error('Error fetching policy details:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error fetching policy details',
                error: error.message,
            });
        }
    }

    static async getPolicyApplicationData(request, reply) {
        try {
            let { policyId } = request.params;

            if (!policyId) {
                return reply.code(400).send({ success: false, message: 'policyId is required' });
            }

            policyId = Number(policyId);

            if (!Number.isInteger(policyId)) {
                return reply.code(400).send({ success: false, message: 'policyId must be an integer' });
            }

            const policyContext = await resolvePolicyContext(policyId);

            if (!policyContext?.customerId) {
                return reply.code(404).send({ success: false, message: 'Policy not found' });
            }

            return getApplicationDataForCustomer(reply, policyContext.customerId);
        } catch (error) {
            console.error('Error fetching policy application data:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error fetching policy application data',
                error: error.message,
            });
        }
    }

    static async savePolicyApplicationData(request, reply) {
        try {
            let { policyId } = request.params;

            if (!policyId) {
                return reply.code(400).send({ success: false, message: 'policyId is required' });
            }

            policyId = Number(policyId);

            if (!Number.isInteger(policyId)) {
                return reply.code(400).send({ success: false, message: 'policyId must be an integer' });
            }

            const policyContext = await resolvePolicyContext(policyId);

            if (!policyContext?.customerId) {
                return reply.code(404).send({ success: false, message: 'Policy not found' });
            }

            return saveApplicationDataForCustomer(reply, policyContext.customerId, request.body?.data);
        } catch (error) {
            console.error('Error saving policy application data:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error saving policy application data',
                error: error.message,
            });
        }
    }

    static async getContactApplicationData(request, reply) {
        try {
            let { contactId } = request.params;

            if (!contactId) {
                return reply.code(400).send({ success: false, message: 'contactId is required' });
            }

            contactId = Number(contactId);

            if (!Number.isInteger(contactId)) {
                return reply.code(400).send({ success: false, message: 'contactId must be an integer' });
            }

            return getApplicationDataForCustomer(reply, contactId);
        } catch (error) {
            console.error('Error fetching contact application data:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error fetching contact application data',
                error: error.message,
            });
        }
    }

    static async saveContactApplicationData(request, reply) {
        try {
            let { contactId } = request.params;

            if (!contactId) {
                return reply.code(400).send({ success: false, message: 'contactId is required' });
            }

            contactId = Number(contactId);

            if (!Number.isInteger(contactId)) {
                return reply.code(400).send({ success: false, message: 'contactId must be an integer' });
            }

            return saveApplicationDataForCustomer(reply, contactId, request.body?.data);
        } catch (error) {
            console.error('Error saving contact application data:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error saving contact application data',
                error: error.message,
            });
        }
    }

    static async auditPolicy(request, reply) {
        try {
            let { policyId } = request.params;

            if (!policyId) {
                return reply.code(400).send({
                    success: false,
                    message: 'policyId is required'
                });
            }

            policyId = Number(policyId);

            if (!Number.isInteger(policyId)) {
                return reply.code(400).send({
                    success: false,
                    message: 'policyId must be an integer'
                });
            }

            // Get customer_id and carrier_id from policy
            const policyContext = await resolvePolicyContext(policyId);
            const customerId = policyContext?.customerId ?? null;
            let carrierId = policyContext?.carrierId ?? null;

            if (!customerId) {
                return reply.code(404).send({
                    success: false,
                    message: 'Policy not found'
                });
            }

            if (Number.isNaN(customerId)) {
                return reply.code(400).send({
                    success: false,
                    message: 'customer_id must be numeric'
                });
            }

            // Resolve carrier name from carrierId via head_carriers
            const carrierName = await resolveCarrierName(carrierId);

            // Get all files for the customer
            const files = await getFilesForCustomer(customerId);

            if (!files || files.length === 0) {
                return reply.send({
                    success: true,
                    data: null
                });
            }

            // Run the LLM pipeline: classify → extract → save to CustomerDocument
            const results = await processCustomerFiles({ customerId, carrierName, files, policyNumber: policyContext.policyNumber });

            // Find the application result
            const applicationResult = results.find(r => r.type === 'application' && r.data);

            return reply.send({
                success: true,
                count: results.length,
                documents: results,
                data: applicationResult?.data || null
            });

        } catch (error) {
            console.error('Error auditing policy:', error);
            return reply.code(500).send({
                success: false,
                message: 'Internal error auditing policy',
                error: error.message
            });
        }
    }

    static async getFileDownloadUrl(request, reply) {
        try {
            let { policyId, fileId } = request.params;

            policyId = Number(policyId);
            if (!Number.isInteger(policyId)) {
                return reply.code(400).send({ success: false, message: 'policyId must be an integer' });
            }

            if (!fileId) {
                return reply.code(400).send({ success: false, message: 'fileId is required' });
            }

            // Verify the file belongs to this policy (security check)
            const policyResult = await prisma.$queryRaw`
                SELECT customer_id FROM qq.policies WHERE policy_id = ${policyId} LIMIT 1
            `;

            if (!policyResult?.length) {
                return reply.code(404).send({ success: false, message: 'Policy not found' });
            }

            const customerId = Number(policyResult[0].customer_id);

            // Verify the file belongs to this policy's customer
            const fileCheck = await prisma.$queryRaw`
                SELECT file_id FROM qq.contact_files
                WHERE file_id::text = ${fileId} AND contact_id = ${customerId}
                LIMIT 1
            `;

            if (!fileCheck?.length) {
                return reply.code(403).send({ success: false, message: 'File not accessible for this policy' });
            }

            // Fetch the s3_url and original filename
            const fileRow = await prisma.$queryRaw`
                SELECT s3_url, file_name_reported
                FROM qq.contact_files
                WHERE file_id = ${fileId}
                LIMIT 1
            `;

            if (!fileRow?.length || !fileRow[0].s3_url) {
                return reply.code(404).send({ success: false, message: 'File not found in S3' });
            }

            const s3Url = fileRow[0].s3_url;
            const fileName = fileRow[0].file_name_reported || 'document';

            // Extract S3 key from the stored URL (format: https://BUCKET.s3.REGION.amazonaws.com/KEY)
            const urlObj = new URL(s3Url);
            const key = urlObj.pathname.slice(1); // Remove leading '/'

            if (!BUCKET) {
                return reply.code(500).send({ success: false, message: 'S3 bucket not configured' });
            }

            // Generate a presigned URL valid for 60 seconds, forcing download with original filename
            const command = new GetObjectCommand({
                Bucket: BUCKET,
                Key: key,
                ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, '')}"`,
            });

            const presignedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });

            return { success: true, url: presignedUrl };

        } catch (error) {
            console.error('Error generating download URL:', error);
            return reply.code(500).send({
                success: false,
                message: 'Error generating download URL',
                error: error.message,
            });
        }
    }
}

export default PoliciesController;
