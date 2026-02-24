// jobs/fileSyncFromPolicyLogsJob.js
import cron from 'node-cron';
import prisma from '../prisma.js';
import { Prisma } from '@prisma/client';
import { syncAndFindApplication } from '../services/applicationSyncService.js';
import { invokePdfLambda } from '../services/lambdaInvoke.js';

/**
 * Process all policy IDs logged in UpdatePolicyJobLog from the previous day.
 * For each associated customer:
 *  - Sync files to S3/DB
 *  - Find the most recent application file
 *  - Store in UserApplication and invoke Lambda to extract data
 *  - Mark as processed on success
 */
async function syncFilesFromPolicyLogs() {
    // 1) Determine UTC range for yesterday
    const now = new Date();
    const startOfYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0, 0));
    const endOfYesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 23, 59, 59, 999));

    // 2) Fetch all UpdatePolicyJobLog entries from that day
    const policyLogs = await prisma.updatePolicyJobLog.findMany({
        where: {
            createdAt: {
                gte: startOfYesterday,
                lte: endOfYesterday,
            },
        },
    });

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
            // a-c) Sync files, get files, and find application in one step
            const { syncResult, applicationInfo } = await syncAndFindApplication(customerId);
            console.log(`[syncFilesFromPolicyLogs] Customer ${customerId} sync result:`, syncResult);

            if (!applicationInfo) {
                console.log(`[syncFilesFromPolicyLogs] No application file found for customer ${customerId}`);
                processedCount++;
                processedCustomerIds.push(customerId);
                continue;
            }

            const s3Url = applicationInfo.s3Url;

            // d) Check or create UserApplication record
            let userApp = await prisma.userApplication.findUnique({
                where: { customerId: customerId },
            });

            if (!userApp) {
                userApp = await prisma.userApplication.create({
                    data: {
                        customerId: customerId,
                        applicationS3file: s3Url,
                        isProcessed: false,
                    },
                });
            } else if (userApp.isProcessed) {
                console.log(`[syncFilesFromPolicyLogs] Customer ${customerId} already processed, skipping`);
                processedCount++;
                processedCustomerIds.push(customerId);
                continue;
            } else if (userApp.applicationS3file !== s3Url) {
                userApp = await prisma.userApplication.update({
                    where: { id: userApp.id },
                    data: {
                        applicationS3file: s3Url,
                        isProcessed: false,
                    },
                });
            }

            // e) Invoke Lambda to process the PDF
            let lambdaResult;
            try {
                lambdaResult = await invokePdfLambda(s3Url);
                console.log(`[syncFilesFromPolicyLogs] Lambda success for customer ${customerId}:`, lambdaResult);

                await prisma.userApplication.update({
                    where: { id: userApp.id },
                    data: { isProcessed: true },
                });

                processedCount++;
                processedCustomerIds.push(customerId);
            } catch (lambdaErr) {
                console.error(`[syncFilesFromPolicyLogs] Lambda failed for customer ${customerId}:`, lambdaErr);
                failedCount++;
            }
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

export function startFilesFromPolicyLogsJob() {
    if (jobStarted) return;

    // Run daily at 00:00 UTC
    cron.schedule('0 0 * * *', () => {
        syncFilesFromPolicyLogs()
            .then(res => console.log('[filesFromPolicyLogsJob] Scheduled run result:', res))
            .catch(err => console.error('[filesFromPolicyLogsJob] Scheduled run failed:', err));
    });

    console.log('[filesFromPolicyLogsJob] starting...');
    // Optionally run once at startup (process previous day immediately)
    syncFilesFromPolicyLogs()
        .then(res => console.log('[filesFromPolicyLogsJob] Initial run result:', res))
        .catch(err => console.error('[filesFromPolicyLogsJob] Initial run failed:', err));

    jobStarted = true;
}

export { syncFilesFromPolicyLogs };