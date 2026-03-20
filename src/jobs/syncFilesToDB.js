// jobs/fileSyncFromPolicyLogsJob.js
import cron from 'node-cron';
import prisma from '../prisma.js';
import { Prisma } from '@prisma/client';
import {
    getStoredJsonForCustomer,
    saveJsonForCustomer,
    syncAndFindApplication,
} from '../services/applicationSyncService.js';
import { invokePdfLambda } from '../services/lambdaInvoke.js';
import { mapLambdaResultToPolicyJson } from '../lib/utils.js';

function extractFileId(applicationInfo) {
    if (applicationInfo?.dbFile?.file_id) {
        return String(applicationInfo.dbFile.file_id);
    }
    if (applicationInfo?.fileId) {
        return String(applicationInfo.fileId);
    }
    if (applicationInfo?.file_id) {
        return String(applicationInfo.file_id);
    }
    if (typeof applicationInfo === 'string') {
        return applicationInfo;
    }
    return null;
}

/**
 * Process all policy IDs logged in UpdatePolicyJobLog from the previous day.
 * For each associated customer:
 *  - Sync files to S3/DB
 *  - Find the most recent application file
 *  - Store in UserApplication and invoke Lambda to extract data
 *  - Mark as processed on success
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
            const storedJson = await getStoredJsonForCustomer(customerId);
            if (storedJson?.data) {
                console.log(`[syncFilesFromPolicyLogs] Customer ${customerId} already has cached JSON, skipping`);
                processedCount++;
                processedCustomerIds.push(customerId);
                continue;
            }

            // Resolve carrier before file detection so keyword matching can be carrier-specific.
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

                const headCarrierRaw = await prisma.$queryRaw`
                    SELECT head_carrier_id
                    FROM intranet.head_carriers hc
                    WHERE ${carrierId} IN (hc.carrier_id)
                `;

                const headCarrierId = headCarrierRaw[0]?.head_carrier_id;
                if (headCarrierId) {
                    carrierId = Number(headCarrierId);
                }
            } catch (carrierErr) {
                console.error(`[syncFilesFromPolicyLogs] Error fetching carrier_id for customer ${customerId}:`, carrierErr);
            }

            // Check UserApplication first to avoid expensive sync work for already processed customers.
            let userApp = await prisma.userApplication.findUnique({
                where: { customerId: customerId },
            });

            if (userApp?.isProcessed && userApp.fileId) {
                console.log(`[syncFilesFromPolicyLogs] Customer ${customerId} already processed, skipping`);
                processedCount++;
                processedCustomerIds.push(customerId);
                continue;
            }

            let fileId = userApp?.fileId || null;

            if (!fileId) {
                // a-c) Sync files, get files, and find application in one step only when needed.
                const { syncResult, applicationInfo } = await syncAndFindApplication(customerId, {
                    carrierId,
                });
                console.log(`[syncFilesFromPolicyLogs] Customer ${customerId} sync result:`, syncResult);

                if (!applicationInfo) {
                    console.log(`[syncFilesFromPolicyLogs] No application file found for customer ${customerId}`);
                    processedCount++;
                    processedCustomerIds.push(customerId);
                    continue;
                }

                fileId = extractFileId(applicationInfo);
            }

            if (!fileId) {
                console.error(`[syncFilesFromPolicyLogs] No valid fileId found for customer ${customerId}`);
                failedCount++;
                continue;
            }

            // d) Check or create UserApplication record
            if (!userApp) {
                userApp = await prisma.userApplication.create({
                    data: {
                        customerId: customerId,
                        fileId: fileId,
                        isProcessed: false,
                    },
                });
            } else if (userApp.fileId !== fileId || userApp.isProcessed) {
                userApp = await prisma.userApplication.update({
                    where: { id: userApp.id },
                    data: {
                        fileId: fileId,
                        isProcessed: false,
                    },
                });
            }

            // e) Get s3_url from qq.contact_files and invoke Lambda
            let lambdaResult;
            try {
                // Get s3_url from DB
                const fileRow = await prisma.$queryRaw`SELECT s3_url FROM qq.contact_files WHERE file_id = ${fileId}`;
                const s3Url = Array.isArray(fileRow) && fileRow.length > 0 ? fileRow[0].s3_url : null;
                if (!s3Url) {
                    throw new Error(`No s3_url found for file_id ${fileId}`);
                }
                lambdaResult = await invokePdfLambda(s3Url, carrierId);
                const mappedResult = mapLambdaResultToPolicyJson(lambdaResult);
                await saveJsonForCustomer(customerId, mappedResult);
                console.log(`[syncFilesFromPolicyLogs] Lambda success for customer ${customerId}:`, mappedResult);

                // await prisma.userApplication.update({
                //     where: { id: userApp.id },
                //     data: { isProcessed: true },
                // });

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

export function startFilesFromPolicyLogsJob(onlyYesterday = true) {
    if (jobStarted) return;

    // Run daily at 05:00 UTC
    cron.schedule('0 5 * * *', () => {
        syncFilesFromPolicyLogs()

            .then(res => console.log('[filesFromPolicyLogsJob] Scheduled run result:', res))
            .catch(err => console.error('[filesFromPolicyLogsJob] Scheduled run failed:', err));
    });

    console.log('[filesFromPolicyLogsJob] starting...');
    // Optionally run once at startup (process previous day immediately)
    // syncFilesFromPolicyLogs({ onlyYesterday })
    //     .then(res => console.log('[filesFromPolicyLogsJob] Initial run result:', res))
    //     .catch(err => console.error('[filesFromPolicyLogsJob] Initial run failed:', err));

    jobStarted = true;
}

export { syncFilesFromPolicyLogs };