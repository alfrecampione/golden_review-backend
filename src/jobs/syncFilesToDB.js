// jobs/fileSyncFromPolicyLogsJob.js
import cron from 'node-cron';
import prisma from '../prisma.js';
import { Prisma } from '@prisma/client';
import { getFilesForCustomer } from '../services/applicationSyncService.js';
import { resolveCarrierName } from '../services/carrierConfig.js';
import { processCustomerFiles } from '../services/documentPipeline.js';
import { downloadFilesToDB } from '../services/contactFilesService.js';

/**
 * Process all policy IDs logged in UpdatePolicyJobLog from the previous day.
 * For each associated customer:
 *  - Sync files to S3/DB
 *  - Run LLM pipeline to classify and extract data → save to CustomerDocument
 */
/**
 * @param {boolean} [onlyYesterday=true] Si true, procesa solo los logs de ayer; si false, procesa toda la tabla
 */
async function syncFilesFromPolicyLogs(onlyYesterday = true) {
    // 1) Determine range or fetch all
    let policyLogs;
    if (onlyYesterday) {
        const now = new Date();
        const startOfYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
        const endOfYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59, 999));
        // 2) Fetch all UpdatePolicyJobLog entries from that day
        policyLogs = await prisma.updatePolicyJobLog.findMany({
            where: {
                createdAt: {
                    gte: startOfYesterday,
                    lte: endOfYesterday,
                },
            },
        });
    } else {
        // Fetch all logs
        policyLogs = await prisma.updatePolicyJobLog.findMany();
    }

    if (!policyLogs.length) {
        return {
            message: 'No policy logs found for the previous day',
            processedLogIds: [],
            policyCount: 0,
            customerCount: 0,
            processedCustomers: 0,
            failedCustomers: 0,
        };
    }

    // 3) Extract all policy IDs (JSON array)
    const allPolicyIds = [];
    for (const log of policyLogs) {
        if (Array.isArray(log.policyIds)) {
            allPolicyIds.push(...log.policyIds.map(id => Number(id)).filter(id => Number.isInteger(id)));
        }
    }

    if (allPolicyIds.length === 0) {
        return {
            message: 'No policy IDs found in the logs',
            processedLogIds: policyLogs.map(l => l.id),
            policyCount: 0,
            customerCount: 0,
            processedCustomers: 0,
            failedCustomers: 0,
        };
    }

    // 4) Get unique customer IDs for these policy IDs (policyId is int)
    const customerRows = await prisma.$queryRaw`
        SELECT DISTINCT customer_id
        FROM qq.policies
        WHERE policy_id IN (${Prisma.join(allPolicyIds)})
    `;

    const uniqueCustomerIds = customerRows
        .map(row => row.customer_id)
        .filter(id => id != null)
        .map(id => Number(id));

    if (uniqueCustomerIds.length === 0) {
        return {
            message: 'No valid customers found for the policy IDs',
            processedLogIds: policyLogs.map(l => l.id),
            policyCount: allPolicyIds.length,
            customerCount: 0,
            processedCustomers: 0,
            failedCustomers: 0,
        };
    }

    // 5) Process each customer
    let processedCount = 0;
    let failedCount = 0;
    const processedCustomerIds = [];

    for (const customerId of uniqueCustomerIds) {
        try {
            // Resolve carrier
            let carrierId = null;
            try {
                const carrierResult = await prisma.$queryRaw`
                    SELECT carrier_id
                    FROM qq.policies
                    WHERE customer_id = ${customerId}
                    ORDER BY policy_id DESC
                    LIMIT 1
                `;
                if (Array.isArray(carrierResult) && carrierResult.length > 0) {
                    carrierId = Number(carrierResult[0].carrier_id);
                }
            } catch (carrierErr) {
                console.error(`[syncFilesFromPolicyLogs] Error fetching carrier_id for customer ${customerId}:`, carrierErr);
            }

            const carrierName = await resolveCarrierName(carrierId);

            // Sync files from QQ to S3/DB
            try {
                await downloadFilesToDB(customerId);
            } catch (syncErr) {
                console.error(`[syncFilesFromPolicyLogs] File sync failed for customer ${customerId}:`, syncErr);
            }

            // Get all files and run the LLM pipeline
            const files = await getFilesForCustomer(customerId);

            if (!files || files.length === 0) {
                console.log(`[syncFilesFromPolicyLogs] No files found for customer ${customerId}`);
                processedCount++;
                processedCustomerIds.push(customerId);
                continue;
            }

            const results = await processCustomerFiles({ customerId, carrierName, files });
            console.log(`[syncFilesFromPolicyLogs] Customer ${customerId}: ${results.length} document(s) saved to CustomerDocument`);

            processedCount++;
            processedCustomerIds.push(customerId);
        } catch (err) {
            console.error(`[syncFilesFromPolicyLogs] Failed to process customer ${customerId}:`, err);
            failedCount++;
        }
    }

    // 6) Log the job run
    await prisma.fileSyncJobLog.create({
        data: {
            processedLogIds: policyLogs.map(l => l.id),
            customerCount: processedCount,   // number of customers successfully processed (including no app)
            policyCount: allPolicyIds.length,
        },
    });

    return {
        message: 'File sync completed',
        processedLogIds: policyLogs.map(l => l.id),
        policyCount: allPolicyIds.length,
        customerCount: uniqueCustomerIds.length,
        processedCustomers: processedCount,
        failedCustomers: failedCount,
    };
}

let jobStarted = false;

export function startFilesFromPolicyLogsJob(onlyYesterday = true, runOnStartup = true) {
    if (jobStarted) {
        console.log('[filesFromPolicyLogsJob] already started, skipping new scheduler registration');
        return;
    }

    console.log(`[filesFromPolicyLogsJob] starting... onlyYesterday=${onlyYesterday} runOnStartup=${runOnStartup}`);

    // Run daily at 05:00 UTC
    cron.schedule('0 5 * * *', () => {
        syncFilesFromPolicyLogs(onlyYesterday)
            .then(res => console.log('[filesFromPolicyLogsJob] Scheduled run result:', res))
            .catch(err => console.error('[filesFromPolicyLogsJob] Scheduled run failed:', err));
    });

    if (runOnStartup) {
        syncFilesFromPolicyLogs(onlyYesterday)
            .then(res => console.log('[filesFromPolicyLogsJob] Initial run result:', res))
            .catch(err => console.error('[filesFromPolicyLogsJob] Initial run failed:', err));
    } else {
        console.log('[filesFromPolicyLogsJob] initial run skipped because runOnStartup=false');
    }

    jobStarted = true;
}

export { syncFilesFromPolicyLogs };