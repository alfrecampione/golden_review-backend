import cron from 'node-cron';
import { Prisma } from '@prisma/client';
import prisma from '../prisma.js';

async function syncPoliciesOnce() {
    // 0) Find last sync timestamp
    const lastLog = await prisma.updatePolicyJobLog.findFirst({
        orderBy: { createdAt: 'desc' },
    });

    // 1) Fetch NewBusiness policies created after last sync (or all if none)
    const since = lastLog?.createdAt;

    const newBusinessPolicies = await prisma.$queryRaw`
        SELECT p.policy_id, p.carrier_id, p.created_on
        FROM qq.policies p
        INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
        INNER JOIN qq.locations l ON l.location_id = c.location_id
        WHERE p.policy_id IS NOT NULL
          AND p.business_type = 'N'
          AND p.binder_date >= '01/01/2026'
          AND p.lob_id = 6
          AND l.location_type = 1
          ${since ? Prisma.sql`AND p.created_on > (${since} AT TIME ZONE 'UTC')` : Prisma.empty}
    `;

    // 1b) Fetch Renewal policies with carrier change filter
    const renewalPolicies = await prisma.$queryRaw`
        SELECT p.policy_id, p.carrier_id, p.created_on
        FROM qq.policies p
        INNER JOIN qq.contacts c ON c.entity_id = p.customer_id
        INNER JOIN qq.locations l ON l.location_id = c.location_id
        INNER JOIN qq.policies p1 ON p1.policy_id = p.prior_policy_id
        WHERE p.policy_id IS NOT NULL
          AND p.business_type = 'R'
          AND p.policy_status IN ('A', 'C')
          AND p.carrier_id <> p1.carrier_id
          AND p.binder_date >= '01/01/2026'
          AND p.lob_id = 6
          AND l.location_type = 1
          ${since ? Prisma.sql`AND p.created_on > (${since} AT TIME ZONE 'UTC')` : Prisma.empty}
    `;

    const policies = [...newBusinessPolicies, ...renewalPolicies];

    if (!policies || policies.length === 0) {
        return { totalPolicies: 0, assigned: 0 };
    }

    // 2) Build a carrierId -> userId map (first user per carrier wins)
    const links = await prisma.userCarrier.findMany({
        select: { userId: true, carrierId: true },
    });

    const carrierToUser = new Map();
    for (const link of links) {
        const cid = String(link.carrierId);
        if (!carrierToUser.has(cid)) {
            carrierToUser.set(cid, link.userId);
        }
    }

    // 3) Prepare rows for user_policy
    const rows = policies.map((p) => {
        const policyId = String(p.policy_id);
        const carrierId = p.carrier_id ? String(p.carrier_id) : null;
        const userId = carrierId ? carrierToUser.get(carrierId) || null : null;
        return { policyId, userId };
    });

    // 4) Insert new rows (only new policies, so no delete needed)
    await prisma.userPolicy.createMany({ data: rows, skipDuplicates: true });

    // 5) Log the run
    await prisma.updatePolicyJobLog.create({
        data: {
            policyIds: rows.map((r) => r.policyId),
            count: rows.length,
        },
    });

    const assigned = rows.filter((r) => r.userId).length;
    return { totalPolicies: rows.length, assigned };
}

let jobStarted = false;

export function startPoliciesSyncJob() {
    if (jobStarted) return;

    // Run daily at 01:00 UTC
    cron.schedule('0 1 * * *', () => {
        syncPoliciesOnce().catch((err) => console.error('[syncPoliciesJob] failed:', err));
    });

    console.log('[syncPoliciesJob] starting...');
    // Kick off once at startup and log resolved result
    syncPoliciesOnce()
        .then((res) => console.log('[syncPoliciesJob] initial run result:', res))
        .catch((err) => console.error('[syncPoliciesJob] initial run failed:', err));

    jobStarted = true;
}

export { syncPoliciesOnce };
