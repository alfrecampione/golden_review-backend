export const ACTIVE_POLICY_STATUS_CONDITION = "p.policy_status IN ('A', 'C', 'E')";

export function buildPolicyWhereClause({
    businessType = null,
    assignment = null,
    requireCarrierChange = false,
} = {}) {
    const conditions = [];

    if (businessType) {
        conditions.push(`p.business_type = '${businessType}'`);
    }

    conditions.push(ACTIVE_POLICY_STATUS_CONDITION);

    if (assignment === 'assigned') {
        conditions.push(`up."userId" IS NOT NULL`);
    } else if (assignment === 'unassigned') {
        conditions.push(`up."userId" IS NULL`);
    }

    if (requireCarrierChange) {
        conditions.push(`p.carrier_id <> p1.carrier_id`);
    }

    return conditions.join('\n                    AND ');
}

export function buildPolicySyncWhereClause({
    businessType,
    requireCarrierChange = false,
} = {}) {
    const conditions = [
        `p.policy_id IS NOT NULL`,
        `p.business_type = '${businessType}'`,
        ACTIVE_POLICY_STATUS_CONDITION,
        `p.created_on >= '04/01/2026'`,
        `p.lob_id = 6`,
        `l.location_type = 1`,
    ];

    if (requireCarrierChange) {
        conditions.push(`p.carrier_id <> p1.carrier_id`);
    }

    return conditions.join('\n          AND ');
}